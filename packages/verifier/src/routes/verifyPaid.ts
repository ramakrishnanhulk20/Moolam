import { createHash } from "node:crypto";
import { decodePaymentSignatureHeader } from "@x402/core/http";
import type { HTTPRequestContext, ProcessSettleResultResponse, x402HTTPResourceServer } from "@x402/core/server";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import type { FastifyBaseLogger, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { isAddress, isAddressEqual, parseAbi, parseEventLogs, type Hex } from "viem";
import { withPassportFacts } from "../disputeRead.js";
import { env } from "../env.js";
import { safeReason } from "../net/errorText.js";
import { readClient } from "../reputation/registry.js";
import type { IndexState } from "../types.js";
import { paymentLedger, type LedgerEntry, type PaymentLedger } from "../x402/ledger.js";
import { assertPaidRoute, contextFor, PAID_VERIFY_PATH, PAYMENT_SIGNATURE_HEADER } from "../x402/plugin.js";
import {
  CallerGone,
  SERVICE_FAULT_REASON,
  ServiceFault,
  givesUploadsBack,
  readUpload,
  statusOf,
  verifyBytes,
} from "./shared.js";

/** What the facilitator calls a transfer it has broadcast but not yet seen confirmed. */
const SETTLEMENT_PENDING = "settlement_pending";

/**
 * How long to wait before asking the facilitator once more about a pending
 * settlement, or about one whose outcome is unknown. The x402 library already
 * retries with no gap, so the only thing a second ask of our own adds is the time
 * in between: long enough for a Monad block to confirm, short enough that the
 * caller is not left hanging.
 */
export const PENDING_SETTLEMENT_RETRY_MS = 5_000;

/**
 * The shape every x402 facilitator gives a refusal reason: a lower case code such as
 * insufficient_funds. A reason in words is the x402 library passing on a thrown error, a network
 * failure or a timeout, which says nothing about whether the transfer happened.
 */
const FACILITATOR_REASON = /^[a-z][a-z0-9_]*$/;

const NONCE = /^0x[0-9a-fA-F]{64}$/;

/** What a second request carrying a payment another request is still working on is told. */
export const PAYMENT_IN_FLIGHT_REASON =
  "another request is using this payment right now and has not finished. Try again in a moment: once it answers, the same payment with the same file gets the answer it bought, and nothing is charged twice.";

/** The one call the chain is asked: whether an EIP-3009 authorisation has been used. */
const AUTHORIZATION_STATE_ABI = [
  {
    type: "function",
    name: "authorizationState",
    stateMutability: "view",
    inputs: [
      { name: "authorizer", type: "address" },
      { name: "nonce", type: "bytes32" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

/**
 * The two USDC events that together are one EIP-3009 payment landing: the authorisation for this
 * payer and nonce used (a cancellation emits AuthorizationCanceled instead), and the value moving
 * from the payer to the payee.
 */
const TRANSFER_EVENTS_ABI = parseAbi([
  "event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);

/** The one event the log search asks for, with the payer and the nonce as its two indexed topics. */
const AUTHORIZATION_USED_EVENT = TRANSFER_EVENTS_ABI[0];

const TRANSACTION_HASH = /^0x[0-9a-fA-F]{64}$/;

/**
 * How many blocks one eth_getLogs call covers. Monad's public RPC refuses a wide range, and 100 is
 * the window packages/agents already walks the registry's logs in.
 */
export const LOG_CHUNK_BLOCKS = 100n;

/**
 * How far before the block read when the payment was held the log search starts. The block number
 * comes from whichever RPC endpoint answered, and a second endpoint can trail the first by a block
 * or two, so a transfer mined right at the hold is still inside the range.
 */
export const HOLD_LOOKBACK_BLOCKS = 5n;

/**
 * The most chunks one check reads: 5,000 blocks, far past any x402 authorisation's lifetime on
 * Monad. A search that has not reached the block at validBefore by then answers "cannot tell".
 */
export const LOG_SEARCH_MAX_CHUNKS = 50;

/**
 * Whether this request's payment landed, proven from the pay asset itself (review pass 6, V43).
 *
 * True only when the asset says the authorisation was used, and a transaction that used it for this
 * payer and nonce succeeded and moved at least the price from the payer to the payee. False when the
 * asset says the authorisation was never used, or when every block up to the one at validBefore was
 * searched and no such transaction is there (a cancellation, or a use before this request). Undefined
 * when nobody can tell: a failed or unfinished read, or a transfer that may still land.
 *
 * `heldAt` is the block read when this payment was first settled, where the search starts. When
 * that read failed it is undefined, and the search starts from the authorisation's validAfter.
 */
export type ChargedCheck = (
  payment: PaymentPayload,
  requirements: PaymentRequirements,
  transactions: readonly string[],
  heldAt?: bigint,
) => Promise<boolean | undefined>;

/** One AuthorizationUsed log as the search reads it, every field checked before it is believed. */
interface UsedLog {
  address?: unknown;
  transactionHash?: unknown;
  args?: { authorizer?: unknown; nonce?: unknown };
}

/** The reads the live check makes. A viem public client has all five. */
export interface ChargeReader {
  readContract: (args: {
    address: Hex;
    abi: typeof AUTHORIZATION_STATE_ABI;
    functionName: "authorizationState";
    args: readonly [Hex, Hex];
  }) => Promise<unknown>;
  getTransactionReceipt: (args: { hash: Hex }) => Promise<{ status: string; logs: readonly unknown[] }>;
  getBlockNumber: () => Promise<bigint>;
  getBlock: (args: { blockNumber: bigint }) => Promise<{ timestamp: bigint }>;
  getLogs: (args: {
    address: Hex;
    event: typeof AUTHORIZATION_USED_EVENT;
    args: { authorizer: Hex; nonce: Hex };
    fromBlock: bigint;
    toBlock: bigint;
  }) => Promise<readonly UsedLog[]>;
}

/** The request fields every log line here carries. */
interface Where {
  ip: string;
  url: string;
}

/**
 * How one payment ended.
 *
 * "settled" and "broadcast" both mean the payer's money is moving, so both
 * answer with the verification. "refused" means the facilitator said no transfer
 * exists, so nothing is served. "unknown" means nobody could say, so the answer
 * is held back and kept against this payment, never thrown away as refused.
 */
type Settlement =
  | { state: "settled" | "broadcast"; headers: Record<string, string> }
  | { state: "refused"; status: number; headers: Record<string, string>; body: unknown }
  | { state: "unknown"; reason: string; transactions: string[] };

/** A settle answer that is not a success, which is the one that carries a response to send. */
type SettleFailure = Extract<ProcessSettleResultResponse, { success: false }>;

/** One ask of the facilitator, sorted. An unknown answer keeps any transaction it named. */
type Attempt =
  | { kind: "settled"; headers: Record<string, string> }
  | { kind: "broadcast"; result: SettleFailure }
  | { kind: "refused"; result: SettleFailure }
  | { kind: "unknown"; reason: string; transaction?: string };

/** A transfer the facilitator has put on chain: pending, and carrying the hash that proves it. */
function isBroadcast(settled: ProcessSettleResultResponse): boolean {
  return !settled.success && settled.errorReason === SETTLEMENT_PENDING && settled.transaction.length > 0;
}

/**
 * The facilitator's own refusal: a reason code and no transaction. Anything else that is not a
 * success, a thrown error included, is unknown. Covers every refusal an x402 facilitator writes;
 * does not cover a facilitator that answers in words, which is read as unknown and asked again.
 */
function isRefusal(settled: ProcessSettleResultResponse): boolean {
  const reason = settled.errorReason ?? "";
  return !settled.success && FACILITATOR_REASON.test(reason) && settled.transaction.length === 0;
}

/**
 * The settle answer with its transaction read once, as a string. @x402/core only promises the field
 * on a 2xx settle reply; a non-2xx reply is passed on as the facilitator wrote it, so a failure that
 * left the field out arrives with it undefined (review pass 7, V59). Missing reads as none.
 */
function normalised(result: ProcessSettleResultResponse): ProcessSettleResultResponse {
  const transaction = (result as { transaction?: unknown }).transaction;
  return typeof transaction === "string" ? result : { ...result, transaction: "" };
}

/**
 * One ask of the facilitator, sorted. The classification sits inside the same try as the call, so
 * an answer of a shape nobody expected is unknown, and held, rather than a crash that drops it.
 */
async function attempt(settle: () => Promise<ProcessSettleResultResponse>): Promise<Attempt> {
  try {
    const result = normalised(await settle());
    if (result.success) return { kind: "settled", headers: result.headers };
    if (isBroadcast(result)) return { kind: "broadcast", result };
    if (isRefusal(result)) return { kind: "refused", result };
    return {
      kind: "unknown",
      reason: result.errorReason ?? "the facilitator gave no reason",
      ...(result.transaction.length > 0 ? { transaction: result.transaction } : {}),
    };
  } catch (error) {
    return { kind: "unknown", reason: safeReason(error) };
  }
}

/** The transaction an attempt named, which is what the chain check proves a payment by. */
function transactionOf(attempted: Attempt): string | undefined {
  if (attempted.kind === "broadcast") return attempted.result.transaction;
  if (attempted.kind === "unknown") return attempted.transaction;
  return undefined;
}

const pause = (ms: number): Promise<void> =>
  ms <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A payment as it is compared: the payer and nonce it is kept under, and every signed field with the
 * signature. EIP-3009 nonces are unique per payer, not across payers, so the nonce alone would let a
 * second payer's entry replace the first one's (review pass 6, V48).
 */
interface PaymentIdentity {
  key: string;
  identity: string;
}

/**
 * The same reading for a payment offered in a header and for the one the facilitator verified, so
 * a repeat is compared after one normaliser on both sides. Undefined for anything that is not a
 * signed EIP-3009 authorisation with every field present.
 */
function identityOf(payment: unknown): PaymentIdentity | undefined {
  const inner = (payment as { payload?: unknown } | null | undefined)?.payload as
    | { signature?: unknown; authorization?: Record<string, unknown> }
    | undefined;
  const authorization = inner?.authorization;
  const fields = [
    inner?.signature,
    authorization?.from,
    authorization?.to,
    authorization?.value,
    authorization?.validAfter,
    authorization?.validBefore,
    authorization?.nonce,
  ];
  if (!fields.every((field) => typeof field === "string" && field.length > 0)) {
    return undefined;
  }
  const nonce = (authorization?.nonce as string).toLowerCase();
  const from = (authorization?.from as string).toLowerCase();
  if (!NONCE.test(nonce) || !isAddress(from)) {
    return undefined;
  }
  return { key: `${from}:${nonce}`, identity: (fields as string[]).map((field) => field.toLowerCase()).join("|") };
}

/** The payment this request offers, read from its header without trusting it. */
function offeredPayment(context: HTTPRequestContext): PaymentIdentity | undefined {
  const header = context.adapter.getHeader(PAYMENT_SIGNATURE_HEADER);
  if (header === undefined || header.length === 0) {
    return undefined;
  }
  try {
    return identityOf(decodePaymentSignatureHeader(header));
  } catch {
    return undefined;
  }
}

function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** The fields of a payment and its terms the chain check compares against, each already checked. */
interface PaymentTerms {
  asset: Hex;
  from: Hex;
  payTo: Hex;
  nonce: Hex;
  price: bigint;
  /** The value the payer signed. The transfer that proves this payment moves exactly this much. */
  value: bigint;
  /** Unix seconds. Undefined when the payment does not carry it. */
  validAfter: bigint | undefined;
  /** Unix seconds. Undefined when the payment does not carry it, which leaves only named transactions. */
  validBefore: bigint | undefined;
}

const WHOLE_NUMBER = /^[0-9]+$/;

function wholeNumber(value: unknown): bigint | undefined {
  return typeof value === "string" && WHOLE_NUMBER.test(value) ? BigInt(value) : undefined;
}

/** The payment and its terms read as the chain check needs them, or undefined for anything malformed. */
function termsOf(payment: PaymentPayload, requirements: PaymentRequirements): PaymentTerms | undefined {
  const authorization = (
    payment.payload as
      | { authorization?: { from?: unknown; nonce?: unknown; value?: unknown; validAfter?: unknown; validBefore?: unknown } }
      | undefined
  )?.authorization;
  const from = authorization?.from;
  const nonce = authorization?.nonce;
  const value = wholeNumber(authorization?.value);
  const asset = requirements.asset;
  const payTo = requirements.payTo;
  const price = wholeNumber((requirements as { amount?: unknown }).amount);
  if (typeof from !== "string" || !isAddress(from) || typeof nonce !== "string" || !NONCE.test(nonce)) {
    return undefined;
  }
  if (typeof asset !== "string" || !isAddress(asset) || typeof payTo !== "string" || !isAddress(payTo)) {
    return undefined;
  }
  if (price === undefined || value === undefined) {
    return undefined;
  }
  return {
    asset,
    from,
    payTo,
    nonce: nonce.toLowerCase() as Hex,
    price,
    value,
    validAfter: wholeNumber(authorization?.validAfter),
    validBefore: wholeNumber(authorization?.validBefore),
  };
}

/**
 * The live check, proven from the pay asset itself (review pass 6, V43).
 *
 * authorizationState is read first. False is the authorisation never used, so nothing was charged.
 * True is not taken as payment on its own, because it is equally true after the payer cancelled
 * the authorisation and after another request spent it, so the transaction that used it is found
 * and read: first any the facilitator named, then the asset's own AuthorizationUsed log for this
 * payer and this nonce, searched from a few blocks before the payment was held, in chunks the RPC
 * accepts, up to the block at the authorisation's validBefore, since the transfer cannot land after
 * it. A payment held while the newest block could not be read is searched from the block at its
 * validAfter instead (review pass 9, V83). That transaction counts only when it succeeded and its
 * AuthorizationUsed for this payer and nonce is followed at the very next log by a Transfer of the
 * signed value from the payer to the payee, both emitted by the asset contract (V81).
 *
 * Anything malformed in the payment or the terms, and any read that fails, is undefined.
 */
export function chainCharged(chain: ChargeReader = readClient() as unknown as ChargeReader): ChargedCheck {
  return async (payment, requirements, transactions, heldAt) => {
    const terms = termsOf(payment, requirements);
    if (terms === undefined) {
      return undefined;
    }

    let used: unknown;
    try {
      used = await chain.readContract({
        address: terms.asset,
        abi: AUTHORIZATION_STATE_ABI,
        functionName: "authorizationState",
        args: [terms.from, terms.nonce],
      });
    } catch {
      return undefined;
    }
    if (used === false) {
      return false;
    }
    if (used !== true) {
      return undefined;
    }

    for (const hash of new Set(transactions)) {
      if (TRANSACTION_HASH.test(hash) && (await landed(chain, hash as Hex, terms)) === true) {
        return true;
      }
    }
    return await searchLogs(chain, terms, heldAt);
  };
}

/**
 * Walks the asset's AuthorizationUsed logs for this payer and nonce, forward from the hold, and
 * reads each transaction one names. Bounded by LOG_SEARCH_MAX_CHUNKS calls of LOG_CHUNK_BLOCKS.
 */
async function searchLogs(chain: ChargeReader, terms: PaymentTerms, heldAt: bigint | undefined): Promise<boolean | undefined> {
  if (terms.validBefore === undefined) {
    return undefined;
  }
  let head: bigint;
  try {
    head = await chain.getBlockNumber();
  } catch {
    return undefined;
  }

  let from: bigint;
  // A start later than the first block the authorisation allows leaves blocks unread, so a search
  // that ends empty there cannot say the payment never landed.
  let skipped = false;
  if (heldAt !== undefined) {
    from = heldAt > HOLD_LOOKBACK_BLOCKS ? heldAt - HOLD_LOOKBACK_BLOCKS : 0n;
  } else {
    const start = await startFromValidity(chain, terms.validAfter, terms.validBefore, head);
    if (start === undefined) {
      return undefined;
    }
    ({ from, skipped } = start);
  }

  let unresolved = skipped;
  for (let chunk = 0; chunk < LOG_SEARCH_MAX_CHUNKS && from <= head; chunk += 1) {
    const to = from + LOG_CHUNK_BLOCKS - 1n < head ? from + LOG_CHUNK_BLOCKS - 1n : head;
    let logs: readonly UsedLog[];
    try {
      logs = await chain.getLogs({
        address: terms.asset,
        event: AUTHORIZATION_USED_EVENT,
        args: { authorizer: terms.from, nonce: terms.nonce },
        fromBlock: from,
        toBlock: to,
      });
    } catch {
      return undefined;
    }
    for (const log of logs) {
      // The RPC's answer is read like an input: the asset, the payer, the nonce and the hash are
      // each checked here rather than trusted to the topic filter.
      const hash = log.transactionHash;
      if (
        typeof log.address !== "string" ||
        !isAddress(log.address) ||
        !isAddressEqual(log.address, terms.asset) ||
        typeof log.args?.authorizer !== "string" ||
        !isAddress(log.args.authorizer) ||
        !isAddressEqual(log.args.authorizer, terms.from) ||
        typeof log.args.nonce !== "string" ||
        log.args.nonce.toLowerCase() !== terms.nonce ||
        typeof hash !== "string" ||
        !TRANSACTION_HASH.test(hash)
      ) {
        continue;
      }
      const proved = await landed(chain, hash as Hex, terms);
      if (proved === true) {
        return true;
      }
      if (proved === undefined) {
        unresolved = true;
      }
    }

    // EIP-3009 refuses a transfer in any block whose time is at or past validBefore, so once this
    // chunk's last block is there, no later block can hold it.
    let end: { timestamp: bigint };
    try {
      end = await chain.getBlock({ blockNumber: to });
    } catch {
      return undefined;
    }
    if (end.timestamp >= terms.validBefore) {
      return unresolved ? undefined : false;
    }
    from = to + 1n;
  }
  return undefined;
}

/**
 * Most block reads one bisection makes. 64 halvings cover any block number a bigint the RPC hands
 * back could hold on Monad for centuries; Monad's head today needs about 26.
 */
const BISECT_MAX_STEPS = 64;

/**
 * Where the search for a payment held with no block starts (review pass 9, V83): the first block
 * whose time is past validAfter, the earliest EIP-3009 lets the transfer land in. The x402 client
 * signs validAfter as 0, so when the blocks from there to the last one before validBefore are more
 * than one search reads, the search covers the newest of them, ending at that last block, and says
 * so with `skipped`. Undefined when validAfter is missing or a block read fails.
 */
async function startFromValidity(
  chain: ChargeReader,
  validAfter: bigint | undefined,
  validBefore: bigint,
  head: bigint,
): Promise<{ from: bigint; skipped: boolean } | undefined> {
  if (validAfter === undefined) {
    return undefined;
  }
  const first = validAfter === 0n ? 0n : await firstBlockPast(chain, validAfter, head);
  const atValidBefore = validBefore === 0n ? 0n : await firstBlockPast(chain, validBefore - 1n, head);
  if (first === undefined || atValidBefore === undefined) {
    return undefined;
  }
  const last = atValidBefore - 1n < head ? atValidBefore - 1n : head;
  const budget = LOG_CHUNK_BLOCKS * BigInt(LOG_SEARCH_MAX_CHUNKS);
  const floor = last + 1n > budget ? last + 1n - budget : 0n;
  return floor > first ? { from: floor, skipped: true } : { from: first, skipped: false };
}

/**
 * The lowest block from 0 to `head` whose time is past `time`, or head + 1 when none is yet.
 * Undefined when a block read fails or the bisection runs past BISECT_MAX_STEPS.
 */
async function firstBlockPast(chain: ChargeReader, time: bigint, head: bigint): Promise<bigint | undefined> {
  let low = 0n;
  let high = head + 1n;
  for (let step = 0; step < BISECT_MAX_STEPS && low < high; step += 1) {
    const middle = (low + high) / 2n;
    let block: { timestamp: bigint };
    try {
      block = await chain.getBlock({ blockNumber: middle });
    } catch {
      return undefined;
    }
    if (block.timestamp > time) {
      high = middle;
    } else {
      low = middle + 1n;
    }
  }
  return low === high ? low : undefined;
}

/** Whether one transaction is this payment landing: true, false, or undefined when its receipt cannot be read. */
async function landed(chain: ChargeReader, hash: Hex, terms: PaymentTerms): Promise<boolean | undefined> {
  let receipt: { status: string; logs: readonly unknown[] };
  try {
    receipt = await chain.getTransactionReceipt({ hash });
  } catch {
    return undefined;
  }
  return receipt.status === "success" && carriesPayment(receipt.logs, terms);
}

/** One receipt log as carriesPayment reads it. */
interface ReceiptLog {
  address?: unknown;
  logIndex?: unknown;
}

/** The asset's own AuthorizationUsed or Transfer event in one log, or undefined for anything else. */
function assetEvent(log: ReceiptLog | undefined, asset: Hex) {
  if (log === undefined || typeof log.address !== "string" || !isAddress(log.address) || !isAddressEqual(log.address, asset)) {
    return undefined;
  }
  try {
    return parseEventLogs({ abi: TRANSFER_EVENTS_ABI, logs: [log] as never })[0];
  } catch {
    return undefined;
  }
}

/**
 * Whether a receipt's logs hold this payment (review pass 9, V81). FiatToken's
 * transferWithAuthorization emits AuthorizationUsed and then, as the very next log, the Transfer it
 * authorised, so only that Transfer proves this nonce: from the asset, from the payer to the payee,
 * for exactly the value the payer signed, which is at least the price. A Transfer anywhere else in
 * the receipt belongs to some other authorisation, and one transaction that spends several nonces
 * beside one real transfer proves one payment, not all of them. The next log is found by its
 * logIndex when the receipt carries one, and by its place in the list when it does not.
 */
function carriesPayment(logs: readonly unknown[], expected: PaymentTerms): boolean {
  const entries = logs as readonly ReceiptLog[];
  for (const [at, log] of entries.entries()) {
    const used = assetEvent(log, expected.asset);
    if (
      used?.eventName !== "AuthorizationUsed" ||
      !isAddressEqual(used.args.authorizer, expected.from) ||
      used.args.nonce.toLowerCase() !== expected.nonce
    ) {
      continue;
    }
    const index = log.logIndex;
    const next =
      typeof index === "number" ? entries.find((other) => other.logIndex === index + 1) : entries[at + 1];
    const moved = assetEvent(next, expected.asset);
    // A nonce is used once, so the first AuthorizationUsed for it is the only one to judge.
    return (
      moved?.eventName === "Transfer" &&
      isAddressEqual(moved.args.from, expected.from) &&
      isAddressEqual(moved.args.to, expected.payTo) &&
      moved.args.value === expected.value &&
      expected.value >= expected.price
    );
  }
  return false;
}

/**
 * Settles the payment and says what the route may answer with.
 *
 * - the facilitator confirms the transfer: "settled", with its receipt.
 * - the facilitator has broadcast it but not confirmed it: ask once more after a
 *   pause, then "broadcast" with the first receipt. The money is already on its
 *   way, so the payer gets the answer. A second call that throws, or that comes
 *   back a different failure, cannot recall that transfer, so it is logged and
 *   the first answer stands.
 * - the first ask names a reason and no transaction: the chain is asked, a spent
 *   payment is "broadcast", and anything else is "unknown", never "refused". The
 *   reference facilitator answers that way whenever its transferWithAuthorization
 *   call throws, including an RPC that took the transfer and then timed out, so the
 *   answer is held against the payment rather than thrown away (review pass 6, V43).
 * - nobody can say (a thrown call, a reason in words): the chain is asked whether
 *   the payment was spent, and if it cannot say, the facilitator is asked once
 *   more after a pause. A spent payment is "broadcast"; a refusal on that second
 *   ask counts only when the chain says the payment was not spent, because a
 *   first call that did land makes the second one fail too. Otherwise "unknown":
 *   never "refused", because the payer may have been charged.
 *
 * Every transaction the facilitator names on the way is collected and handed to the chain check,
 * which reads those first and then the asset's own logs. `held` is a payment whose answer this
 * service already holds as unknown, sent again with the same file: the transactions named then are
 * carried into this attempt's proof.
 */
async function settleSequence(
  settle: () => Promise<ProcessSettleResultResponse>,
  charged: (transactions: readonly string[]) => Promise<boolean | undefined>,
  retryDelayMs: number,
  log: FastifyBaseLogger,
  where: Where,
  held: { transactions: readonly string[] } | undefined,
): Promise<Settlement> {
  const transactions: string[] = [...(held?.transactions ?? [])];
  const note = (attempted: Attempt): Attempt => {
    const hash = transactionOf(attempted);
    if (hash !== undefined && hash.length > 0 && !transactions.includes(hash)) {
      transactions.push(hash);
    }
    return attempted;
  };

  const first = note(await attempt(settle));

  if (first.kind === "settled") {
    return { state: "settled", headers: first.headers };
  }
  if (first.kind === "refused") {
    const reason = first.result.errorReason ?? "refused";
    if ((await charged(transactions)) === true) {
      log.warn({ ...where, reason }, "the payment landed although the facilitator refused it: serving its answer");
      return { state: "broadcast", headers: {} };
    }
    log.error({ ...where, reason, held: held !== undefined }, "settlement refused with no transaction: the answer is held against this payment");
    return { state: "unknown", reason, transactions };
  }

  if (first.kind === "broadcast") {
    log.warn({ ...where, transaction: first.result.transaction }, "settlement pending: asking the facilitator once more");
    await pause(retryDelayMs);
    const second = await attempt(settle);
    if (second.kind === "settled") {
      return { state: "settled", headers: second.headers };
    }
    if (second.kind !== "broadcast") {
      log.warn(
        { ...where, second: second.kind, transaction: first.result.transaction },
        "the second settle call did not confirm it; the broadcast transfer stands",
      );
    }
    // The authorisation is signed for this one amount and the transfer is on
    // chain, so it cannot be spent twice and the money lands when it confirms.
    // Cancelling here would throw away a transfer that is already on its way, and
    // withholding the answer would take the payment and give nothing back.
    return { state: "broadcast", headers: first.result.headers };
  }

  log.warn({ ...where, reason: first.reason }, "settlement outcome unknown: asking the chain, then the facilitator once more");
  if ((await charged(transactions)) === true) {
    return { state: "broadcast", headers: {} };
  }
  await pause(retryDelayMs);
  const second = note(await attempt(settle));
  if (second.kind === "settled") {
    return { state: "settled", headers: second.headers };
  }
  if (second.kind === "broadcast") {
    return { state: "broadcast", headers: second.result.headers };
  }
  const spent = await charged(transactions);
  if (spent === true) {
    return { state: "broadcast", headers: {} };
  }
  if (second.kind === "refused" && spent === false) {
    log.error({ ...where, reason: second.result.errorReason }, "payment did not settle");
    return {
      state: "refused",
      status: second.result.response.status,
      headers: second.result.response.headers,
      body: second.result.response.body ?? {},
    };
  }
  const reason = second.kind === "unknown" ? second.reason : (second.result.errorReason ?? "refused");
  log.error({ ...where, first: first.reason, second: reason }, "settlement outcome unknown: the answer is held against this payment");
  return { state: "unknown", reason, transactions };
}

/**
 * POST /verify/paid: the same answer as /verify, behind an x402 payment.
 *
 * It takes a multipart upload in a field named "file" only. The free route
 * also accepts a remote URL, and that path carries the checks that stop a
 * fetch from reaching a private address; rather than copy those checks and
 * risk the two copies drifting, the paid route does not offer it.
 *
 * The consent statement, the dispute fact, the re-check fact and the picture state are attached
 * before the payment is settled, so the body the facilitator sees and the copy kept against a
 * replayed payment are the same answer the payer is served. The reads for one passport start at
 * the same moment, so a caller never waits through one timeout and then another.
 *
 * A caller with no payment gets 402 and the payment terms. A caller whose
 * payment fails verification gets the facilitator's reason. Payment is settled
 * only after the match succeeds, so a failed verification never charges: a full
 * match gate answers 503 `busy` and a fault of this service 503 `service-fault`
 * with SERVICE_FAULT_REASON, as /verify does, and neither is settled or held. A
 * settlement the facilitator has broadcast but not yet confirmed is asked about
 * once more, then answered with the verification and a pending receipt. A
 * settlement whose outcome nobody can tell answers 502 settlement-unknown and is
 * never cancelled; the answer is kept against the payment and handed over when
 * the same payment and file come back and the pay asset itself shows the payment
 * spent. That check runs before the facilitator is asked about the repeat, because
 * the facilitator refuses a spent nonce (review pass 6, V43).
 *
 * A payment that already bought an answer is given that same answer back rather
 * than being settled a second time, but only to a request carrying that very
 * payment, every signed field and the signature, and the same file (V7). It is
 * kept under the payer and the nonce together (V48); both are public on chain
 * once the transfer settles, so they open nothing on their own.
 *
 * One payment buys one answer, for one file (review pass 7, V60). The payer and
 * the nonce are marked in flight once the upload is read and before the
 * facilitator is asked, and a second request carrying them meanwhile answers 409
 * `payment-in-flight` without the facilitator hearing of it. The whole payment is
 * public in the calldata of the transfer that settles it, so the mark waits for the
 * upload: a caller trickling a body under someone else's payment holds nothing
 * (review pass 9, V84). For the same reason a remembered payment sent with another
 * file is answered exactly as a payment this service never saw, through the normal
 * payment check, which refuses a spent nonce, so the answer never says which file
 * the payment was for. It never serves that other file, and no request ever
 * replaces an entry that holds the answer about another file.
 *
 * The route is mounted only when X402_ENABLED is true. Otherwise the path does
 * not exist and the service answers 404.
 */
export async function verifyPaidRoutes(
  app: FastifyInstance,
  options: {
    payments: x402HTTPResourceServer;
    settlementRetryDelayMs?: number;
    ledger?: PaymentLedger;
    /** Replaces the chain read that says whether a payment was spent. Under a test runner the default answers undefined. */
    charged?: ChargedCheck;
    /** Replaces the read of the chain's newest block, where a proof search starts. Under a test runner the default answers undefined. */
    head?: () => Promise<bigint | undefined>;
  },
): Promise<void> {
  assertPaidRoute(app);

  const { payments } = options;
  const retryDelayMs = options.settlementRetryDelayMs ?? PENDING_SETTLEMENT_RETRY_MS;
  const ledger = options.ledger ?? paymentLedger();
  const charged: ChargedCheck = options.charged ?? (env.NODE_ENV === "test" ? async () => undefined : chainCharged());
  const head = options.head ?? (env.NODE_ENV === "test" ? async () => undefined : liveHead());
  let ready: Promise<void> | undefined;
  // Payer and nonce of every payment a request is working on right now, taken once the upload is
  // read and before the facilitator is asked, so two requests can never settle one payment side by
  // side and nobody holds a payer's repeat off by sending a body slowly.
  const inFlight = new Set<string>();

  /** Writes an entry, but never over one that holds the answer about another file (review pass 7, V60). */
  const keep = (key: string, entry: Omit<LedgerEntry, "at">, log: FastifyBaseLogger, where: Where): void => {
    const existing = ledger.get(key);
    if (existing !== undefined && existing.upload !== entry.upload) {
      log.warn({ ...where, state: existing.state }, "kept the answer this payment holds for another file");
      return;
    }
    ledger.remember(key, entry);
  };

  // Wrapped so the upload share comes back when this handler ends, the way /verify gives its own back
  // in a finally, rather than through the handler-end backstop in shared.ts.
  app.post(PAID_VERIFY_PATH, givesUploadsBack(async (request: FastifyRequest, reply: FastifyReply) => {
    const context = contextFor(request);
    const where: Where = { ip: request.ip, url: request.url };
    const offered = offeredPayment(context);
    if (offered === undefined) {
      return await answer(request, reply, context, where, undefined, undefined);
    }
    let bytes: Buffer;
    try {
      bytes = await readUpload(request);
    } catch (error) {
      if (error instanceof CallerGone) {
        return callerGone(request, reply, where);
      }
      const status = statusOf(error);
      return reply.code(status).send({ error: safeReason(error) });
    }
    // Checked and taken in the same tick, with no await between, so a second request cannot slip in.
    if (inFlight.has(offered.key)) {
      request.log.warn(where, "rejected: this payment is in flight on another request");
      return reply.code(409).send({ error: "payment-in-flight", reason: PAYMENT_IN_FLIGHT_REASON });
    }
    inFlight.add(offered.key);
    try {
      return await answer(request, reply, context, where, offered, bytes);
    } finally {
      inFlight.delete(offered.key);
    }
  }));

  async function answer(
    request: FastifyRequest,
    reply: FastifyReply,
    context: HTTPRequestContext,
    where: Where,
    offered: PaymentIdentity | undefined,
    uploaded: Buffer | undefined,
  ): Promise<FastifyReply> {
    // Read already when a payment was offered, and otherwise only once the payment is verified.
    let bytes = uploaded;
    let held: { transactions: readonly string[]; since?: bigint } | undefined;
    // Set when this payment already bought an answer about another file: this request then goes
    // the way an unknown payment goes, and is never served.
    let otherFile = false;
    if (offered !== undefined && bytes !== undefined) {
      const seen = ledger.get(offered.key);
      if (seen !== undefined && seen.payment === offered.identity) {
        const replay = await replayFor(seen, bytes, charged);
        otherFile = replay.kind === "other-file";
        if (replay.kind === "serve") {
          request.log.info({ ...where, state: replay.entry.state }, "replayed: this payment already bought an answer");
          if (replay.entry !== seen) {
            ledger.remember(offered.key, replay.entry);
          }
          return reply.headers(replay.entry.headers).send(replay.entry.payload);
        }
        // The payment goes through as new, and the held answer is never let go on a "not spent"
        // read: that read is also what a first transfer still pending looks like, so the answer
        // stays held until a new settle replaces it or its ten minutes run out (review pass 5,
        // answers #6). Another file carries none of the held proof: it goes as a stranger would.
        if (!otherFile) {
          const proof = proofOf(seen);
          held = { transactions: proof?.transactions ?? [], since: proof?.since };
        }
      }
    }

    try {
      ready = ready ?? payments.initialize();
      await ready;
    } catch (error) {
      ready = undefined;
      const reason = safeReason(error);
      request.log.error({ ...where, reason }, "rejected: x402 facilitator unreachable");
      return reply.code(502).send({ error: `the payment facilitator did not answer: ${reason}` });
    }

    let processed;
    try {
      processed = await payments.processHTTPRequest(context);
    } catch (error) {
      const reason = safeReason(error);
      request.log.error({ ...where, reason }, "rejected: x402 could not read the payment");
      return reply.code(502).send({ error: `the payment could not be checked: ${reason}` });
    }

    if (processed.type === "payment-error") {
      const { status, headers, body } = processed.response;
      request.log.warn({ ...where, status }, "rejected: payment required");
      return reply.code(status).headers(headers).send(body ?? {});
    }

    if (processed.type !== "payment-verified") {
      // x402 found nothing to collect on a route that exists only to collect,
      // which means its route table and the mounted path disagree. Serving the
      // answer here would give the work away free, so the route fails shut and
      // the configuration gets fixed instead.
      request.log.error(
        { ...where, route: request.routeOptions.url, result: processed.type },
        "rejected: the paid route is not under the x402 payment table",
      );
      return reply.code(500).send({ error: "payment-misconfigured" });
    }

    const verified = processed;

    let payload: { result: unknown; manifest: unknown; index: IndexState };
    try {
      bytes = bytes ?? (await readUpload(request));
      const answer = { ...(await verifyBytes(app, bytes)), index: app.verifier.indexState() };
      payload = await withPassportFacts(
        answer,
        app.verifier.consent,
        app.verifier.dispute,
        app.verifier.lookupExact,
        app.verifier.picture,
      );
    } catch (error) {
      const status = statusOf(error);
      const reason = safeReason(error);
      await verified.cancellationDispatcher.cancel({ reason: "handler_failed", responseStatus: status });
      if (error instanceof CallerGone) {
        return callerGone(request, reply, where);
      }
      request.log.warn({ ...where, status, reason }, "rejected: /verify/paid");
      // The same two 503 answers /verify gives, so a payer is told in the same words that the
      // picture is fine and the retry is theirs to make.
      if (error instanceof ServiceFault) {
        return reply.code(503).send({ error: "service-fault", reason: SERVICE_FAULT_REASON });
      }
      return reply.code(status).send({ error: status === 503 ? "busy" : reason });
    }

    // Read before the first settle, so no transfer this settle starts can sit below it. A held
    // payment keeps the block read when it was first settled, since its transfer may be older, and
    // one held with no block keeps none: a later head could sit past its transfer (review pass 9, V83).
    const since = held !== undefined ? held.since : await head();
    const settlement = await settleSequence(
      async () =>
        payments.processSettlement(
          verified.paymentPayload,
          verified.paymentRequirements,
          verified.declaredExtensions,
          { request: context, responseBody: Buffer.from(JSON.stringify(payload)) },
        ),
      async (transactions) => await charged(verified.paymentPayload, verified.paymentRequirements, transactions, since),
      retryDelayMs,
      request.log,
      where,
      held,
    );

    if (settlement.state === "refused") {
      return reply.code(settlement.status).headers(settlement.headers).send(settlement.body);
    }

    // The ledger is keyed by the payment the facilitator verified, never by the header's own word.
    const paid = identityOf(verified.paymentPayload);
    const upload = sha256Hex(bytes);
    const unknownAnswer = (): FastifyReply =>
      reply.code(502).send({
        error: "settlement-unknown",
        reason:
          "the payment facilitator did not say whether your payment went through. Nothing was cancelled. Send the same payment with the same file again: once the chain shows the payment, the answer it bought is handed over, and a payment that never happened is not taken twice.",
      });

    if (settlement.state === "unknown") {
      if (paid !== undefined) {
        keep(paid.key, {
          state: "unknown",
          payload,
          headers: {},
          payment: paid.identity,
          upload,
          proof: {
            payment: verified.paymentPayload,
            requirements: verified.paymentRequirements,
            transactions: settlement.transactions,
            since,
          } satisfies HeldProof,
        }, request.log, where);
      }
      return unknownAnswer();
    }

    // A transfer still pending for the file this payment first came with can prove this settle
    // too, and some facilitators answer a nonce they already broadcast with that same transaction.
    // Either way the one payment bought the other file's answer, so this file is never served, and
    // it hears what a settle nobody could confirm hears (review pass 9, V84).
    const existing = paid === undefined ? undefined : ledger.get(paid.key);
    if (otherFile || (existing !== undefined && existing.upload !== upload)) {
      request.log.warn({ ...where, state: existing?.state }, "rejected: this payment already bought an answer for another file");
      return unknownAnswer();
    }

    if (paid !== undefined) {
      keep(
        paid.key,
        {
          state: settlement.state === "settled" ? "settled" : "pending",
          payload,
          headers: settlement.headers,
          payment: paid.identity,
          upload,
        },
        request.log,
        where,
      );
    }

    reply.headers(settlement.headers);
    return reply.send(payload);
  }
}

/**
 * A payer who hung up before the answer was ready: nothing is settled, and the 499 reaches nobody.
 * The same status and word /verify answers a caller who left with.
 */
function callerGone(request: FastifyRequest, reply: FastifyReply, where: Where): FastifyReply {
  request.log.warn(where, "/verify/paid: the caller left before the answer was ready");
  return reply.code(499).send({ error: "client-gone" });
}

/**
 * What a repeat of a remembered payment gets from memory, and why when it gets nothing.
 *
 * "serve" hands the entry over: the file is the one the answer is about, and the payment is known
 * to be spent, which for an answer held back as unknown means the chain shows it now; that entry
 * comes back marked settled so the chain is not asked again. "other-file" is the right payment
 * with the wrong file. "not-spent" is the chain answering that the payment is not spent yet, which
 * a first transfer still pending also reads as, and "cannot-tell" is a chain read that failed or a
 * held entry with no proof to ask about. Neither lets the held answer go.
 */
type Replay =
  | { kind: "serve"; entry: LedgerEntry }
  | { kind: "other-file" }
  | { kind: "not-spent" }
  | { kind: "cannot-tell" };

/** What an answer held as unknown keeps so the chain can be asked about it later. */
interface HeldProof {
  payment: PaymentPayload;
  requirements: PaymentRequirements;
  /** Every transaction the facilitator named for this payment, read before the asset's logs. */
  transactions: string[];
  /**
   * The newest block when the payment was first settled, where the log search starts. Undefined
   * when that read failed, and then kept undefined, so the search starts from validAfter.
   */
  since: bigint | undefined;
}

function proofOf(entry: LedgerEntry): HeldProof | undefined {
  return entry.proof as HeldProof | undefined;
}

async function replayFor(seen: LedgerEntry, bytes: Buffer, charged: ChargedCheck): Promise<Replay> {
  if (sha256Hex(bytes) !== seen.upload) {
    return { kind: "other-file" };
  }
  if (seen.state !== "unknown") {
    return { kind: "serve", entry: seen };
  }
  const proof = proofOf(seen);
  if (proof === undefined) {
    return { kind: "cannot-tell" };
  }
  const spent = await charged(proof.payment, proof.requirements, proof.transactions ?? [], proof.since);
  if (spent === true) {
    return { kind: "serve", entry: { ...seen, state: "settled" } };
  }
  return spent === false ? { kind: "not-spent" } : { kind: "cannot-tell" };
}

/** The chain's newest block through the service's own client, or undefined when the read fails. */
function liveHead(): () => Promise<bigint | undefined> {
  const chain = readClient();
  return async () => {
    try {
      return await chain.getBlockNumber();
    } catch {
      return undefined;
    }
  };
}
