import { createHash } from "node:crypto";
import { z } from "zod";
import {
  TRAINING_STANDARD,
  trainingSchema,
  trainingStatement,
  type TrainingConsent,
  type TrainingStatement,
} from "./consent.js";
import type { Fingerprint, Hex } from "./fingerprint.js";
import { AGENT_IDENTITY_REGISTRY, FINGERPRINT_VERSION, phashHex } from "./metadata.js";

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
});

export type SealedMetadata = z.infer<typeof sealedMetadataSchema>;

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
