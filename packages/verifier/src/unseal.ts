import { createHash } from "node:crypto";
import { getAddress, type PublicClient } from "viem";
import type { Response as FetchResponse } from "undici";
import { z } from "zod";
import { registryEditAbi, tokenIdOf } from "./edit/registry.js";
import { env } from "./env.js";
import { decodeFailure, type Fingerprint, type Hex } from "./fingerprint.js";
import { gatewayUrl } from "./ipfs/pinata.js";
import { FINGERPRINT_VERSION, phashHex } from "./metadata.js";
import { safeReason } from "./net/errorText.js";
import { BlockedTarget, UnreachableTarget, safeFetch, type SafeFetchOptions } from "./net/safeFetch.js";
import { THUMBNAIL_MAX_BYTES, ThumbnailTooLarge, makeThumbnail } from "./prepare.js";

/**
 * Where Pinata lists the files this account has pinned publicly.
 *
 * The upload endpoint lives in src/ipfs/pinata.ts and is a different host, which is Pinata's own
 * split: uploads.pinata.cloud takes bytes, api.pinata.cloud answers questions about them.
 */
const FILES_URL = "https://api.pinata.cloud/v3/files/public";

/** How long the two lookups get. Both are small JSON reads, not uploads. */
const LOOKUP_TIMEOUT_MS = 10_000;

/** What the record calls itself, so anyone who opens the file knows what they are holding. */
export const UNSEAL_RECORD_KIND = "moolam-unseal-record";

export const UNSEAL_RECORD_VERSION = 1;

/**
 * How a reader checks this without trusting Moolam, written into the record itself.
 *
 * The record is not signed, and that is the point. A signature would only say Moolam published it;
 * the hash says the bytes are the registered ones, which is the thing anyone actually wants to
 * know, and it is checkable by a stranger with a copy of the file and no knowledge of this service.
 */
export const UNSEAL_RECORD_NOTE =
  "The picture at `image` is the file this passport committed to: its sha-256 is the passport id, which is the registry's own rule. Hash it yourself rather than trusting this record, or Moolam.";

const PASSPORT_ID = /^0x[0-9a-f]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const IPFS_URI = /^ipfs:\/\/.+/;

/**
 * The shape of the document an unseal publishes, strict in both directions like the sealed one.
 *
 * Strict matters less here than it does for a sealed record, because nothing on this path is meant
 * to stay private. It is here so the document a reader finds tomorrow has the keys this service
 * promised today, and so a later convenience cannot quietly put the creator's email in it.
 */
export const unsealRecordSchema = z.strictObject({
  kind: z.literal(UNSEAL_RECORD_KIND),
  version: z.literal(UNSEAL_RECORD_VERSION),
  passportId: z.string().regex(PASSPORT_ID, "passportId must be 0x and 64 lower case hex characters"),
  image: z.string().regex(IPFS_URI, "image must be an ipfs:// address"),
  thumbnail: z.string().regex(IPFS_URI, "thumbnail must be an ipfs:// address"),
  manifest: z.string().regex(IPFS_URI, "manifest must be an ipfs:// address").optional(),
  unsealedBy: z.string().regex(ADDRESS, "unsealedBy must be 0x followed by 40 hex characters"),
  unsealedAt: z.iso.datetime(),
  note: z.literal(UNSEAL_RECORD_NOTE),
});

export type UnsealRecord = z.infer<typeof unsealRecordSchema>;

export interface UnsealRecordInput {
  passportId: Hex;
  image: string;
  thumbnail: string;
  manifest?: string;
  unsealedBy: Hex;
  unsealedAt?: Date;
}

/** This service built a record it will not publish, because the shape above has no room for it. */
export class UnsealRecordRefused extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "UnsealRecordRefused";
  }
}

/**
 * Builds the document that says a sealed passport was opened, and refuses one the schema would not
 * accept.
 *
 * The registry's metadataURI is written once at registration and there is no setter, so the sealed
 * document stays the passport's metadata for ever and the unsealing cannot be recorded on chain.
 * This file is the record instead: it names the three addresses the picture now lives at, and the
 * only thing a reader has to believe is the hash, which they can check themselves.
 *
 * Throws UnsealRecordRefused, whose message names every field that did not fit.
 */
export function unsealRecord(input: UnsealRecordInput): UnsealRecord {
  const parsed = unsealRecordSchema.safeParse({
    kind: UNSEAL_RECORD_KIND,
    version: UNSEAL_RECORD_VERSION,
    passportId: input.passportId,
    image: input.image,
    thumbnail: input.thumbnail,
    manifest: input.manifest,
    unsealedBy: getAddress(input.unsealedBy),
    unsealedAt: (input.unsealedAt ?? new Date()).toISOString(),
    note: UNSEAL_RECORD_NOTE,
  });
  if (!parsed.success) {
    const detail = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
    throw new UnsealRecordRefused(`this unseal record is not one this service may pin: ${detail}`);
  }
  return parsed.data;
}

/**
 * The file name an unseal record is pinned under, which is the whole lookup.
 *
 * A content id cannot be worked out from a passport id, because the record names the picture's own
 * address and nobody holding only the passport id knows that address yet. The name can be, so the
 * name is the handle: one passport id, one file name, and a service that has just been redeployed
 * finds the record again without a database.
 */
export function unsealRecordName(passportId: Hex): string {
  return `unseal-${passportId.toLowerCase()}.json`;
}

/** The sha256 of an upload, in the form the registry uses for a passport id. */
export function sha256Of(bytes: Buffer): Hex {
  return `0x${createHash("sha256").update(bytes).digest("hex")}` as Hex;
}

/** What the chain says about a passport, in the fields an unseal has to agree with. */
export interface OnChainPassport {
  registeredAt: number;
  phash: bigint;
  blockhash256: Hex;
  fingerprintVersion: number;
  metadataURI: string;
  /** The sha256 of the manifest store the registration committed to, or 32 zero bytes for none. */
  manifestHash: Hex;
  /** Who registered it, the address the registry's PassportRegistered event named. */
  creator: Hex;
  /** The passport this one is an edit of, or 32 zero bytes for an original. */
  parentId: Hex;
}

/**
 * Whether the fingerprint recomputed from the upload is the one the registry recorded.
 *
 * The hash check already proves the bytes are the registered ones, so in a working service this
 * can only fail when the fingerprint recipe itself has moved under a passport registered by an
 * older version. That is exactly why it is here: publishing a picture whose recomputed fingerprint
 * no longer matches the chain would hand the Chainlink workflow a passport it will mark mismatched
 * every time it looks.
 */
export function fingerprintMatches(print: Fingerprint, chain: OnChainPassport): boolean {
  return (
    print.phash === chain.phash &&
    print.blockhash.toLowerCase() === chain.blockhash256.toLowerCase() &&
    chain.fingerprintVersion === FINGERPRINT_VERSION
  );
}

/**
 * Three answers, never two. "sealed" and "public" are what the document said; "unreadable" is this
 * service saying it could not tell, which must never be read as "already public": that reading
 * would refuse a creator their own unseal because a gateway was slow.
 */
export type SealedState = "sealed" | "public" | "unreadable";

/** Whether a metadata document is the sealed kind. Anything unparseable is "unreadable". */
export function sealedStateOf(document: unknown): SealedState {
  if (typeof document !== "object" || document === null || Array.isArray(document)) {
    return "unreadable";
  }
  const flag = (document as Record<string, unknown>).sealed;
  if (flag === true) return "sealed";
  if (flag === undefined || flag === false) return "public";
  return "unreadable";
}

export type ThumbnailAttempt =
  | { ok: true; thumbnail: Buffer }
  | { ok: false; limit: number; detail: string };

/**
 * The thumbnail the public path would have made, or the reason there is none.
 *
 * A sealed registration makes no thumbnail, so a picture whose thumbnail cannot be squeezed under
 * the Chainlink fetch budget gets registered sealed even though it would have been refused
 * publicly. Unsealing it without this check would publish a passport the workflow can never
 * re-check, and the passport page would show a picture with a permanent "not re-checked" next to
 * it. Better to refuse the unseal and say why.
 *
 * Only ThumbnailTooLarge is that answer (review pass 7, V64). Any other failure says nothing
 * permanent about the picture, so it is thrown, sorted by fingerprint.ts's decodeFailure: one that
 * ran out of memory ("out of memory" from libvips, "Insufficient memory" from libjpeg) is this
 * host's FingerprintFault, and the caller may retry; anything else is the upload's UndecodableImage.
 *
 * Throws FingerprintFault or UndecodableImage for any failure that is not the size budget.
 */
export async function unsealThumbnail(bytes: Buffer): Promise<ThumbnailAttempt> {
  try {
    return { ok: true, thumbnail: await makeThumbnail(bytes) };
  } catch (error) {
    if (error instanceof ThumbnailTooLarge) {
      return { ok: false, limit: THUMBNAIL_MAX_BYTES, detail: safeReason(error) };
    }
    throw decodeFailure(error);
  }
}

/** The slice of the registry an unseal reads. Hand written, like the edit route's own slice. */
export const registryUnsealAbi = [
  {
    type: "function",
    name: "getPassport",
    stateMutability: "view",
    inputs: [{ name: "id", type: "bytes32" }],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "exactHash", type: "bytes32" },
          { name: "parentId", type: "bytes32" },
          { name: "creator", type: "address" },
          { name: "generatorAgentId", type: "uint256" },
          { name: "phash", type: "uint64" },
          { name: "blockhash256", type: "bytes32" },
          { name: "manifestHash", type: "bytes32" },
          { name: "kind", type: "uint8" },
          { name: "fingerprintVersion", type: "uint8" },
          { name: "registeredAt", type: "uint64" },
          { name: "disputed", type: "bool" },
          { name: "metadataURI", type: "string" },
        ],
      },
    ],
  },
] as const;

type ReadClient = Pick<PublicClient, "readContract">;

/**
 * Who holds the passport right now, read from the chain at the moment of the unseal rather than
 * from any index.
 *
 * This is invariant 5's only source. An index is a copy of the chain a minute ago, and a minute is
 * long enough for a passport to change hands between the read and the pin.
 *
 * Throws for a token id nobody minted, which the caller has already ruled out by reading the
 * passport, and whatever the RPC threw otherwise.
 */
export async function holderOf(client: ReadClient, registry: Hex, passportId: Hex): Promise<Hex> {
  const owner = (await client.readContract({
    address: registry,
    abi: registryEditAbi,
    functionName: "ownerOf",
    args: [tokenIdOf(passportId)],
  })) as Hex;
  return getAddress(owner);
}

/**
 * The passport as the chain holds it, or undefined for an id nobody registered.
 *
 * A passport that does not exist comes back as a zeroed struct rather than a revert, which is what
 * `registeredAt` is read for: it is the field the registry itself uses to tell an unknown passport
 * from a real one.
 *
 * Throws whatever the RPC threw, which the route turns into `chain-unavailable`.
 */
export async function readPassport(
  client: ReadClient,
  registry: Hex,
  passportId: Hex,
): Promise<OnChainPassport | undefined> {
  const record = (await client.readContract({
    address: registry,
    abi: registryUnsealAbi,
    functionName: "getPassport",
    args: [passportId],
  })) as {
    parentId: Hex;
    creator: Hex;
    phash: bigint;
    blockhash256: Hex;
    manifestHash: Hex;
    fingerprintVersion: number;
    registeredAt: bigint;
    metadataURI: string;
  };

  const registeredAt = Number(record.registeredAt);
  if (registeredAt === 0) return undefined;
  return {
    registeredAt,
    phash: record.phash,
    blockhash256: record.blockhash256,
    fingerprintVersion: Number(record.fingerprintVersion),
    metadataURI: record.metadataURI,
    manifestHash: record.manifestHash,
    creator: record.creator,
    parentId: record.parentId,
  };
}

/**
 * The most a metadata document may weigh, counted after decompression. A Moolam document is under
 * 2 KB; this only stops a document registered outside Moolam from making the service hold or parse
 * something large.
 */
export const MAX_METADATA_BYTES = 64 * 1024;

/**
 * The content id in `ipfs://<cid>`, or null for anything else.
 *
 * A byte for byte copy of the workflows' predicate in packages/workflow/moolam-verifier/pinned.ts,
 * held to it by test/metadata-read.test.ts, so this service, the runner and both workflows refuse
 * exactly the same addresses. It is copied rather than imported because that file lives outside
 * this package's build. What it covers and what it does not is written beside the original.
 */
export function pinnedContentId(reference: unknown): string | null {
  if (typeof reference !== "string" || !reference.startsWith("ipfs://")) {
    return null;
  }
  const cid = reference.slice("ipfs://".length);
  return /^[A-Za-z0-9]+$/.test(cid) ? cid : null;
}

/**
 * The passport's metadata document, read through the configured gateway.
 *
 * The address comes off the chain, where a registrant can write anything, so only a bare pinned
 * content id is read, and an http(s) address or anything with a path is refused before a request
 * is made. No redirect is followed, and the body is counted after decompression and abandoned past
 * MAX_METADATA_BYTES before a byte of JSON is parsed. safeFetch still checks the gateway's address.
 *
 * Throws BlockedTarget for an address that is not pinned content, and UnreachableTarget for a
 * redirect, any status but 200, a body over the cap, or a body that is not JSON. The routes read
 * every one of those as "could not tell" rather than as an answer.
 */
export async function readMetadataDocument(uri: string, options: SafeFetchOptions = {}): Promise<unknown> {
  const cid = pinnedContentId(uri);
  if (cid === null) {
    throw new BlockedTarget("this passport's metadata address is not a pinned content id, so it is not read");
  }
  const response = await safeFetch(new URL(gatewayUrl(`ipfs://${cid}`)), {
    timeoutMs: LOOKUP_TIMEOUT_MS,
    ...options,
    maxRedirects: 0,
  });
  if (response.status !== 200) {
    await response.body?.cancel().catch(() => undefined);
    throw new UnreachableTarget(`the gateway answered ${response.status} for this passport's metadata`);
  }
  const text = await cappedText(response, MAX_METADATA_BYTES);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new UnreachableTarget("this passport's metadata is not JSON");
  }
}

/**
 * The body as text, refused past `cap` bytes. A declared length over the cap is refused unread,
 * and otherwise reading stops at the first chunk past the cap. The chunks are the decompressed
 * body, so a few kilobytes that inflate to gigabytes stop here too.
 */
async function cappedText(response: Pick<FetchResponse, "headers" | "body">, cap: number): Promise<string> {
  const refused = (): UnreachableTarget =>
    new UnreachableTarget(`this passport's metadata is over the ${cap} byte cap, so it is not read`);
  const declared = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > cap) {
    await response.body?.cancel().catch(() => undefined);
    throw refused();
  }
  if (response.body === null) {
    return "";
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    length += value.byteLength;
    if (length > cap) {
      await reader.cancel().catch(() => undefined);
      throw refused();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Both failures of a gateway read, named together because the route treats them the same way. */
export function isGatewayFailure(error: unknown): boolean {
  return error instanceof BlockedTarget || error instanceof UnreachableTarget;
}

/**
 * What Pinata's file listing says, read loosely on purpose.
 *
 * Only the three fields this service uses are named. `files` is read the way the private listing
 * parser in src/ipfs/pinata.ts reads it: an array, or null for an empty listing. A listing with no
 * `files` key at all, or any other shape, fails the parse, which the caller reports as "cannot
 * tell", never as "nothing is there" (review pass 4, V20).
 */
const listingSchema = z.object({
  data: z.object({
    files: z
      .array(
        z.object({
          cid: z.string().min(1),
          name: z.string(),
          created_at: z.string().optional(),
        }),
      )
      .nullable(),
  }),
});

export interface PinnedRecord {
  cid: string;
  uri: `ipfs://${string}`;
  /** When Pinata says the file was pinned, which is a third party's clock rather than ours. */
  createdAt?: string;
}

/** How many records this process remembers pinning itself before it forgets the oldest. */
export const PINNED_HERE_MAX = 2_000;

const pinnedHere = new Map<Hex, { record: UnsealRecord; pinned: PinnedRecord }>();

/**
 * Remembers an unseal record this process has just pinned, so every reader in it says unsealed
 * from that moment (review pass 10, V104 and V105).
 *
 * Pinata's listing trails a fresh pin. The verify answer's picture fact, the re-check request and
 * GET /unseal each asked that listing, or held a "sealed" answer from it, and for the length of the
 * lag called a published picture sealed. A record is never taken back, so one remembered here cannot
 * go stale. The memory is one per process, which is one server in production; another server's
 * unseal still reaches this one through the listing. A record that does not fit the published shape
 * is not kept, the rule every record read back is held to.
 */
export function rememberPinnedUnseal(record: UnsealRecord, pinned: PinnedRecord): void {
  const parsed = unsealRecordSchema.safeParse(record);
  if (!parsed.success) {
    return;
  }
  const key = parsed.data.passportId as Hex;
  pinnedHere.delete(key);
  while (pinnedHere.size >= PINNED_HERE_MAX) {
    const oldest = pinnedHere.keys().next();
    if (oldest.done === true) {
      break;
    }
    pinnedHere.delete(oldest.value);
  }
  pinnedHere.set(key, { record: parsed.data, pinned });
}

/** The record this process pinned for a passport, or undefined when it pinned none it still remembers. */
export function pinnedUnsealOf(passportId: Hex): { record: UnsealRecord; pinned: PinnedRecord } | undefined {
  return pinnedHere.get(passportId.toLowerCase() as Hex);
}

/**
 * Either the record this passport was unsealed under, that there is none, or that this service
 * could not find out.
 *
 * The three are kept apart for the same reason the re-check answer keeps them apart: "I cannot
 * tell" printed as "not unsealed" would show a sealed plate over a picture that is already public.
 */
export type RecordLookup =
  | { state: "found"; record: PinnedRecord }
  | { state: "none" }
  | { state: "unavailable"; reason: string };

export interface LookupOptions {
  /** Swapped in tests so the listing can be answered without a network or a token. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Looks an unseal record up by the one thing a reader has: the passport id.
 *
 * The name is the handle. Pinata is asked for files under `unseal-<passportId>.json`, and the
 * oldest match wins, because the first unsealing is the one that happened; a second file under
 * that name can only come from a retry that could not see the first.
 *
 * Nothing here throws. A Pinata that will not answer, a token this host does not have, or a body
 * shaped differently from the one above all come back as "unavailable" with the reason for the log.
 */
export async function findUnsealRecord(passportId: Hex, options: LookupOptions = {}): Promise<RecordLookup> {
  const token = env.PINATA_JWT;
  if (token === undefined) {
    return { state: "unavailable", reason: "this host has no Pinata token to ask with" };
  }

  const name = unsealRecordName(passportId);
  const url = `${FILES_URL}?name=${encodeURIComponent(name)}&limit=10`;
  const call = options.fetchImpl ?? fetch;

  let body: unknown;
  try {
    const response = await call(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(options.timeoutMs ?? LOOKUP_TIMEOUT_MS),
    });
    if (!response.ok) {
      // The status alone, never the body: a Pinata error page can echo the request, and the
      // request carries the token.
      return { state: "unavailable", reason: `Pinata answered ${response.status} to the record lookup` };
    }
    body = await response.json();
  } catch (error) {
    return { state: "unavailable", reason: safeReason(error) };
  }

  const parsed = listingSchema.safeParse(body);
  if (!parsed.success) {
    return { state: "unavailable", reason: "Pinata listed files in a shape this client does not know" };
  }

  // Pinata's name filter is theirs to define, so the exact name is insisted on here rather than
  // trusted: a filter that matched on a prefix would otherwise hand back another passport's record.
  const mine = (parsed.data.data.files ?? []).filter((file) => file.name === name);
  if (mine.length === 0) {
    return { state: "none" };
  }

  const oldest = mine.reduce((first, file) =>
    (file.created_at ?? "") < (first.created_at ?? "") ? file : first,
  );
  return {
    state: "found",
    record: { cid: oldest.cid, uri: `ipfs://${oldest.cid}`, createdAt: oldest.created_at },
  };
}

/**
 * Reads a pinned unseal record back, checked against the same schema that wrote it and against the
 * passport it is supposed to be about.
 *
 * A file pinned under this name that does not fit the shape is not treated as a record, and
 * neither is one that names another passport. The name is a label somebody chose; the passport id
 * inside the document is the claim, and the two have to agree before a reader is shown a picture
 * under this passport's name.
 *
 * Throws on a gateway that will not answer, on a document the schema refuses, and on one that is
 * about a different passport.
 */
export async function readUnsealRecord(
  uri: string,
  passportId: Hex,
  options: SafeFetchOptions = {},
): Promise<UnsealRecord> {
  const document = await readMetadataDocument(uri, options);
  const parsed = unsealRecordSchema.safeParse(document);
  if (!parsed.success) {
    throw new UnsealRecordRefused("the file pinned under this passport's unseal name is not an unseal record");
  }
  if (parsed.data.passportId !== passportId.toLowerCase()) {
    throw new UnsealRecordRefused("the record pinned under this passport's unseal name is about another passport");
  }
  return parsed.data;
}

/** Reads a passport's metadata document. Swapped in tests so no request leaves the process. */
export type DocumentReader = (uri: string) => Promise<unknown>;

/**
 * Finds the record a passport was unsealed under: the record, undefined when there is none, and a
 * throw when this service could not find out.
 */
export type UnsealRecordFinder = (passportId: Hex) => Promise<UnsealRecord | undefined>;

/**
 * Four answers about a passport's picture. "unsealed" is a sealed document plus a record that says
 * its holder published the picture later, which is the only way a sealed passport ever changes:
 * the document itself is written once and says sealed for ever.
 */
export type PictureState = "public" | "sealed" | "unsealed" | "unreadable";

export type PictureReading =
  | { state: "public" | "sealed" | "unreadable" }
  | { state: "unsealed"; at: string };

const UNREADABLE: PictureReading = { state: "unreadable" };

/**
 * Whether a passport's picture is public, sealed, or sealed and then published by its holder.
 *
 * The record lookup runs only for a document that says sealed, so a public passport costs one
 * document read and no Pinata request. A record is believed only when it fits the published shape
 * and names this passport, whoever handed it over: the finder is injectable, and the time it
 * carries goes out to strangers in a verify answer.
 *
 * Never throws. A document that cannot be read, a record lookup that fails, and a record that is
 * malformed or about another passport all answer "unreadable", never "sealed" or "public": either
 * guess would print something about the picture that this service does not know.
 */
export async function pictureStateOf(
  passport: { id: Hex; metadataURI: string },
  readDocument: DocumentReader,
  findRecord: UnsealRecordFinder,
): Promise<PictureReading> {
  let document: unknown;
  try {
    document = await readDocument(passport.metadataURI);
  } catch {
    return UNREADABLE;
  }

  const flag = sealedStateOf(document);
  if (flag !== "sealed") {
    return { state: flag };
  }

  let found: UnsealRecord | undefined;
  try {
    found = await findRecord(passport.id);
  } catch {
    return UNREADABLE;
  }
  if (found === undefined) {
    return { state: "sealed" };
  }

  const parsed = unsealRecordSchema.safeParse(found);
  if (!parsed.success || parsed.data.passportId !== passport.id.toLowerCase()) {
    return UNREADABLE;
  }
  return { state: "unsealed", at: parsed.data.unsealedAt };
}

/**
 * The live record finder: the name lookup on Pinata, then the record itself read back and checked.
 *
 * Throws when the lookup cannot answer, and whatever readUnsealRecord throws for a record that
 * cannot be read or is not about this passport. pictureStateOf reads every one of those as
 * "unreadable".
 */
export async function unsealRecordFor(
  passportId: Hex,
  options: { lookup?: LookupOptions; read?: SafeFetchOptions } = {},
): Promise<UnsealRecord | undefined> {
  const found = await findUnsealRecord(passportId, options.lookup);
  if (found.state === "none") {
    return undefined;
  }
  if (found.state === "unavailable") {
    throw new UnreachableTarget(`the unseal record lookup could not answer: ${found.reason}`);
  }
  return await readUnsealRecord(found.record.uri, passportId, options.read);
}

/**
 * The picture fact a verify answer carries. "unavailable" is the same word the consent, dispute and
 * re-check facts use when their own read could not answer, and it covers "unreadable" too: both
 * mean this service could not find out, which must never be printed as sealed or as public. Every
 * answer that was read carries `readAt`, the unix seconds of that read (review pass 6, V46).
 */
export type PictureAnswer =
  | { state: "public"; readAt: number }
  | { state: "sealed"; readAt: number }
  | { state: "unsealed"; at: string; readAt: number }
  | { source: "unavailable" };

export interface PictureReader {
  /** Never rejects. A passport the index does not hold, a failed read and a slow one are "unavailable". */
  answerFor: (passport: { id: Hex; metadataURI: string } | undefined) => Promise<PictureAnswer>;
}

/**
 * How long a "sealed" answer is held: a holder can publish the picture at any moment, and a sealed
 * plate over a picture already out is the one answer server.ts promises never to serve, so ten
 * seconds at most (review pass 6, V46).
 */
export const PICTURE_SEALED_TTL_MS = 10_000;

/** How many passports are remembered at once, on the same reasoning as the consent and dispute memories. */
export const PICTURE_CACHE_MAX = 2_000;

/** How long one read may take, the same five seconds the consent and dispute reads get. */
export const PICTURE_READ_TIMEOUT_MS = 5_000;

const PICTURE_UNAVAILABLE: PictureAnswer = { source: "unavailable" };

/**
 * Reads a passport's picture state for the verify answers, with a memory in front of it.
 *
 * "public" and "unsealed" are kept for as long as there is room, because neither can change: the
 * document is written once and an unseal record is never taken back. "sealed" is kept for ten
 * seconds, because that is the one answer the holder can change, and a failed or slow read is never
 * kept. A passport this process unsealed itself answers "unsealed" from rememberPinnedUnseal before
 * any of that. Each answer says when it was read.
 *
 * Tests pass their own readDocument and findRecord; nothing here touches the network on its own.
 */
export function pictureReader(options: {
  readDocument: DocumentReader;
  findRecord: UnsealRecordFinder;
  sealedTtlMs?: number;
  maxEntries?: number;
  timeoutMs?: number;
}): PictureReader {
  const sealedTtlMs = options.sealedTtlMs ?? PICTURE_SEALED_TTL_MS;
  const maxEntries = options.maxEntries ?? PICTURE_CACHE_MAX;
  const timeoutMs = options.timeoutMs ?? PICTURE_READ_TIMEOUT_MS;
  const cache = new Map<Hex, { answer: PictureAnswer; expiresAt: number }>();

  const remember = (key: Hex, answer: PictureAnswer, ttl: number): void => {
    // Deleting first keeps the map in write order, which is what makes the first key the oldest.
    cache.delete(key);
    while (cache.size >= maxEntries) {
      const oldest = cache.keys().next();
      if (oldest.done === true) {
        break;
      }
      cache.delete(oldest.value);
    }
    cache.set(key, { answer, expiresAt: Date.now() + ttl });
  };

  return {
    answerFor: async (passport) => {
      if (passport === undefined || !PASSPORT_ID.test(passport.id.toLowerCase())) {
        return PICTURE_UNAVAILABLE;
      }
      const key = passport.id.toLowerCase() as Hex;

      // Before the memory below, which can still hold "sealed" from a read made just before the
      // unseal, and before a listing that may not show the record yet (V104).
      const here = pinnedUnsealOf(key);
      if (here !== undefined) {
        const answer: PictureAnswer = { state: "unsealed", at: here.record.unsealedAt, readAt: Math.floor(Date.now() / 1000) };
        remember(key, answer, Number.POSITIVE_INFINITY);
        return answer;
      }

      const held = cache.get(key);
      if (held !== undefined) {
        if (held.expiresAt > Date.now()) {
          return held.answer;
        }
        cache.delete(key);
      }

      const readAt = Math.floor(Date.now() / 1000);
      let reading: PictureReading;
      try {
        reading = await withPictureTimeout(
          pictureStateOf({ id: key, metadataURI: passport.metadataURI }, options.readDocument, options.findRecord),
          timeoutMs,
        );
      } catch {
        return PICTURE_UNAVAILABLE;
      }

      if (reading.state === "unreadable") {
        return PICTURE_UNAVAILABLE;
      }
      const answer: PictureAnswer =
        reading.state === "unsealed"
          ? { state: "unsealed", at: reading.at, readAt }
          : { state: reading.state, readAt };
      remember(key, answer, reading.state === "sealed" ? sealedTtlMs : Number.POSITIVE_INFINITY);
      return answer;
    },
  };
}

/** A reader that answers "unavailable" for everything without opening a connection. */
export function offlinePictureReader(): PictureReader {
  return { answerFor: async () => PICTURE_UNAVAILABLE };
}

function withPictureTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const limit = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`the picture read took longer than ${ms} ms`)), ms);
  });
  return Promise.race([work, limit]).finally(() => {
    clearTimeout(timer);
  });
}

/** The three ways an address is printed in an answer, the same shape the other routes use. */
export function pinnedOut(uri: string, cid: string): { cid: string; uri: string; gatewayUrl: string } {
  return { cid, uri, gatewayUrl: gatewayUrl(uri) };
}

/** The 64 bit perceptual hash as an answer prints it, so a caller never sees a lossy double. */
export function printOut(print: Fingerprint): { phash: string; blockhash: Hex; version: number } {
  return { phash: phashHex(print.phash), blockhash: print.blockhash, version: FINGERPRINT_VERSION };
}
