import { APIError, type PrivyClient } from "@privy-io/node";

/**
 * The email addresses Privy verified for this user, as Privy spells them (P28): the address of an
 * "email" account, which Privy links only after a code sent to it is entered, and the email of a
 * "google_oauth" account. Each must carry Privy's verified_at time. Every other linked type is left
 * out on purpose, an Apple relay address and any other OAuth email among them, because only these
 * two are a provider's proof that this person reads that inbox.
 *
 * A user Privy does not know has none. Throws whatever else Privy threw, which the route turns
 * into "no tickets, no accept" (fail closed). The addresses are handed straight to emailHash by the
 * caller and kept nowhere.
 */
export async function verifiedEmails(client: PrivyClient, userId: string): Promise<string[]> {
  let accounts: unknown[];
  try {
    accounts = (await client.users()._get(userId)).linked_accounts;
  } catch (error) {
    if (error instanceof APIError && error.status === 404) return [];
    throw error;
  }
  const found: string[] = [];
  for (const account of accounts) {
    if (typeof account !== "object" || account === null) continue;
    const { type, verified_at: verifiedAt } = account as { type?: unknown; verified_at?: unknown };
    if (typeof verifiedAt !== "number" || !(verifiedAt > 0)) continue;
    const address =
      type === "email" ? (account as { address?: unknown }).address : type === "google_oauth" ? (account as { email?: unknown }).email : undefined;
    if (typeof address === "string") found.push(address);
  }
  return found;
}
