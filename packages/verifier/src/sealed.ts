import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { FastifyBaseLogger } from "fastify";
import { z } from "zod";
import {
  TRAINING_STANDARD,
  trainingSchema,
  trainingStatement,
  type TrainingConsent,
  type TrainingStatement,
} from "./consent.js";
import { passportExists } from "./edit/registry.js";
import { env } from "./env.js";
import type { Fingerprint, Hex } from "./fingerprint.js";
import { PinRefused, PrivateCopyNotPrivate, deletePrivateFile, pinPrivateFile, type PrivateFile } from "./ipfs/pinata.js";
import { AGENT_IDENTITY_REGISTRY, FINGERPRINT_VERSION, phashHex } from "./metadata.js";
import { safeReason } from "./net/errorText.js";
import { PRIVATE_RECHECK_THUMBNAIL_TOO_LARGE_REASON, THUMBNAIL_MAX_BYTES } from "./prepare.js";
import { STATE_FILES, stateFile } from "./stateDir.js";

/**
 * How the sealed document names the hash the chain commits to.
 *
 * The passport id is the sha256 of the signed file, which is the registry's own rule rather than
 * anything a reader of this document would know. Writing the algorithm down means anyone holding
 * the file can check the commitment without having read Moolam's code.
 */
export const COMMITMENT_ALGORITHM = "sha-256";

/** Everything the prepare pipeline produces is a baseline JPEG, and the sealed file is that file. */
export const SEALED_FILE_TYPE = "image/jpeg";

const PASSPORT_ID = /^0x[0-9a-f]{64}$/;
const PHASH_HEX = /^0x[0-9a-f]{16}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const WHOLE_NUMBER = /^[0-9]+$/;

/**
 * A training statement as this service writes it, checked by re-running it through the boundary
 * schema in consent.ts.
 *
 * The four words and their rules are not repeated here on purpose: consent.ts owns the CAWG
 * vocabulary, and a second copy of it in this file is a second thing to keep right. Anything
 * consent.ts would not write is refused here too, including an unknown key inside the statement.
 */
const trainingStatementSchema = z.custom<TrainingStatement>(
  (value) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return false;
    }
    const { standard, ...stated } = value as Record<string, unknown>;
    const parsed = trainingSchema.safeParse(stated);
    return standard === TRAINING_STANDARD && parsed.success && parsed.data !== undefined;
  },
  { message: "training must be the statement consent.ts writes, and nothing else" },
);

/**
 * The only document a sealed registration may pin.
 *
 * It is strict in both directions, and that is the whole point of the file. Strict means an
 * `image`, `thumbnail` or `manifest` key cannot be added by a later convenience without this
 * schema refusing the pin, and `prompt` is here but is only ever filled when the creator asked
 * for it. What a sealed passport publishes is this list and nothing else, which is what the
 * studio shows the creator before they sign.
 */
export const sealedMetadataSchema = z.strictObject({
  name: z.string().trim().min(1).max(120),
  description: z.string().min(1),
  sealed: z.literal(true),
  commitment: z.strictObject({
    algorithm: z.literal(COMMITMENT_ALGORITHM),
    value: z
      .string()
      .regex(PASSPORT_ID, "commitment.value must be the passport id: 0x and 64 lower case hex characters"),
  }),
  fingerprint: z.strictObject({
    phash: z.string().regex(PHASH_HEX, "fingerprint.phash must be 0x and 16 lower case hex characters"),
    blockhash: z.string().regex(PASSPORT_ID, "fingerprint.blockhash must be 0x and 64 lower case hex characters"),
    version: z.literal(FINGERPRINT_VERSION),
  }),
  generator: z
    .strictObject({
      agentId: z.string().regex(WHOLE_NUMBER, "generator.agentId must be a whole number"),
      registry: z.string().regex(ADDRESS, "generator.registry must be 0x followed by 40 hex characters"),
    })
    .optional(),
  training: trainingStatementSchema.optional(),
  createdAt: z.iso.datetime(),
  model: z.string().trim().min(1).optional(),
  prompt: z.string().trim().min(1).optional(),
  /**
   * The creator asked for a private Chainlink re-check, so a thumbnail is kept on Pinata's private
   * network. Only the flag is public: the private file's id, content id and name never appear
   * here, and only `true` is accepted, never the string or `false`.
   */
  privateRecheck: z.literal(true).optional(),
});

export type SealedMetadata = z.infer<typeof sealedMetadataSchema>;

/**
 * Whether a metadata document asks for a private re-check and leaves nothing public to re-check.
 *
 * This is the one predicate the verify service, the queue, the runner and the sealed workflow all
 * mean by "privately re-checkable", and test/fixtures/sealed-documents.json is the shared set of
 * cases every copy of it is run against. It reads any value, including a document someone
 * registered outside Moolam, and says yes only when `sealed` and `privateRecheck` are the boolean
 * `true` and the document has neither an `image` nor a `thumbnail` key, whatever their values.
 *
 * It does not say a private copy exists: the document never changes and the file can be deleted.
 * Whether the copy is still kept is a separate question for Pinata.
 */
export function privatelyRecheckable(document: unknown): boolean {
  if (typeof document !== "object" || document === null || Array.isArray(document)) {
    return false;
  }
  const fields = document as Record<string, unknown>;
  return (
    fields.sealed === true &&
    fields.privateRecheck === true &&
    !Object.hasOwn(fields, "image") &&
    !Object.hasOwn(fields, "thumbnail")
  );
}

/**
 * This service built a document it will not publish, because the shape above has no room for
 * something in it. It is not the storage provider failing, and it is not the caller's mistake:
 * it is this service refusing to make a picture public by accident.
 */
export class SealedMetadataRefused extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SealedMetadataRefused";
  }
}

/**
 * What a caller is told when that happens.
 *
 * It says what was and was not done rather than what went wrong, because what went wrong is a
 * fault in this service and its detail belongs in the log. Nothing was pinned and nothing was
 * registered, so trying again costs the creator nothing but the upload.
 */
export const SEALED_METADATA_REFUSED = {
  error: "sealed-metadata-refused",
  reason:
    "this service refused to publish a sealed record that did not fit the shape it checks against, so nothing was pinned and nothing was registered. Please try again.",
} as const;

export interface SealedMetadataInput {
  title: string;
  description: string;
  /** The sha256 of the signed file, which is both the passport id and the commitment. */
  passportId: Hex;
  fingerprint: Fingerprint;
  /** The generator agent, when a generator drew the picture. Zero means nothing drew it. */
  agentId?: bigint;
  identityRegistry?: Hex;
  training?: TrainingConsent;
  /** Which model drew it, for a generated picture. */
  model?: string;
  /** The prompt, and only ever when the creator asked for it to be published. */
  prompt?: string;
  /** True when the creator asked for a private re-check and a private thumbnail was kept. */
  privateRecheck?: boolean;
  createdAt?: Date;
}

/**
 * Builds the document a sealed passport's metadataURI points at, and refuses to hand back one the
 * schema would not accept.
 *
 * The object that comes out is the schema's own output rather than the input, so a key nobody
 * described cannot survive the trip even if a caller passes one. That is the same belt as
 * consent.ts wears: what this service writes is checked exactly as hard as what it accepts,
 * because a sealed passport's metadata is the one thing about the picture that becomes public.
 *
 * Throws SealedMetadataRefused when the document would carry anything the schema has no room
 * for, which stops the registration rather than pinning it.
 */
export function sealedMetadata(input: SealedMetadataInput): SealedMetadata {
  return checkedSealedMetadata({
    name: input.title,
    description: input.description,
    sealed: true,
    commitment: { algorithm: COMMITMENT_ALGORITHM, value: input.passportId },
    fingerprint: {
      phash: phashHex(input.fingerprint.phash),
      blockhash: input.fingerprint.blockhash,
      version: FINGERPRINT_VERSION,
    },
    generator:
      input.agentId === undefined || input.agentId === 0n
        ? undefined
        : { agentId: input.agentId.toString(), registry: input.identityRegistry ?? AGENT_IDENTITY_REGISTRY },
    training: trainingStatement(input.training),
    createdAt: (input.createdAt ?? new Date()).toISOString(),
    model: input.model,
    prompt: input.prompt,
    privateRecheck: input.privateRecheck === true ? true : undefined,
  });
}

/**
 * Checks a document against the sealed shape on the way out and hands back the schema's own
 * output, which is where the guarantee actually lives: the pin gets this value, so a key nobody
 * described never reaches IPFS even if something upstream built one.
 *
 * It is exported so a test can push a document the builder would never build through exactly the
 * check the builder uses.
 *
 * Throws SealedMetadataRefused, whose message names every field that did not fit.
 */
export function checkedSealedMetadata(value: unknown): SealedMetadata {
  const parsed = sealedMetadataSchema.safeParse(value);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
    throw new SealedMetadataRefused(`this sealed record is not one this service may pin: ${detail}`);
  }
  return parsed.data;
}

/** The signed file as the answer carries it back to the browser that uploaded it. */
export interface SignedFile {
  name: string;
  type: string;
  /** The whole file, base64. It is in the answer because this service keeps no copy of it. */
  bytes: string;
  sha256: Hex;
}

/**
 * Packs the signed file for the one journey it makes: this service's memory to the creator's
 * browser, and nowhere else.
 *
 * The hash is recomputed from the bytes being sent rather than copied from the pipeline, and the
 * function refuses when it does not match the passport id. Those two values disagreeing would
 * mean the creator is holding a file that can never unseal the passport they are about to sign,
 * and nothing later in the flow could tell them.
 *
 * Throws when the bytes are empty or hash to anything other than the passport id. Neither message
 * carries a byte of the picture.
 */
export function signedFile(bytes: Buffer, name: string, passportId: Hex): SignedFile {
  if (bytes.length === 0) {
    throw new Error("there is no sealed file to hand back");
  }
  const sha256 = `0x${createHash("sha256").update(bytes).digest("hex")}` as Hex;
  if (sha256 !== passportId) {
    throw new Error("the sealed file does not hash to the passport id, so it could never unseal it");
  }
  return { name, type: SEALED_FILE_TYPE, bytes: bytes.toString("base64"), sha256 };
}

/** privateRecheck was asked for on a registration that is not sealed. Nothing is pinned. */
export const PRIVATE_RECHECK_NEEDS_SEALED = { error: "private-recheck-needs-sealed" } as const;

/** Pinata did not keep the private copy private under its name, so nothing was registered (B16). */
export const PRIVATE_COPY_NOT_PRIVATE = { error: "private-copy-not-private" } as const;

/** The duplicate check could not reach the chain, so no private copy was made (B2). */
export const CHAIN_UNREACHABLE = { error: "chain-unreachable" } as const;

/**
 * The only name a private thumbnail is ever kept under: the passport id, lower-cased once here,
 * so every later lookup, link and deletion compares against the same string.
 *
 * Throws when the id is not 0x and 64 hex characters.
 */
export function privateThumbnailName(passportId: Hex): string {
  const id = passportId.toLowerCase();
  if (!PASSPORT_ID.test(id)) {
    throw new Error("a private thumbnail is named after a passport id: 0x and 64 hex characters");
  }
  return `sealed-thumb-${id}.jpg`;
}

/**
 * What a passport's metadata document says about a private re-check of that passport (B1).
 *
 * "asked" needs both halves: the one predicate above, and a `commitment.value` that is exactly the
 * passport id the caller gave, lower-cased. The comparison is plain string equality with no second
 * normalising step, so a document whose commitment is written in capitals, or names any other
 * passport, is "other-passport" and never chooses a file. The id itself comes from the caller and
 * the chain, never from the document: this only decides whether the document agrees with it.
 */
export type PrivateRecheckAsk = "asked" | "not-asked" | "other-passport";

export function privateRecheckFor(document: unknown, passportId: Hex): PrivateRecheckAsk {
  if (!privatelyRecheckable(document)) {
    return "not-asked";
  }
  const commitment = (document as Record<string, unknown>).commitment;
  if (typeof commitment !== "object" || commitment === null || Array.isArray(commitment)) {
    return "other-passport";
  }
  return (commitment as Record<string, unknown>).value === passportId.toLowerCase() ? "asked" : "other-passport";
}

/** What the chain said about a passport id before anything private is made for it. */
export type Registration = "registered" | "free" | "unreachable";

/**
 * Asks the registry whether it already holds this passport, and keeps "could not ask" apart from
 * "no". A public or plain sealed prepare may go on after "unreachable", because the registry makes
 * the same check when the browser sends the passport. A private copy may not (B2): it would be a
 * thumbnail kept under a name that could already belong to someone else's registered passport.
 */
export async function registrationOf(
  chain: Parameters<typeof passportExists>[0],
  registry: Hex,
  passportId: Hex,
  log: FastifyBaseLogger,
): Promise<Registration> {
  try {
    return (await passportExists(chain, registry, passportId)) ? "registered" : "free";
  } catch (error) {
    log.warn(
      { passportId, reason: safeReason(error) },
      "prepare: the duplicate check could not reach the chain",
    );
    return "unreachable";
  }
}

/**
 * The private copy step, or the refusal a route answers with instead. `landed` says whether
 * Pinata may now hold a file because of this request, which decides whether the day's slot stays
 * spent.
 */
export type PrivateCopy =
  | { kept: PrivateFile }
  | { refused: { status: 409 | 422 | 502; body: { error: string; [field: string]: unknown } }; landed: boolean };

/** What the comment in a private copy says, followed by the passport id. */
export const PRIVATE_COPY_COMMENT = "moolam-private-copy";

/** How many bytes markedPrivateCopy adds: the comment marker, its length and the text. */
export const PRIVATE_COPY_MARK_BYTES = 4 + `${PRIVATE_COPY_COMMENT} 0x${"0".repeat(64)}`.length;

/**
 * The budget a private thumbnail is made to, so the marked copy still fits THUMBNAIL_MAX_BYTES. A
 * thumbnail that fitted only before its comment now takes the next quality step down instead of
 * being refused (review pass 5, intake 5).
 */
export const PRIVATE_THUMBNAIL_MAX_BYTES = THUMBNAIL_MAX_BYTES - PRIVATE_COPY_MARK_BYTES;

/**
 * The private thumbnail with a JPEG comment naming its passport, so its bytes, and so its content
 * id, belong to that passport alone (V12).
 *
 * Signing only adds APP11 segments, so two signings of one picture give the same thumbnail bytes
 * under two passport ids. Pinata de-duplicates by content id, so without this the second upload is
 * answered with the first file under the first name, and the same picture could never be privately
 * re-checked twice. A comment changes no pixel: the workflow's jpeg-js and sharp both skip it, so
 * the fingerprint B14 promises is the same. It sits after the JFIF header when there is one.
 *
 * Throws when the bytes are not a JPEG or the id is not a passport id.
 */
export function markedPrivateCopy(thumbnail: Buffer, passportId: Hex): Buffer {
  if (thumbnail.length < 4 || thumbnail[0] !== 0xff || thumbnail[1] !== 0xd8) {
    throw new Error("a private copy is a JPEG, and these bytes do not start like one");
  }
  const id = passportId.toLowerCase();
  if (!PASSPORT_ID.test(id)) {
    throw new Error("a private copy is marked with a passport id: 0x and 64 hex characters");
  }
  const text = Buffer.from(`${PRIVATE_COPY_COMMENT} ${id}`, "latin1");
  const segment = Buffer.concat([Buffer.from([0xff, 0xfe, (text.length + 2) >> 8, (text.length + 2) & 0xff]), text]);

  let at = 2;
  if (thumbnail[2] === 0xff && thumbnail[3] === 0xe0 && thumbnail.length >= 6) {
    at = 4 + thumbnail.readUInt16BE(4);
  }
  return Buffer.concat([thumbnail.subarray(0, at), segment, thumbnail.subarray(at)]);
}

/**
 * Keeps one thumbnail on Pinata's private network for a sealed passport whose creator asked for a
 * private re-check.
 *
 * The caller has already made the thumbnail with makeThumbnail from the signed bytes, to
 * PRIVATE_THUMBNAIL_MAX_BYTES, checked those bytes hash to the passport id, and heard "free" from
 * the chain. The file is named after the passport id and carries it as the `passportId` key-value,
 * and its bytes carry the id too, in a JPEG comment (markedPrivateCopy), so no other passport's
 * copy can share its content id. It is kept only if Pinata says it is private under that exact
 * name (B16). Anything else answers 409 private-copy-not-private and logs the file id Pinata gave
 * back, and nothing is deleted, because that id can be a public pin the account already held. A marked copy over THUMBNAIL_MAX_BYTES
 * answers 422 thumbnail-too-large before any upload, which a thumbnail made to the smaller budget
 * never meets, and an upload that failed answers 502 pin-failed.
 *
 * Every copy kept, a file Pinata already held included, is noted with the time in the keep-time
 * store, so the sweep ages it by this keep rather than by Pinata's first upload (review pass 10,
 * V108). A store that cannot be written is logged and the time is still held in memory.
 *
 * `landed` on a refusal says whether Pinata may hold a file because of this request. It is false
 * only when nothing was sent, or when Pinata answered and refused (a 4xx). An abort, a 5xx, an
 * answer that would not parse or a connection that dropped can each come after Pinata stored the
 * file, so they count as landed and the day's slot stays spent (review pass 5, sealed 3).
 */
export async function keepPrivateCopy(
  thumbnail: Buffer,
  passportId: Hex,
  log: FastifyBaseLogger,
): Promise<PrivateCopy> {
  const id = passportId.toLowerCase();
  const marked = markedPrivateCopy(thumbnail, passportId);
  if (marked.length > THUMBNAIL_MAX_BYTES) {
    log.warn({ passportId: id, bytes: marked.length }, "rejected: the private copy is over the fetch budget");
    return {
      refused: {
        status: 422,
        body: { error: "thumbnail-too-large", limit: THUMBNAIL_MAX_BYTES, reason: PRIVATE_RECHECK_THUMBNAIL_TOO_LARGE_REASON },
      },
      landed: false,
    };
  }
  try {
    const kept = await pinPrivateFile(marked, privateThumbnailName(passportId), { passportId: id });
    log.info({ passportId: id, fileId: kept.id }, "prepare: private copy kept");
    try {
      keepTimes().note(id as Hex, Date.now());
    } catch (error) {
      log.warn({ passportId: id, reason: safeReason(error) }, "prepare: the time this copy was kept could not be saved, it is held in memory");
    }
    return { kept };
  } catch (error) {
    const reason = safeReason(error);
    if (error instanceof PrivateCopyNotPrivate) {
      log.error({ passportId: id, fileId: error.fileId, reason }, "rejected: the private copy is not private");
      return { refused: { status: 409, body: PRIVATE_COPY_NOT_PRIVATE }, landed: true };
    }
    const landed = !refusedByPinata(error);
    log.error({ passportId: id, reason, landed }, "rejected: the private copy was not kept");
    return { refused: { status: 502, body: { error: "pin-failed" } }, landed };
  }
}

/**
 * Whether a failed pin, private or public, left Pinata unable to hold the file: it answered with a
 * 4xx, or the request never left this process. Both pin functions say so by throwing PinRefused,
 * and only that class. Every other failure, including one this rule does not know, reads as "may
 * have landed", which keeps the day's slot spent. /prepare and /edit ask the same question of
 * their public pins (review pass 6, intake 4).
 */
export function refusedByPinata(error: unknown): boolean {
  return error instanceof PinRefused;
}

/**
 * Deletes a private copy the registration it was made for will never use, after the document pin
 * failed. Best effort: a failure is logged with the file id for an operator and never changes the
 * answer the caller is about to get. Only /generate calls it, whose drawings never repeat bytes;
 * /prepare leaves the copy to the sweep instead (review pass 10, V96).
 *
 * A file Pinata already held when this request uploaded it is never deleted. Two prepares of one
 * picture the signer refused give the same passport id and so the same marked thumbnail, and
 * Pinata answers the second with the first one's file; deleting it for the second request's failed
 * pin left the first request's passport with no private copy (review pass 7, V67). The file is left
 * in place, and the sweep can remove it later if no registered passport asks for it.
 */
export async function dropPrivateCopy(file: PrivateFile, log: FastifyBaseLogger): Promise<void> {
  if (file.heldBefore) {
    log.warn(
      { fileId: file.id, name: file.name },
      "prepare: private copy left in place after the document pin failed, Pinata held it before this request",
    );
    return;
  }
  try {
    await deletePrivateFile(file.id);
    log.warn({ fileId: file.id, name: file.name }, "prepare: private copy deleted after the document pin failed");
  } catch (error) {
    log.error(
      { fileId: file.id, name: file.name, reason: safeReason(error) },
      "prepare: could not delete the private copy after the document pin failed",
    );
  }
}

/**
 * When this service last kept a private copy for each passport (review pass 10, V108).
 *
 * A second prepare of the same bytes is handed Pinata's existing file, and that file keeps the first
 * upload's created_at, so by Pinata's clock a copy a creator is relying on right now can read as a
 * 48 hour orphan. The sweep ages a copy by the later of the two times instead. Only a keep younger
 * than KEPT_RETAIN_MS can change the sweep's answer, so older ones are dropped on the next write.
 */
export interface KeepTimes {
  /** Records a keep. Throws when the store cannot be written; the time is held in memory all the same. */
  note: (passportId: Hex, at: number) => void;
  /** The latest keep remembered for this passport, in milliseconds, or undefined. */
  latest: (passportId: Hex) => number | undefined;
}

/** Past the sweep's 48 hours with a day to spare: a keep older than this cannot make a copy young. */
export const KEPT_RETAIN_MS = 72 * 60 * 60 * 1000;

/** The most keeps remembered at once. The oldest go first, and a day's prepares are far fewer. */
export const KEPT_MAX_ENTRIES = 10_000;

const KEPT_FILE_VERSION = 1;

const keptFileSchema = z.object({
  version: z.literal(KEPT_FILE_VERSION),
  kept: z.record(z.string().regex(PASSPORT_ID), z.number().int().nonnegative()),
});

/** Keep times that live only as long as the process, for tests and for a host with nowhere to write. */
export function memoryKeepTimes(now: () => number = () => Date.now()): KeepTimes {
  return keepTimesOver(new Map(), now, () => undefined);
}

/**
 * Keep times in a small JSON file, written to a temp name and renamed into place the way the
 * sweep's cursor is. On a mounted volume that means a deploy between a re-keep and the next sweep
 * does not forget it. A file that is missing, unreadable or of another shape reads as no keeps,
 * which leaves the sweep with Pinata's own time, the rule it had before.
 */
export function fileKeepTimes(filePath: string, now: () => number = () => Date.now()): KeepTimes {
  const temp = `${filePath}.tmp`;
  let saved = new Map<string, number>();
  try {
    const parsed = keptFileSchema.safeParse(JSON.parse(readFileSync(filePath, "utf8")));
    if (parsed.success) {
      saved = new Map(Object.entries(parsed.data.kept));
    }
  } catch {
    saved = new Map();
  }
  return keepTimesOver(saved, now, (kept) => {
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(temp, `${JSON.stringify({ version: KEPT_FILE_VERSION, kept: Object.fromEntries(kept) })}\n`, "utf8");
    renameSync(temp, filePath);
  });
}

function keepTimesOver(
  kept: Map<string, number>,
  now: () => number,
  save: (kept: ReadonlyMap<string, number>) => void,
): KeepTimes {
  return {
    note: (passportId, at) => {
      const id = passportId.toLowerCase();
      const cutoff = now() - KEPT_RETAIN_MS;
      // Bounded by KEPT_MAX_ENTRIES.
      for (const [key, time] of kept) {
        if (time <= cutoff) kept.delete(key);
      }
      const before = kept.get(id);
      kept.delete(id);
      while (kept.size >= KEPT_MAX_ENTRIES) {
        const oldest = kept.keys().next();
        if (oldest.done === true) break;
        kept.delete(oldest.value);
      }
      kept.set(id, Math.max(at, before ?? at));
      save(kept);
    },
    latest: (passportId) => kept.get(passportId.toLowerCase()),
  };
}

let shared: KeepTimes | undefined;

/**
 * The live keep times, in private-copy-kept.json in the data folder (DATA_DIR, or the Railway
 * volume). They survive a deploy only when that folder is a mounted volume; on the image's own disk
 * a deploy starts them empty and the boot says so. Under a test runner, and on a development host
 * whose folder cannot be written, they are held in memory only.
 */
function keepTimes(): KeepTimes {
  if (shared === undefined) {
    const file = stateFile(STATE_FILES.keepTimes);
    shared = file === undefined ? memoryKeepTimes() : fileKeepTimes(file);
  }
  return shared;
}

/** When this process last kept a private copy for the passport, as the sweep reads it. */
export function privateCopyKeptAt(passportId: Hex): number | undefined {
  return keepTimes().latest(passportId);
}
