import { createHash } from "node:crypto";
import { getAddress, hashTypedData, type Address, type Hex } from "viem";
import { z } from "zod";
import { domain } from "../generate/eip712.js";
import { MONAD_CHAIN_ID } from "../reputation/registry.js";
import { isPrintableWithLineBreaks } from "./answer.js";

/** The most the resolver's reasons may weigh in UTF-8 bytes (L28). */
export const MAX_REASONS_BYTES = 8_000;

/** MoolamDecisions.MAX_REASONS_URI_LENGTH: the most bytes a reasons address may have, prefix included. */
export const MAX_REASONS_URI_LENGTH = 128;

/** MoolamDecisions.MIN_CID_LENGTH: the fewest letters and digits after the prefix. */
export const MIN_CID_LENGTH = 46;

export const REASONS_DOCUMENT_KIND = "moolam-decision-reasons";

export const REASONS_DOCUMENT_VERSION = 1;

/** Field order is load bearing: it produces the type string the resolver's wallet hashes. */
export const DECISION_REASONS_TYPES = {
  DecisionReasons: [
    { name: "passportId", type: "bytes32" },
    { name: "openedAt", type: "uint64" },
    { name: "upheld", type: "bool" },
    { name: "reasonsHash", type: "bytes32" },
    { name: "deadline", type: "uint64" },
  ],
} as const;

export interface DecisionReasonsMessage {
  passportId: Hex;
  openedAt: bigint;
  upheld: boolean;
  reasonsHash: Hex;
  deadline: bigint;
}

/**
 * The typed data the resolver signs, in the same Moolam domain as the holder's answer (the
 * registry's), so a signature for one registry or one chain means nothing to another. The dispute is
 * named by the tuple getDispute answers plus the outcome, so reasons signed for one decision cannot be
 * carried to the next challenge on the same passport or to the other outcome.
 */
export function reasonsTypedData(message: DecisionReasonsMessage, registry: Hex) {
  return {
    domain: domain(registry, MONAD_CHAIN_ID),
    types: DECISION_REASONS_TYPES,
    primaryType: "DecisionReasons" as const,
    message,
  };
}

/** The 32 bytes the resolver's signature covers. */
export function reasonsDigest(message: DecisionReasonsMessage, registry: Hex): Hex {
  return hashTypedData(reasonsTypedData(message, registry));
}

/** The sha256 of the reasons' UTF-8 bytes, exactly as sent. */
export function reasonsHashOf(reasons: string): Hex {
  return `0x${createHash("sha256").update(reasons, "utf8").digest("hex")}`;
}

/**
 * Why the reasons are refused, or null when they may be pinned (L28): at least one character, at
 * most MAX_REASONS_BYTES in UTF-8, printable Unicode whose only control character is the line break,
 * by the same predicate as the holder's answer. Never rewritten, because their hash is what the
 * resolver signed.
 */
export function reasonsTextProblem(reasons: string): string | null {
  if (reasons.length === 0) return "the reasons are empty";
  if (Buffer.byteLength(reasons, "utf8") > MAX_REASONS_BYTES) return `the reasons are over ${MAX_REASONS_BYTES} bytes`;
  if (!isPrintableWithLineBreaks(reasons)) {
    return "the reasons must be printable text, with line breaks as their only control characters and no direction characters";
  }
  return null;
}

/**
 * Whether MoolamDecisions.publish would take this address: ipfs:// then only letters and digits, at
 * least MIN_CID_LENGTH of them, and at most MAX_REASONS_URI_LENGTH bytes in all. The same rule as the
 * contract's _isPinnedAddress, so an address this service hands out never reverts InvalidReasonsURI.
 */
export function fitsDecisions(uri: string): boolean {
  const match = /^ipfs:\/\/([A-Za-z0-9]+)$/.exec(uri);
  if (match === null) return false;
  return Buffer.byteLength(uri, "utf8") <= MAX_REASONS_URI_LENGTH && (match[1]?.length ?? 0) >= MIN_CID_LENGTH;
}

const HEX32 = /^0x[0-9a-f]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/**
 * The only document reasons are pinned as. It names the passport, the dispute by openedAt, the
 * outcome, the resolver who signed and the reasons with their hash. It carries no signature and no
 * deadline, so the same reasons for the same decision are the same bytes and the same address.
 */
export const reasonsDocumentSchema = z.strictObject({
  kind: z.literal(REASONS_DOCUMENT_KIND),
  version: z.literal(REASONS_DOCUMENT_VERSION),
  chainId: z.literal(MONAD_CHAIN_ID),
  registry: z.string().regex(ADDRESS),
  passportId: z.string().regex(HEX32),
  openedAt: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  upheld: z.boolean(),
  resolver: z.string().regex(ADDRESS),
  reasons: z.string().refine((reasons) => reasonsTextProblem(reasons) === null, "the reasons must pass the reasons rule"),
  reasonsHash: z.string().regex(HEX32),
  note: z.string().min(1),
});

export type ReasonsDocument = z.infer<typeof reasonsDocumentSchema>;

export const REASONS_DOCUMENT_NOTE =
  "Moolam's resolver signed these reasons with their wallet as EIP-712 DecisionReasons typed data in the Moolam domain of the registry above, for the settled dispute named here. They are the resolver's own words; the decision itself is the registry's DisputeResolved event, and the reasons are bound to it by MoolamDecisions.publish.";

/**
 * Builds the reasons document and hands back the schema's own output. The hash is computed again
 * here, so a document whose reasons and hash disagree is never built.
 *
 * Throws when any field is outside its shape.
 */
export function reasonsDocument(input: {
  registry: Hex;
  passportId: Hex;
  openedAt: bigint;
  upheld: boolean;
  resolver: Address;
  reasons: string;
}): ReasonsDocument {
  return reasonsDocumentSchema.parse({
    kind: REASONS_DOCUMENT_KIND,
    version: REASONS_DOCUMENT_VERSION,
    chainId: MONAD_CHAIN_ID,
    registry: getAddress(input.registry),
    passportId: input.passportId.toLowerCase(),
    openedAt: Number(input.openedAt),
    upheld: input.upheld,
    resolver: getAddress(input.resolver),
    reasons: input.reasons,
    reasonsHash: reasonsHashOf(input.reasons),
    note: REASONS_DOCUMENT_NOTE,
  });
}
