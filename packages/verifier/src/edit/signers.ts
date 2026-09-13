import { isEmbeddedWalletLinkedAccount, type AuthorizationContext, type PrivyClient } from "@privy-io/node";
import { getAddress, type Hex } from "viem";

export interface OwnerWallet {
  /** Privy's own id for the wallet, which is the only handle its API accepts. */
  id: string;
  address: Hex;
}

export interface WalletSigner {
  signerId: string;
  policyIds: string[];
}

/**
 * Every embedded wallet of the user's that this app is allowed to sign on, with checksummed
 * addresses, in the order Privy lists them.
 *
 * All of them rather than the first one: a creator can hold two embedded wallets, and the passport
 * being edited belongs to exactly one of those, so the caller picks by address. Returning the first
 * delegated wallet used to refuse the second wallet's own passports as if a stranger had asked.
 *
 * The wallets are read from the Privy user record and never from the request, so a caller cannot
 * name a wallet that is not theirs. Privy marks a wallet the user has granted a signer on with
 * delegated true, and that flag is the only signal in the API that says the grant happened.
 * Ethereum only: this app writes to Monad.
 */
export async function delegatedWallets(client: PrivyClient, userId: string): Promise<OwnerWallet[]> {
  const user = await client.users()._get(userId);
  const wallets: OwnerWallet[] = [];
  for (const account of user.linked_accounts) {
    if (!isEmbeddedWalletLinkedAccount(account)) continue;
    if (account.chain_type !== "ethereum" || !account.delegated || account.id === null) continue;
    wallets.push({ id: account.id, address: getAddress(account.address as Hex) });
  }
  return wallets;
}

/** Who Privy currently accepts as a signer on a wallet, with the policies each one is held to. */
export async function walletSigners(client: PrivyClient, walletId: string): Promise<WalletSigner[]> {
  const wallet = await client.wallets().get(walletId);
  return readSigners(wallet.additional_signers);
}

/**
 * Adds one signer to a wallet, scoped by its override policy.
 *
 * This is the server side of what the browser SDK calls addSigners: the wallet owner authorizes
 * the change, and the signer can only do what its override policy allows.
 */
export async function grantSigner(
  client: PrivyClient,
  walletId: string,
  signer: { signerId: string; policyId?: string },
  context: AuthorizationContext,
): Promise<WalletSigner[]> {
  const wallet = await client.wallets().update(walletId, {
    additional_signers: [
      {
        signer_id: signer.signerId,
        ...(signer.policyId ? { override_policy_ids: [signer.policyId] } : {}),
      },
    ],
    authorization_context: context,
  });
  return readSigners(wallet.additional_signers);
}

/**
 * Takes every signer off a wallet.
 *
 * Privy's browser SDK removes them all in one call and this is the server equivalent: the owner
 * keeps the wallet, the app loses the ability to sign on it.
 */
export async function removeAllSigners(
  client: PrivyClient,
  walletId: string,
  context: AuthorizationContext,
): Promise<WalletSigner[]> {
  const wallet = await client.wallets().update(walletId, {
    additional_signers: [],
    authorization_context: context,
  });
  return readSigners(wallet.additional_signers);
}

/** The signer ids alone, for a caller that only needs to know whether one is listed. */
export function signerIds(signers: WalletSigner[]): string[] {
  return signers.map((signer) => signer.signerId);
}

/** Privy leaves additional_signers out entirely on a wallet that has none. */
function readSigners(signers: unknown): WalletSigner[] {
  if (!Array.isArray(signers)) return [];
  const found: WalletSigner[] = [];
  for (const entry of signers) {
    const item = entry as { signer_id?: unknown; override_policy_ids?: unknown };
    if (typeof item.signer_id !== "string") continue;
    const policyIds = Array.isArray(item.override_policy_ids)
      ? item.override_policy_ids.filter((id): id is string => typeof id === "string")
      : [];
    found.push({ signerId: item.signer_id, policyIds });
  }
  return found;
}
