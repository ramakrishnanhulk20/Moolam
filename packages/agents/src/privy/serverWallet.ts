import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Hex } from "viem";
import {
  awaitPrivyHash as awaitHash,
  sendFromWallet as send,
  type AwaitHashOptions,
  type SendOptions,
  type SentTransaction,
} from "@moolam/verifier/src/edit/send.js";
import { ownerContext, ownerPublicKey, privy } from "./client.js";

// One implementation of the send lives in the verify service, so these names stay here and every
// script and caller in this package keeps the signatures it already uses.
export {
  SponsoredSendFailed,
  SponsoredSendPending,
  type AwaitHashOptions,
  type SendOptions,
  type SentTransaction,
} from "@moolam/verifier/src/edit/send.js";

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

/**
 * Sends one transaction from a Privy wallet, as the holder of whichever key the context names.
 *
 * The work itself lives in the verify service, so the hosted /edit route and these scripts send
 * the same way and handle a sponsored reply with no hash the same way. Only the client differs:
 * this package builds its own from the root .env.
 */
export function sendFromWallet(walletId: string, options: SendOptions): Promise<SentTransaction> {
  return send(privy(), walletId, options);
}

/** Waits for the hash of a sponsored send Privy accepted without one. */
export function awaitPrivyHash(transactionId: string, options: AwaitHashOptions = {}): Promise<Hex> {
  return awaitHash(privy(), transactionId, options);
}
