import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { generateP256KeyPair, type AuthorizationContext } from "@privy-io/node";
import {
  grantSigner,
  removeAllSigners,
  signerIds,
  walletSigners,
} from "@moolam/verifier/src/edit/signers.js";
import type { Hex } from "viem";
import { ownerContext, privy } from "./client.js";
import { readStore, sendFromWallet, updateStore } from "./serverWallet.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = join(HERE, "..", "..");

/** The app's session key. Privy never sees the private half, and neither does the console. */
const KEY_FILE = join(PACKAGE_ROOT, ".moolam", "session-signer.json");

interface StoredKey {
  privateKey: string;
  publicKey: string;
}

export interface SessionSigner {
  keyQuorumId: string;
  policyId?: string;
}

/**
 * Makes sure this app has a session signing key registered with Privy as a one of one key quorum.
 *
 * The key is generated here on first run and kept in the gitignored .moolam folder. It is a
 * different key from the wallet owner's, which is the whole point: what a creator grants us can
 * be taken away without touching who owns the wallet.
 */
export async function ensureSessionSigner(): Promise<SessionSigner> {
  const stored = readStore().sessionSigner;
  if (stored) {
    try {
      await privy().keyQuorums().get(stored.keyQuorumId);
      return stored;
    } catch {
      // The quorum was deleted on the Privy side, so register the key again below.
    }
  }

  const key = readKey() ?? writeKey(await generateP256KeyPair());
  const quorum = await privy().keyQuorums().create({
    public_keys: [key.publicKey],
    display_name: "moolam-edit-session",
    authorization_threshold: 1,
  });

  const signer: SessionSigner = { keyQuorumId: quorum.id };
  updateStore({ sessionSigner: signer });
  return signer;
}

/** The authorization context that signs as the session key rather than as the wallet owner. */
export function sessionContext(): AuthorizationContext {
  const key = readKey();
  if (!key) {
    throw new Error(`No session signing key at ${KEY_FILE}. Run the proof again to create one.`);
  }
  return { authorization_private_keys: [key.privateKey] };
}

/**
 * Grants this app standing permission to sign on the creator's wallet, scoped by a policy.
 *
 * This is the server side of what the browser SDK calls addSigners: the wallet owner authorizes
 * the change, and the signer can only do what its override policy allows.
 */
export async function grantSessionSigner(
  walletId: string,
  signer: SessionSigner,
): Promise<string[]> {
  return signerIds(
    await grantSigner(
      privy(),
      walletId,
      { signerId: signer.keyQuorumId, policyId: signer.policyId },
      ownerContext(),
    ),
  );
}

/**
 * Takes the permission back. Privy's browser SDK removes every signer in one call and this is the
 * server equivalent: the owner keeps the wallet, the app loses the ability to sign on it.
 */
export async function revokeSessionSigners(walletId: string): Promise<string[]> {
  return signerIds(await removeAllSigners(privy(), walletId, ownerContext()));
}

/** Who Privy currently accepts as a signer on a wallet, read from the live API. */
export async function currentSigners(walletId: string): Promise<string[]> {
  return signerIds(await walletSigners(privy(), walletId));
}

export interface EditCall {
  to: Hex;
  data: Hex;
  gasLimit: bigint;
  chainId: number;
}

/**
 * Sends an appendEdit from the creator's wallet using the session key.
 *
 * Nothing here proves the permission by itself: Privy checks that the key quorum is still listed
 * on that wallet, and refuses otherwise, which is what the last step of the proof relies on.
 */
export async function appendEditAsSessionSigner(
  walletId: string,
  call: EditCall,
): Promise<{ hash: Hex }> {
  const sent = await sendFromWallet(walletId, {
    to: call.to,
    data: call.data,
    gasLimit: call.gasLimit,
    chainId: call.chainId,
    context: sessionContext(),
  });
  return { hash: sent.hash };
}

function readKey(): StoredKey | undefined {
  try {
    return JSON.parse(readFileSync(KEY_FILE, "utf8")) as StoredKey;
  } catch {
    return undefined;
  }
}

function writeKey(key: StoredKey): StoredKey {
  mkdirSync(dirname(KEY_FILE), { recursive: true });
  writeFileSync(KEY_FILE, `${JSON.stringify(key, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  chmodSync(KEY_FILE, 0o600);
  return key;
}
