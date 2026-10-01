import { decodeEventLog, encodeFunctionData, getAddress, parseAbi, sha256, stringToBytes, type Hex, type Log } from "viem";
import { CHAIN_ID, addresses } from "@/lib/chain/client";
import { DECISIONS_ADDRESS, decisionPublishedEvent } from "./decisionsContract";

/**
 * The resolver's published reasons for a decision (L28): what the resolver's
 * wallet signs for the verify service's POST /decisions/reasons, and the
 * MoolamDecisions.publish call that names the pinned address on Monad.
 *
 * The typed data mirrors packages/verifier/src/challenges/reasons.ts field for
 * field, in the same Moolam registry domain as the holder's answer. A test
 * holds the two together.
 */

/** The most the reasons may weigh in UTF-8 bytes. */
export const MAX_REASONS_BYTES = 8_000;

/** How long the resolver's signature stays good, counted from the chain's head. */
export const REASONS_SIGNATURE_SECONDS = 10 * 60;

/** Field order is load bearing: it is the type string the resolver's wallet hashes. */
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

const DOMAIN = { name: "Moolam", version: "1", chainId: CHAIN_ID, verifyingContract: addresses.registry };

export function reasonsTypedData(message: DecisionReasonsMessage) {
  return { domain: DOMAIN, types: DECISION_REASONS_TYPES, primaryType: "DecisionReasons" as const, message };
}

/** The same typed data in the wallet prompt's JSON shape: the two times as decimal strings, which EIP-712 hashes the same. */
export function walletReasonsTypedData(message: DecisionReasonsMessage) {
  return {
    domain: DOMAIN,
    types: { DecisionReasons: DECISION_REASONS_TYPES.DecisionReasons.map((field) => ({ ...field })) },
    primaryType: "DecisionReasons",
    message: {
      passportId: message.passportId,
      openedAt: message.openedAt.toString(),
      upheld: message.upheld,
      reasonsHash: message.reasonsHash,
      deadline: message.deadline.toString(),
    } as Record<string, unknown>,
  };
}

/** The sha256 of the reasons' UTF-8 bytes, exactly as sent. */
export function reasonsHashOf(reasons: string): Hex {
  return sha256(stringToBytes(reasons));
}

/** The reasons as they are signed and sent: a Windows line break becomes one \n, and nothing else changes. */
export function reasonsText(raw: string): string {
  return raw.replace(/\r\n/g, "\n");
}

export function reasonsBytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

const PRINTABLE_TEXT = /^[\p{L}\p{M}\p{N}\p{P}\p{S} \n]+$/u;

export type ReasonsTextProblem = "empty" | "tooLong" | "notPrintable";

/** The service's rule, checked before the wallet is asked. Text that is only spaces and line breaks reads as empty. */
export function reasonsTextProblem(raw: string): ReasonsTextProblem | null {
  const text = reasonsText(raw);
  if (text.trim().length === 0) return "empty";
  if (reasonsBytes(text) > MAX_REASONS_BYTES) return "tooLong";
  return PRINTABLE_TEXT.test(text) ? null : "notPrintable";
}

/** Every line the publish step can print when it stops, each a key under challenge.publish.refusals. */
export type PublishRefusal =
  | ReasonsTextProblem
  | "expired"
  | "notResolver"
  | "notSettled"
  | "mismatch"
  | "alreadyPublished"
  | "pinning"
  | "busy"
  | "pinFailed"
  | "unavailable"
  | "chainUnreachable"
  | "declined"
  | "invalidAddress"
  | "reverted"
  | "unknown";

const REFUSAL_OF_ERROR: Record<string, PublishRefusal> = {
  "reasons-expired": "expired",
  "not-the-resolver": "notResolver",
  "dispute-not-settled": "notSettled",
  "dispute-mismatch": "mismatch",
  "already-published": "alreadyPublished",
  pinning: "pinning",
  "global-limit": "busy",
  "route-limit": "busy",
  "pin-failed": "pinFailed",
  "address-unfit": "pinFailed",
  "chain-unreachable": "chainUnreachable",
  "reasons-unavailable": "unavailable",
};

/** One refusal from the reasons route, in the console's words. The 400s carry a sentence, read by what it says. */
export function reasonsRefusalOf(status: number, error: unknown): PublishRefusal {
  const word = typeof error === "string" ? error : "";
  const named = REFUSAL_OF_ERROR[word];
  if (named !== undefined) return named;
  if (status === 429) return "busy";
  if (status === 400) {
    if (/empty/.test(word)) return "empty";
    if (/bytes/.test(word)) return "tooLong";
    if (/printable/.test(word)) return "notPrintable";
    return "unknown";
  }
  if (status === 404 || status === 503) return "unavailable";
  return "unknown";
}

/** The contract's own surface this console touches: the write, the read that says it is done, and its errors. */
export const decisionsAbi = parseAbi([
  "function publish(bytes32 passportId, string reasonsURI)",
  "function published(bytes32 passportId, uint64 openedAt) view returns (bool)",
  "error NotResolver(address caller)",
  "error DisputeNotResolved(bytes32 passportId, uint8 status)",
  "error InvalidReasonsURI()",
  "error AlreadyPublished(bytes32 passportId, uint64 openedAt)",
]);

/** The contract's revert names, each to its line. */
export const REFUSAL_OF_REVERT: Record<string, PublishRefusal> = {
  NotResolver: "notResolver",
  DisputeNotResolved: "notSettled",
  InvalidReasonsURI: "invalidAddress",
  AlreadyPublished: "alreadyPublished",
};

export function publishCalldata(passportId: Hex, reasonsURI: string): Hex {
  return encodeFunctionData({ abi: decisionsAbi, functionName: "publish", args: [passportId, reasonsURI] });
}

/** What a receipt proves was published: the DecisionPublished event MoolamDecisions emitted in it. */
export interface PublishedInReceipt {
  passportId: Hex;
  openedAt: bigint;
  upheld: boolean;
  reasonsURI: string;
  resolver: Hex;
}

/**
 * The DecisionPublished event in a receipt's logs for this very dispute, or
 * null. Only a log MoolamDecisions itself wrote counts, so an event of the same
 * shape from any other contract in the same transaction proves nothing. The
 * console calls a publish done from this and nothing else: not the hash the
 * wallet returned, not a read that the flag is set.
 */
export function publishedInReceipt(
  receipt: { status: "success" | "reverted"; logs: readonly Pick<Log, "address" | "data" | "topics">[] },
  expected: { passportId: Hex; openedAt: bigint; reasonsURI: string },
): PublishedInReceipt | null {
  if (receipt.status !== "success") {
    return null;
  }
  for (const log of receipt.logs) {
    if (getAddress(log.address) !== getAddress(DECISIONS_ADDRESS)) {
      continue;
    }
    try {
      const decoded = decodeEventLog({ abi: [decisionPublishedEvent], data: log.data, topics: log.topics as never });
      const args = decoded.args;
      if (
        args.passportId.toLowerCase() === expected.passportId.toLowerCase() &&
        args.openedAt === expected.openedAt &&
        args.reasonsURI === expected.reasonsURI
      ) {
        return { ...args, resolver: getAddress(args.resolver) };
      }
    } catch {
      // Another event from the same contract; it is not this one.
    }
  }
  return null;
}
