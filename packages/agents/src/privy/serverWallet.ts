import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AuthorizationContext } from "@privy-io/node";
import type { Hex } from "viem";
import { caip2, ownerContext, ownerPublicKey, privy } from "./client.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = join(HERE, "..", "..");

/** Wallet ids and addresses survive between runs here. The folder is gitignored. */
export const STORE_FILE = join(PACKAGE_ROOT, ".moolam", "wallets.json");

export interface StoredWallet {
  id: string;
  address: Hex;
  policyId?: string;
  agentId?: string;
}

export interface WalletStore {
  generator?: StoredWallet;
  creator?: StoredWallet;
  sessionSigner?: { keyQuorumId: string; policyId?: string };
}

export type WalletName = "generator" | "creator";

/** Reads the local record of what this app has already created on Privy. */
export function readStore(): WalletStore {
  try {
    return JSON.parse(readFileSync(STORE_FILE, "utf8")) as WalletStore;
  } catch {
    return {};
  }
}

/** Merges one change into the local record and writes it back. */
export function updateStore(patch: Partial<WalletStore>): WalletStore {
  const merged = { ...readStore(), ...patch };
  mkdirSync(dirname(STORE_FILE), { recursive: true });
  writeFileSync(STORE_FILE, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
  return merged;
}

export interface WalletOptions {
  policyIds?: string[];
}

/**
 * Finds the wallet this app created under a local name, or creates it.
 *
 * The wallet's owner is the authorization key in the root .env, which is what lets this server
 * ask Privy's enclave to sign later. Privy holds the key shares; this machine never sees them.
 * A cached id is checked against the live API first, so a wallet deleted in the dashboard is
 * recreated rather than used as a dead handle.
 */
export async function getOrCreateWallet(
  name: WalletName,
  options: WalletOptions = {},
): Promise<{ wallet: StoredWallet; created: boolean }> {
  const store = readStore();
  const cached = store[name];
  if (cached) {
    try {
      const live = await privy().wallets().get(cached.id);
      return { wallet: { ...cached, address: live.address as Hex }, created: false };
    } catch {
      // The id no longer resolves on this Privy app, so fall through and create a fresh wallet.
    }
  }

  const created = await privy()
    .wallets()
    .create({
      chain_type: "ethereum",
      display_name: `moolam-${name}`,
      owner: { public_key: ownerPublicKey() },
      ...(options.policyIds ? { policy_ids: options.policyIds } : {}),
    });

  const wallet: StoredWallet = {
    id: created.id,
    address: created.address as Hex,
    ...(options.policyIds?.[0] ? { policyId: options.policyIds[0] } : {}),
  };
  updateStore({ [name]: wallet } as Partial<WalletStore>);
  return { wallet, created: true };
}

/**
 * Sets the policies Privy enforces on an existing wallet, including clearing them.
 *
 * The generator needs both directions: no policy while it mints its own agent identity, since
 * the policy forbids calls to any other contract, then the policy on for good.
 */
export async function setWalletPolicies(walletId: string, policyIds: string[]): Promise<void> {
  await privy().wallets().update(walletId, {
    policy_ids: policyIds,
    authorization_context: ownerContext(),
  });
}

/** The policy ids Privy currently enforces on a wallet, read from the live API. */
export async function walletPolicyIds(walletId: string): Promise<string[]> {
  const wallet = await privy().wallets().get(walletId);
  return wallet.policy_ids ?? [];
}

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
 */
export async function awaitPrivyHash(
  transactionId: string,
  options: AwaitHashOptions = {},
): Promise<Hex> {
  const timeoutMs = options.timeoutMs ?? SPONSORED_WAIT_MS;
  const pollMs = options.pollMs ?? SPONSORED_POLL_MS;
  const giveUpAt = Date.now() + timeoutMs;

  for (;;) {
    const transaction = await privy().transactions().get(transactionId);
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
  /** Whose key asks Privy to sign: the wallet owner, or a session signer added to the wallet. */
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
  walletId: string,
  options: SendOptions,
): Promise<SentTransaction> {
  const response = await privy()
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
    hash: await awaitPrivyHash(settled.transactionId, {
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
