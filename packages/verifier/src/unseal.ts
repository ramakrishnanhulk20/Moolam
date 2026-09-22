import { createHash } from "node:crypto";
import { getAddress, type PublicClient } from "viem";
import { z } from "zod";
import { registryEditAbi, tokenIdOf } from "./edit/registry.js";
import { env } from "./env.js";
import type { Fingerprint, Hex } from "./fingerprint.js";
import { gatewayUrl } from "./ipfs/pinata.js";
import { FINGERPRINT_VERSION, phashHex } from "./metadata.js";
import { BlockedTarget, UnreachableTarget, safeFetch, type SafeFetchOptions } from "./net/safeFetch.js";
import { THUMBNAIL_MAX_BYTES, makeThumbnail } from "./prepare.js";

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
 */
export async function unsealThumbnail(bytes: Buffer): Promise<ThumbnailAttempt> {
  try {
    return { ok: true, thumbnail: await makeThumbnail(bytes) };
  } catch (error) {
    return {
      ok: false,
      limit: THUMBNAIL_MAX_BYTES,
      detail: error instanceof Error ? error.message : String(error),
    };
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
    phash: bigint;
    blockhash256: Hex;
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
  };
}

/**
 * The passport's metadata document, read through the public gateway.
 *
 * safeFetch rather than a plain fetch because the address comes off the chain: metadataURI is
 * whatever the creator signed at registration, and gatewayUrl passes an `http://` one straight
 * through. A passport pointing at this host's own network must not turn this route into a way of
 * reading it.
 *
 * Throws BlockedTarget, UnreachableTarget, or an error naming the status, all of which the route
 * reads as "could not tell" rather than as an answer.
 */
export async function readMetadataDocument(uri: string, options: SafeFetchOptions = {}): Promise<unknown> {
  const response = await safeFetch(new URL(gatewayUrl(uri)), {
    timeoutMs: LOOKUP_TIMEOUT_MS,
    ...options,
  });
  if (!response.ok) {
    throw new UnreachableTarget(`the gateway answered ${response.status} for this passport's metadata`);
  }
  return await response.json();
}

/** Both failures of a gateway read, named together because the route treats them the same way. */
export function isGatewayFailure(error: unknown): boolean {
  return error instanceof BlockedTarget || error instanceof UnreachableTarget;
}

/**
 * What Pinata's file listing says, read loosely on purpose.
 *
 * Only the three fields this service uses are named, and a row missing one of them is dropped
 * rather than failing the whole lookup. An answer shaped differently from this leaves `files`
 * empty, which the caller reports as "cannot tell", never as "nothing is there".
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
      .optional(),
  }),
});

export interface PinnedRecord {
  cid: string;
  uri: `ipfs://${string}`;
  /** When Pinata says the file was pinned, which is a third party's clock rather than ours. */
  createdAt?: string;
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
    return { state: "unavailable", reason: error instanceof Error ? error.message : String(error) };
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

/** The three ways an address is printed in an answer, the same shape the other routes use. */
export function pinnedOut(uri: string, cid: string): { cid: string; uri: string; gatewayUrl: string } {
  return { cid, uri, gatewayUrl: gatewayUrl(uri) };
}

/** The 64 bit perceptual hash as an answer prints it, so a caller never sees a lossy double. */
export function printOut(print: Fingerprint): { phash: string; blockhash: Hex; version: number } {
  return { phash: phashHex(print.phash), blockhash: print.blockhash, version: FINGERPRINT_VERSION };
}
