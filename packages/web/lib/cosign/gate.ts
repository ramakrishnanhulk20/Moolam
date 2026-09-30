import { getAddress, type Hex } from "viem";
import type { PassportInput } from "@/lib/chain/calldata";
import { localPassportDigest } from "@/lib/chain/digest";
import type { Passport } from "@/lib/chain/registry";
import type { ConsentDraft } from "@/lib/consent/call";
import { fileTermsOf } from "@/lib/data/file-terms";
import type { Gate } from "./flow";
import type { CosignRecord } from "./record";

/**
 * P1, what is shown is what is signed, and P6 and P12 around it.
 *
 * Nothing the verify service says is taken on its word here. The picture drawn
 * is the file whose sha256 is the passport id, hashed in this browser. The
 * title and the terms come from the metadata document whose content id the
 * passport commits to, recomputed here from its bytes. The digest the passkey
 * will sign is rebuilt in this browser from those fields and the signed-in
 * wallet, then held against the record's stored digest and the registry's own
 * hashPassport. Every read is passed in, so a test can stand in for the chain
 * and the gateway.
 */

export interface PinnedReads {
  /** The body at an address, refused past `cap` bytes. */
  fetchBytes: (url: string, cap: number) => Promise<Uint8Array>;
  sha256: (bytes: Uint8Array) => Promise<Hex>;
}

export interface ChainReads {
  passport: (id: Hex) => Promise<Passport | null>;
  holder: (id: Hex) => Promise<Hex | null>;
  /** The head block's timestamp, never this device's clock (P12). */
  now: () => Promise<bigint>;
  hashPassport: (input: PassportInput) => Promise<Hex>;
}

/** A registered picture from the platform kit is never near this, and anything past it is not one. */
export const PICTURE_CAP = 25 * 1024 * 1024;

/** One raw IPFS block: the most a metadata document may be for its content id to be the sha256 of its bytes. */
export const METADATA_CAP = 262_144;

const TITLE_MAX = 200;

/** The struct the passkey signs: the record's fields, the signed-in wallet as creator, the record's deadline. */
export function passportInputOf(record: CosignRecord, wallet: Hex): PassportInput {
  const fields = record.passport;
  if (fields.deadline === undefined) {
    throw new Error("the record carries no deadline yet, so there is nothing to sign");
  }
  return {
    exactHash: fields.exactHash,
    parentId: fields.parentId,
    creator: getAddress(wallet),
    generatorAgentId: BigInt(fields.generatorAgentId),
    phash: BigInt(fields.phash),
    blockhash256: fields.blockhash256,
    manifestHash: fields.manifestHash,
    kind: fields.kind,
    fingerprintVersion: fields.fingerprintVersion,
    metadataURI: fields.metadataURI,
    deadline: BigInt(fields.deadline),
  };
}

/** Whether the passport the registry holds under this id is this record, registered by this wallet. */
export function isOurs(onChain: Passport, record: CosignRecord, wallet: Hex): boolean {
  return (
    getAddress(onChain.creator) === getAddress(wallet) &&
    onChain.generatorAgentId === BigInt(record.passport.generatorAgentId) &&
    onChain.metadataURI === record.passport.metadataURI &&
    onChain.manifestHash.toLowerCase() === record.passport.manifestHash.toLowerCase()
  );
}

export type FirstLook =
  | { kind: "clear" }
  | { kind: "ours" }
  | { kind: "taken"; holder: Hex | null }
  | { kind: "expired" };

/**
 * The two reads made before anything else: whether the registry already holds
 * these bytes (P6), and whether the chain's clock has passed the deadline
 * (P12). A passport under this id that is not this record is somebody else's,
 * and the page names its holder and offers nothing to sign.
 */
export async function firstLook(record: CosignRecord, wallet: Hex, chain: ChainReads): Promise<FirstLook> {
  const onChain = await chain.passport(record.passport.exactHash);
  if (onChain !== null) {
    if (isOurs(onChain, record, wallet)) {
      return { kind: "ours" };
    }
    return { kind: "taken", holder: await chain.holder(record.passport.exactHash).catch(() => null) };
  }
  return pastDeadline(record, await chain.now()) ? { kind: "expired" } : { kind: "clear" };
}

/** True once chain time is past the record's deadline, or past the time to open it when there is none yet. */
export function pastDeadline(record: CosignRecord, chainNow: bigint): boolean {
  const endsAt = record.passport.deadline === undefined ? BigInt(record.openBy) : BigInt(record.passport.deadline);
  return chainNow > endsAt;
}

export type Pinned =
  | { ok: true; picture: Uint8Array; title: string | null; terms: ConsentDraft | null }
  | { ok: false; what: "picture" | "metadata" };

/**
 * The pinned picture and metadata, each held against what the passport
 * commits to. The picture's sha256 must be the passport id. The metadata's
 * content id must be the one in the passport's metadataURI, recomputed from
 * its bytes, and it must name this picture and this agent. Anything else, a
 * gateway that answered with other bytes most of all, draws nothing.
 */
export async function drawPinned(record: CosignRecord, reads: PinnedReads): Promise<Pinned> {
  const { image, metadata } = record.files;

  let picture: Uint8Array;
  try {
    picture = await reads.fetchBytes(image.gatewayUrl, Math.min(PICTURE_CAP, image.bytes));
  } catch {
    return { ok: false, what: "picture" };
  }
  if ((await reads.sha256(picture)).toLowerCase() !== record.passport.exactHash.toLowerCase()) {
    return { ok: false, what: "picture" };
  }

  const cid = contentIdOf(record.passport.metadataURI);
  if (cid === null || metadata.uri !== record.passport.metadataURI || metadata.cid !== cid) {
    return { ok: false, what: "metadata" };
  }
  let document: unknown;
  try {
    const bytes = await reads.fetchBytes(metadata.gatewayUrl, METADATA_CAP);
    if (rawContentId(await reads.sha256(bytes)) !== cid) {
      return { ok: false, what: "metadata" };
    }
    document = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    return { ok: false, what: "metadata" };
  }
  if (typeof document !== "object" || document === null || Array.isArray(document)) {
    return { ok: false, what: "metadata" };
  }
  const doc = document as { name?: unknown; image?: unknown; generator?: { agentId?: unknown }; training?: unknown };
  if (doc.image !== image.uri || doc.generator?.agentId !== record.agentId) {
    return { ok: false, what: "metadata" };
  }

  const title = typeof doc.name === "string" && doc.name.trim() !== "" ? doc.name.trim().slice(0, TITLE_MAX) : null;
  return { ok: true, picture, title, terms: doc.training === undefined ? null : fileTermsOf(doc.training) };
}

/**
 * The digest this browser builds from the fields and the signed-in wallet,
 * compared first with the record's stored digest and then with the
 * registry's hashPassport. The passkey button opens only on "passed".
 */
export async function checkDigests(record: CosignRecord, wallet: Hex, chain: ChainReads): Promise<Gate> {
  if (record.digest === undefined || record.agentSignature === undefined) {
    return { at: "failed", what: "record" };
  }
  if (record.agentId !== record.passport.generatorAgentId || record.exactHash !== record.passport.exactHash) {
    return { at: "failed", what: "record" };
  }
  let input: PassportInput;
  try {
    input = passportInputOf(record, wallet);
  } catch {
    return { at: "failed", what: "record" };
  }
  const local = localPassportDigest(input);
  if (local.toLowerCase() !== record.digest.toLowerCase()) {
    return { at: "failed", what: "record", local, other: record.digest };
  }
  const registry = await chain.hashPassport(input);
  if (local.toLowerCase() !== registry.toLowerCase()) {
    return { at: "failed", what: "registry", local, other: registry };
  }
  return { at: "passed", digest: local };
}

/** The content id inside an ipfs:// address, or null for anything else. */
export function contentIdOf(uri: string): string | null {
  const match = /^ipfs:\/\/(b[a-z2-7]{20,100})$/.exec(uri);
  return match === null ? null : match[1];
}

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

/**
 * The CIDv1 of one raw block with this sha256, in lower case base32: the id
 * Pinata gives a file under 256 KiB, and the one the verify service computes
 * before it pins (packages/verifier/src/ipfs/pinata.ts, contentIdOf).
 */
export function rawContentId(sha256: Hex): string {
  const digest = sha256.slice(2);
  const bytes = [0x01, 0x55, 0x12, 0x20];
  for (let at = 0; at < digest.length; at += 2) {
    bytes.push(Number.parseInt(digest.slice(at, at + 2), 16));
  }
  let bits = 0;
  let value = 0;
  let out = "b";
  for (const byte of bytes) {
    value = ((value << 8) | byte) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += BASE32[(value << (5 - bits)) & 31];
  }
  return out;
}

/** The browser's own reads for the pinned files: no redirect, no cookie, no referrer, and a byte cap. */
export const browserPinnedReads: PinnedReads = {
  fetchBytes: async (url, cap) => {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new Error("a pinned file is read over http only");
    }
    const response = await fetch(parsed, {
      redirect: "error",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      signal: AbortSignal.timeout(30_000),
    });
    if (response.status !== 200 || response.body === null) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error("the gateway did not hand the file over");
    }
    const declared = Number(response.headers.get("content-length") ?? "");
    if (Number.isFinite(declared) && declared > cap) {
      await response.body.cancel().catch(() => undefined);
      throw new Error("the file is larger than the passport says");
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > cap) {
        await reader.cancel().catch(() => undefined);
        throw new Error("the file is larger than the passport says");
      }
      chunks.push(value);
    }
    const out = new Uint8Array(length);
    let at = 0;
    for (const chunk of chunks) {
      out.set(chunk, at);
      at += chunk.byteLength;
    }
    return out;
  },
  sha256: async (bytes) => {
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
    return `0x${Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")}` as Hex;
  },
};
