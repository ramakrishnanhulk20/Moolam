import type { Hex } from "viem";

/**
 * Who may see the edit panel, and whether this app already holds a signer on their wallet.
 *
 * Both answers are read from things the page already has: the owner the registry returned for this
 * passport, and the wallet list Privy keeps on the signed in user. Nothing here asks the service.
 */

/** One entry of Privy's linkedAccounts, narrowed to the three fields this file reads. */
export interface LinkedAccount {
  type: string;
  address?: string;
  delegated?: boolean;
}

/**
 * Whether the signed in wallet is the one the registry says holds this passport.
 *
 * Addresses arrive in whatever case each side stored them, so they are compared folded. A visitor
 * who is signed out has no wallet and owns nothing, which is what keeps the panel off their page.
 */
export function ownsPassport(owner: Hex | null | undefined, wallet: string | undefined): boolean {
  if (owner === null || owner === undefined || wallet === undefined) {
    return false;
  }
  return owner.toLowerCase() === wallet.toLowerCase();
}

/**
 * Whether this wallet has any signer on it, which is Privy's `delegated` flag on the linked
 * account.
 *
 * The flag says a signer exists, not that it is this app's signer under the edit policy. Only the
 * service can tell those apart, and it answers `no-signer` for both, which sends the panel back to
 * the grant button. So this is the fast answer for which state to draw first, never a promise.
 */
export function signerGranted(accounts: readonly LinkedAccount[] | undefined, wallet: string | undefined): boolean {
  if (accounts === undefined || wallet === undefined) {
    return false;
  }
  const address = wallet.toLowerCase();
  return accounts.some(
    (account) =>
      account.type === "wallet" && account.delegated === true && account.address?.toLowerCase() === address,
  );
}
