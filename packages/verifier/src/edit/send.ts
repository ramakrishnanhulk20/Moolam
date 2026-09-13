import type { AuthorizationContext, PrivyClient } from "@privy-io/node";
import type { Hex } from "viem";
import { caip2 } from "../generate/privy.js";

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

/** Privy accepted the send and then reported it dead: reverted, failed, replaced, or a provider error. */
export class SponsoredSendFailed extends Error {
  readonly transactionId: string;
  readonly status: string;

  constructor(transactionId: string, status: string) {
    super(`Privy transaction ${transactionId} ended as ${status}.`);
    this.name = "SponsoredSendFailed";
    this.transactionId = transactionId;
    this.status = status;
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

export interface AwaitHashOptions {
  timeoutMs?: number;
  pollMs?: number;
}

/**
 * Waits for the transaction hash of a send Privy accepted but answered without one.
 *
 * Privy's sponsored path submits through its own relayer, so the reply can carry only a
 * transaction id. Polling the transactions endpoint is the only way to learn the hash.
 * Throws SponsoredSendFailed when Privy reports the transaction dead, and SponsoredSendPending
 * when the timeout passes with the transaction still in flight.
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
  const giveUpAt = Date.now() + timeoutMs;

  for (;;) {
    const transaction = await client.transactions().get(transactionId);
    const hash = transaction.transaction_hash ?? "";
    if (TX_HASH.test(hash)) return hash as Hex;
    if (DEAD_STATUSES.has(transaction.status)) {
      throw new SponsoredSendFailed(transactionId, transaction.status);
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
  return {
    ...settled,
    hash: await awaitPrivyHash(client, settled.transactionId, {
      timeoutMs: SPONSORED_WAIT_MS,
      pollMs: SPONSORED_POLL_MS,
    }),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toHex(value: bigint): Hex {
  return `0x${value.toString(16)}`;
}
