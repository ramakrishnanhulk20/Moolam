import {
  ServerPasskey,
  registerAsPlatform,
  resumeCosign,
  rpIdProblem,
  startCosign,
  transferPassport,
  type AgentAccount,
  type AiUseTerms,
  type ChainReader,
  type CosignHandle,
  type PassportTransfer,
  type PlatformRegistration,
  type PlatformWalletClient,
} from "@moolam/platform";
import { createPublicClient, createWalletClient, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { monad } from "viem/chains";
import { EnvError, env } from "./env";

/**
 * The Moolam platform kit wired to Dreamloom's secrets. The platform key and every private key are
 * read here and stay here (D3): nothing this module exports returns one, and it logs nothing. What
 * goes out is the kit's own results, which carry passport ids, transaction hashes and addresses.
 */

interface Kit {
  verifyUrl: string;
  siteUrl: string;
  platformKey: string;
  /** One wallet is both the ERC-8004 agent's owner and the creator wallet the passkey is bound to. */
  account: AgentAccount;
  walletClient: PlatformWalletClient;
  publicClient: ChainReader;
  passkey: ServerPasskey;
}

let kit: Kit | null | undefined;

/**
 * Builds the kit once, or returns null when a setting it needs is missing, which production never
 * reaches because env() refuses to start without them.
 *
 * Throws EnvError for a passkey key or relying party id the kit refuses.
 */
function load(): Kit | null {
  if (kit !== undefined) return kit;
  const e = env();
  const verifyUrl = e.MOOLAM_VERIFY_URL;
  const siteUrl = e.MOOLAM_SITE_URL;
  const rpcUrl = e.MONAD_RPC_URL;
  const walletKey = e.DREAMLOOM_WALLET_KEY;
  const passkeyKey = e.DREAMLOOM_PASSKEY_KEY;
  const rpId = e.DREAMLOOM_PASSKEY_RP_ID;
  const platformKey = e.DREAMLOOM_PLATFORM_KEY;
  if (
    verifyUrl === undefined ||
    siteUrl === undefined ||
    rpcUrl === undefined ||
    walletKey === undefined ||
    passkeyKey === undefined ||
    rpId === undefined ||
    platformKey === undefined
  ) {
    kit = null;
    return kit;
  }
  if (rpIdProblem(rpId) !== null) {
    throw new EnvError(["DREAMLOOM_PASSKEY_RP_ID"]);
  }
  let passkey: ServerPasskey;
  try {
    passkey = ServerPasskey.fromPrivateKey(passkeyKey as Hex, rpId);
  } catch {
    throw new EnvError(["DREAMLOOM_PASSKEY_KEY"]);
  }
  const account = privateKeyToAccount(walletKey as Hex);
  const transport = http(rpcUrl);
  kit = {
    verifyUrl,
    siteUrl,
    platformKey,
    // Dreamloom and the kit each carry viem 2.57.1, and TypeScript will not match signTypedData's
    // generics across two copies of the same file; at run time it is the same function.
    account: account as unknown as AgentAccount,
    walletClient: createWalletClient({ account, chain: monad, transport }) as PlatformWalletClient,
    publicClient: createPublicClient({ chain: monad, transport }) as ChainReader,
    passkey,
  };
  return kit;
}

/** Whether every setting the kit needs is present, so a route can close before it counts anything. */
export function kitReady(): boolean {
  return load() !== null;
}

function ready(): Kit {
  const k = load();
  if (k === null) throw new Error("the platform kit is not configured");
  return k;
}

/** Platform mode: Dreamloom's agent makes it, its passkey signs as creator, its wallet sends and holds. */
export async function registerPicture(file: Uint8Array, title: string, terms: AiUseTerms): Promise<PlatformRegistration> {
  const k = ready();
  return await registerAsPlatform(file, {
    verifyUrl: k.verifyUrl,
    platformKey: k.platformKey,
    agentAccount: k.account,
    passkey: k.passkey,
    walletClient: k.walletClient,
    title,
    terms,
  });
}

/** Co-sign mode: the verify service freezes the picture and the kit returns the link for the visitor. */
export async function openCosign(file: Uint8Array, title: string, terms: AiUseTerms): Promise<CosignHandle> {
  const k = ready();
  return await startCosign(file, {
    verifyUrl: k.verifyUrl,
    platformKey: k.platformKey,
    agentAccount: k.account,
    publicClient: k.publicClient,
    title,
    terms,
    siteUrl: k.siteUrl,
  });
}

/** Picks up a co-sign a previous process started, from the handle kept on the volume. */
export async function reopenCosign(handle: string): Promise<CosignHandle> {
  const k = ready();
  return await resumeCosign(handle, {
    verifyUrl: k.verifyUrl,
    platformKey: k.platformKey,
    agentAccount: k.account,
    publicClient: k.publicClient,
    siteUrl: k.siteUrl,
  });
}

/** Hands a passport Dreamloom's wallet holds to the visitor's address, through the kit's checks (P22). */
export async function movePassport(passportId: Hex, to: string): Promise<PassportTransfer> {
  return await transferPassport(passportId, to, ready().walletClient);
}
