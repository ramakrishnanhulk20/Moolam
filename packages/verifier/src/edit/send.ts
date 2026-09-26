import type { AuthorizationContext, PrivyClient } from "@privy-io/node";
import { WaitForTransactionReceiptTimeoutError, type Hex, type PublicClient } from "viem";
import { caip2, privyErrorText } from "../generate/privy.js";

/** A 32 byte transaction hash. Privy sends an empty string when the hash is not known yet. */
const TX_HASH = /^0x[0-9a-f]{64}$/i;

/** The statuses Privy reports for a transaction that will never produce a usable hash. */
const DEAD_STATUSES = new Set<string>([
  "execution_reverted",
  "failed",
  "replaced",
  "provider_error",
]);

/** How long a sponsored send is given to report its hash, and how often Privy is asked. */
const SPONSORED_WAIT_MS = 60_000;
const SPONSORED_POLL_MS = 1_000;

/** How long a caller waits for the receipt of a send that already has a hash. */
export const RECEIPT_WAIT_MS = 30_000;

/** Privy accepted the send and then reported it dead: reverted, failed, replaced, or a provider error. */
export class SponsoredSendFailed extends Error {
  readonly transactionId: string;
  readonly status: string;
  /** Present when Privy already knew the hash of the transaction it then called dead. */
  readonly hash?: Hex;

  constructor(transactionId: string, status: string, hash?: Hex) {
    super(
      `Privy transaction ${transactionId} ended as ${status}${hash === undefined ? "" : ` (${hash})`}.`,
    );
    this.name = "SponsoredSendFailed";
    this.transactionId = transactionId;
    this.status = status;
    this.hash = hash;
  }
}

/**
 * The wait ran out before Privy reported a hash.
 *
 * The send may still land, so a caller that sees this must check the chain before sending the
 * same transaction again. Resending blind is what turned one stalled bind into a revert.
 */
export class SponsoredSendPending extends Error {
  readonly transactionId: string;

  constructor(transactionId: string, waitedMs: number) {
    super(
      `Privy transaction ${transactionId} still had no hash after ${Math.round(waitedMs / 1000)} seconds. It may still land, so do not send the same transaction again without checking the chain.`,
    );
    this.name = "SponsoredSendPending";
    this.transactionId = transactionId;
  }
}

/** Where a failed poll is reported. A Fastify request logger fits this shape, and so does the console. */
export interface PollLog {
  warn: (details: Record<string, unknown>, message: string) => void;
}

/** The fields of a Privy transaction record this module reads. */
export interface TransactionRecord {
  status: string;
  transaction_hash: string | null;
  sponsored?: boolean;
}

const CONSOLE_LOG: PollLog = {
  warn: (details, message) => console.warn(message, details),
};

export interface AwaitHashOptions {
  timeoutMs?: number;
  pollMs?: number;
  log?: PollLog;
  /** Each record a poll came back with, so a caller can read fields the hash alone does not carry. */
  onRecord?: (record: TransactionRecord) => void;
}

/**
 * Waits for the transaction hash of a send Privy accepted but answered without one.
 *
 * Privy's sponsored path submits through its own relayer, so the reply can carry only a
 * transaction id. Polling the transactions endpoint is the only way to learn the hash.
 *
 * A dead status is read before the hash, because Privy fills the hash in on a transaction that
 * reverted or was replaced as well as on one that landed, and handing that hash back would report
 * a failure as a success. Throws SponsoredSendFailed for a dead status and SponsoredSendPending
 * when the window closes with the transaction still in flight. A poll that itself fails, which is
 * Privy having a bad minute rather than the send going wrong, is logged and asked again on the
 * next tick.
 *
 * The client is a parameter rather than a module import because the same code serves the hosted
 * verify service and the proof scripts, and each of those builds its own Privy client.
 */
export async function awaitPrivyHash(
  client: PrivyClient,
  transactionId: string,
  options: AwaitHashOptions = {},
): Promise<Hex> {
  const timeoutMs = options.timeoutMs ?? SPONSORED_WAIT_MS;
  const pollMs = options.pollMs ?? SPONSORED_POLL_MS;
  const log = options.log ?? CONSOLE_LOG;
  const giveUpAt = Date.now() + timeoutMs;

  for (;;) {
    try {
      const transaction = await client.transactions().get(transactionId);
      options.onRecord?.(transaction);
      const reported = transaction.transaction_hash ?? "";
      const hash = TX_HASH.test(reported) ? (reported as Hex) : undefined;
      if (DEAD_STATUSES.has(transaction.status)) {
        throw new SponsoredSendFailed(transactionId, transaction.status, hash);
      }
      if (hash !== undefined) return hash;
    } catch (error) {
      if (error instanceof SponsoredSendFailed) throw error;
      log.warn(
        { transactionId, reason: privyErrorText(error) },
        "sponsored send: the status poll failed, asking again on the next tick",
      );
    }
    if (Date.now() >= giveUpAt) throw new SponsoredSendPending(transactionId, timeoutMs);
    await sleep(pollMs);
  }
}

export interface SendOptions {
  to: Hex;
  data?: Hex;
  value?: bigint;
  gasLimit: bigint;
  chainId: number;
  sponsor?: boolean;
  /** Whose key asks Privy to sign: the wallet owner, or a signer added to the wallet. */
  context: AuthorizationContext;
  /** Where a failed status poll is reported while this waits for a hash. */
  log?: PollLog;
}

export interface SentTransaction {
  hash: Hex;
  sponsored: boolean;
  /** Privy's own id for the send, which outlives a missing hash and identifies it in support. */
  transactionId?: string;
  /** Present when Privy routed the send through an account abstraction user operation. */
  userOperationHash?: string;
}

/**
 * Sends one transaction from a Privy wallet.
 *
 * The gas limit is always explicit because Monad charges the limit, not the amount used, so a
 * library default would quietly overpay. Value defaults to zero: nothing in this flow moves MON.
 * Throws whatever Privy threw, including a policy refusal, so the caller can report it exactly.
 * When Privy answers with no hash, which is what its sponsored relayer does, this waits for the
 * hash rather than handing back an empty string for the caller to wait on forever.
 *
 * Whether gas was sponsored is read off the transaction record when there was one to read, since
 * Privy is the only party that knows whether its paymaster took the bill.
 */
export async function sendFromWallet(
  client: PrivyClient,
  walletId: string,
  options: SendOptions,
): Promise<SentTransaction> {
  const response = await client
    .wallets()
    .ethereum()
    .sendTransaction(walletId, {
      caip2: caip2(options.chainId),
      params: {
        transaction: {
          to: options.to,
          data: options.data ?? "0x",
          value: toHex(options.value ?? 0n),
          chain_id: options.chainId,
          gas_limit: toHex(options.gasLimit),
        },
      },
      ...(options.sponsor ? { sponsor: true } : {}),
      authorization_context: options.context,
    });

  const settled: SentTransaction = {
    hash: response.hash as Hex,
    sponsored: options.sponsor === true,
    transactionId: response.transaction_id,
    userOperationHash: response.user_operation_hash,
  };
  if (TX_HASH.test(response.hash ?? "")) return settled;

  if (!settled.transactionId) {
    throw new Error(
      `Privy answered the send from wallet ${walletId} with neither a transaction hash nor a transaction id, so there is nothing to wait on.`,
    );
  }

  let sponsored = settled.sponsored;
  const hash = await awaitPrivyHash(client, settled.transactionId, {
    timeoutMs: SPONSORED_WAIT_MS,
    pollMs: SPONSORED_POLL_MS,
    log: options.log,
    onRecord: (record) => {
      if (typeof record.sponsored === "boolean") sponsored = record.sponsored;
    },
  });
  return { ...settled, hash, sponsored };
}

/** One event in a receipt, in the two fields a caller checks: which contract, and its topics. */
export interface ReceiptLog {
  address: Hex;
  topics: readonly Hex[];
}

/** How the chain settled a send: it landed, or it landed and reverted. */
export interface SendReceipt {
  status: "success" | "reverted";
  /** The revert reason when the node volunteered one. Most nodes do not. */
  reason?: string;
  /**
   * Every event the transaction emitted. A sponsored send lands as a bundle whose status is success
   * even when the call inside it reverted, so the caller's own contract event is what says it ran.
   */
  logs: ReceiptLog[];
}

/**
 * Waits for the receipt of a transaction that already has a hash, for a bounded time.
 *
 * A hash means Privy broadcast something, not that the chain accepted it, so a caller that
 * reports success on the hash alone reports reverts as wins. A success status is not enough either
 * for a sponsored send, so the receipt's events come back too. Answers undefined when the receipt
 * did not arrive inside the wait, which means the outcome is unknown rather than bad.
 */
export async function awaitReceipt(
  client: Pick<PublicClient, "waitForTransactionReceipt">,
  hash: Hex,
  timeoutMs: number = RECEIPT_WAIT_MS,
): Promise<SendReceipt | undefined> {
  try {
    const receipt = await client.waitForTransactionReceipt({ hash, timeout: timeoutMs });
    const volunteered = (receipt as { revertReason?: unknown }).revertReason;
    return {
      status: receipt.status === "success" ? "success" : "reverted",
      reason: typeof volunteered === "string" && volunteered.length > 0 ? volunteered : undefined,
      logs: receipt.logs.map((log) => ({ address: log.address, topics: log.topics })),
    };
  } catch (error) {
    if (error instanceof WaitForTransactionReceiptTimeoutError) return undefined;
    throw error;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toHex(value: bigint): Hex {
  return `0x${value.toString(16)}`;
}
