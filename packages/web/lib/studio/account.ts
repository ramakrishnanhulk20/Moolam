/**
 * What to call the person who just signed in.
 *
 * Privy hands back a different field for every login method, and the studio
 * shows one line at the top of the screen, so the first thing that reads like a
 * name a person recognises wins. Anyone who signed in with a passkey alone has
 * no name at all, which is a fact worth saying rather than papering over.
 */
export type AccountKind = "email" | "google" | "phone" | "passkey" | "account";

export interface AccountName {
  kind: AccountKind;
  /** The address or number to print. Absent for a passkey-only account. */
  value?: string;
}

export interface SignedInUser {
  email?: { address: string } | null;
  google?: { email?: string | null } | null;
  phone?: { number: string } | null;
  linkedAccounts?: readonly { type: string }[];
}

export function accountName(user: SignedInUser | null | undefined): AccountName {
  if (user === null || user === undefined) {
    return { kind: "account" };
  }

  const email = user.email?.address;
  if (typeof email === "string" && email.length > 0) {
    return { kind: "email", value: email };
  }

  const google = user.google?.email;
  if (typeof google === "string" && google.length > 0) {
    return { kind: "google", value: google };
  }

  const phone = user.phone?.number;
  if (typeof phone === "string" && phone.length > 0) {
    return { kind: "phone", value: phone };
  }

  if (user.linkedAccounts?.some((account) => account.type === "passkey") === true) {
    return { kind: "passkey" };
  }

  return { kind: "account" };
}
