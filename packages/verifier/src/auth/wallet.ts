import { isEmbeddedWalletLinkedAccount, type PrivyClient } from "@privy-io/node";
import { getAddress, type Hex } from "viem";

/**
 * Every ethereum wallet Privy created for this user inside their own account.
 *
 * The list comes from the Privy user record and never from the request, so a caller cannot name an
 * address that is not theirs and have this service sign a passport for it. Unlike the edit route's
 * lookup, a wallet does not have to be delegated to count: nothing here signs on the user's wallet,
 * it only checks that the creator address on a passport belongs to the person who asked for it.
 * Ethereum only, because this app writes to Monad.
 *
 * Throws whatever the Privy client throws, including a 404 for a user id this app does not know.
 */
export async function embeddedWallets(client: PrivyClient, userId: string): Promise<Hex[]> {
  const user = await client.users()._get(userId);
  const wallets: Hex[] = [];
  for (const account of user.linked_accounts) {
    if (!isEmbeddedWalletLinkedAccount(account)) continue;
    if (account.chain_type !== "ethereum") continue;
    wallets.push(getAddress(account.address as Hex));
  }
  return wallets;
}
