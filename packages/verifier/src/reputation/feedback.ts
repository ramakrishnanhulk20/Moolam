import { keccak256, stringToHex, type Transport } from "viem";
import { env } from "../env.js";
import { PHASH_MATCH_THRESHOLD } from "../fingerprint.js";
import { safeReason } from "../net/errorText.js";
import type { Hex } from "../types.js";
import {
  FEEDBACK_TAG_KIND,
  FEEDBACK_TAG_PRODUCT,
  REPUTATION_REGISTRY,
  readClient,
  reputationAbi,
  writeClient,
} from "./registry.js";

const MAX_SCORE = 100;

/** The 64-bit pHash is the widest distance a verification can report. */
const MAX_DISTANCE_BITS = 64;

/** Monad charges the gas limit, not the gas used, so the limit is the estimate plus 5 percent. */
const GAS_BUFFER_PERCENT = 105n;

export interface VerificationSummary {
  product: typeof FEEDBACK_TAG_PRODUCT;
  check: typeof FEEDBACK_TAG_KIND;
  agentId: string;
  passportId: Hex;
  matched: boolean;
  distanceBits: number;
  score: number;
}

export interface PostFeedbackOptions {
  agentId: bigint;
  matched: boolean;
  distance: number;
  passportId: Hex;
  /** Goes on chain as feedbackURI: the passport's own metadata, which holds the image and manifest. */
  metadataURI: string;
  signerKey: Hex;
  /** Which service of ours the rating is about. Empty when the verifier has no public URL yet. */
  endpoint?: string;
  rpcUrl?: string;
  transport?: Transport;
}

export interface PostFeedbackResult {
  txHash: Hex;
  score: number;
  signer: Hex;
  feedbackHash: Hex;
  summary: VerificationSummary;
  /** The exact bytes that were hashed, so anyone can recompute feedbackHash. */
  summaryJson: string;
  gasLimit: bigint;
  gasUsed: bigint;
  blockNumber: bigint;
}

export interface ReputationSummary {
  count: bigint;
  value: bigint;
  decimals: number;
}

/**
 * Turns a match into a 0 to 100 score, on the same scale the matcher uses.
 *
 * The score falls from 100 at an exact fingerprint to 9 at the widest distance
 * that still counts as a match, so every real match posts a positive number and
 * only a mismatch posts nothing:
 *
 *   score = round(100 * (1 - distance / (PHASH_MATCH_THRESHOLD + 1)))
 *
 * Dividing by the threshold plus one is what keeps the last matching bit worth
 * something. A mismatch is 0, whatever the distance says.
 */
export function scoreFor(matched: boolean, distance: number): number {
  assertDistance(distance);
  if (!matched) {
    return 0;
  }
  const scaled = MAX_SCORE * (1 - distance / (PHASH_MATCH_THRESHOLD + 1));
  return Math.max(0, Math.round(scaled));
}

/**
 * The document behind feedbackHash.
 *
 * It carries no timestamp on purpose: the same verification of the same
 * passport hashes to the same value every time, so a second run is visibly a
 * repeat rather than a new claim.
 */
export function verificationSummary(opts: {
  agentId: bigint;
  passportId: Hex;
  matched: boolean;
  distance: number;
}): { summary: VerificationSummary; json: string; hash: Hex } {
  const summary: VerificationSummary = {
    product: FEEDBACK_TAG_PRODUCT,
    check: FEEDBACK_TAG_KIND,
    agentId: opts.agentId.toString(),
    passportId: opts.passportId.toLowerCase() as Hex,
    matched: opts.matched,
    distanceBits: opts.distance,
    score: scoreFor(opts.matched, opts.distance),
  };
  const json = JSON.stringify(summary);
  return { summary, json, hash: keccak256(stringToHex(json)) };
}

/**
 * Writes one verification outcome to the ERC-8004 Reputation Registry as
 * feedback about the agent that generated the image.
 *
 * The signer must not be the agent's owner or one of its operators: the
 * registry reverts with "Self-feedback not allowed", which is the whole point
 * of the standard. Moolam signs with the verifier's own wallet.
 *
 * Waits for the receipt and throws when the transaction reverted, so a caller
 * never reports a feedback that did not land. Nothing here is idempotent: the
 * registry appends, so calling this twice for one verification writes two
 * entries.
 *
 * Throws when the agent id is zero, the distance is not a whole number of bits
 * between 0 and 64, the passport id is not 32 bytes, or the metadata URI is
 * empty.
 */
export async function postFeedback(opts: PostFeedbackOptions): Promise<PostFeedbackResult> {
  if (opts.agentId <= 0n) {
    throw new Error("agentId must be a positive ERC-8004 identity token id");
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(opts.passportId)) {
    throw new Error("passportId must be 0x followed by 64 hex characters");
  }
  if (opts.metadataURI.trim().length === 0) {
    throw new Error("metadataURI must be the passport's metadata URI, which is what feedbackURI points at");
  }
  assertDistance(opts.distance);

  const { summary, json, hash } = verificationSummary({
    agentId: opts.agentId,
    passportId: opts.passportId,
    matched: opts.matched,
    distance: opts.distance,
  });

  const { wallet, address } = writeClient(opts.signerKey, { rpcUrl: opts.rpcUrl, transport: opts.transport });
  const reader = readClient({ rpcUrl: opts.rpcUrl, transport: opts.transport });
  const args = [
    opts.agentId,
    BigInt(summary.score),
    0,
    FEEDBACK_TAG_PRODUCT,
    FEEDBACK_TAG_KIND,
    opts.endpoint ?? env.VERIFIER_BASE_URL,
    opts.metadataURI,
    hash,
  ] as const;

  const estimate = await reader.estimateContractGas({
    account: address,
    address: REPUTATION_REGISTRY,
    abi: reputationAbi,
    functionName: "giveFeedback",
    args,
  });
  const gasLimit = (estimate * GAS_BUFFER_PERCENT) / 100n;

  const txHash = await wallet.writeContract({
    address: REPUTATION_REGISTRY,
    abi: reputationAbi,
    functionName: "giveFeedback",
    args,
    gas: gasLimit,
    chain: wallet.chain,
    account: wallet.account ?? address,
  });

  const receipt = await reader.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== "success") {
    throw new Error(`giveFeedback reverted in transaction ${txHash}`);
  }

  return {
    txHash,
    score: summary.score,
    signer: address,
    feedbackHash: hash,
    summary,
    summaryJson: json,
    gasLimit,
    gasUsed: receipt.gasUsed,
    blockNumber: receipt.blockNumber,
  };
}

/**
 * Reads the registry's own summary of Moolam's feedback about an agent.
 *
 * The client list cannot be empty: the registry reverts with
 * "clientAddresses required", so there is no all-clients view. It defaults to
 * the verifier's wallet, which is the only address Moolam rates from.
 *
 * Throws when no client address is known, which means VERIFIER_ADDRESS is not set.
 */
export async function readReputation(
  agentId: bigint,
  options: { clients?: Hex[]; rpcUrl?: string; transport?: Transport } = {},
): Promise<ReputationSummary> {
  const fallback = env.VERIFIER_ADDRESS === undefined ? [] : [env.VERIFIER_ADDRESS as Hex];
  const clients = options.clients ?? fallback;
  if (clients.length === 0) {
    throw new Error("readReputation needs at least one client address; set VERIFIER_ADDRESS or pass clients");
  }

  const reader = readClient({ rpcUrl: options.rpcUrl, transport: options.transport });
  const [count, value, decimals] = await reader.readContract({
    address: REPUTATION_REGISTRY,
    abi: reputationAbi,
    functionName: "getSummary",
    args: [agentId, clients, FEEDBACK_TAG_PRODUCT, FEEDBACK_TAG_KIND],
  });

  return { count, value, decimals };
}

/**
 * The line the reputation script writes about an error it caught. That file is tracked in git, and
 * a viem error names the RPC endpoint it called, whose path is a dedicated endpoint's access key, so
 * the error goes through safeReason first like every other chain error this service writes down
 * (review pass 9, answers #10, V87).
 */
export function failureLine(error: unknown): string {
  return `FAILED: ${safeReason(error)}`;
}

function assertDistance(distance: number): void {
  if (!Number.isInteger(distance) || distance < 0 || distance > MAX_DISTANCE_BITS) {
    throw new Error(`distance must be a whole number of bits between 0 and ${MAX_DISTANCE_BITS}`);
  }
}
