import { z } from "zod";

/**
 * The browser's side of Dreamloom's Google sign-in. The server only ever answers this session's own
 * masked address, so the page never holds the address itself.
 */

export const SESSION_PATH = "/api/auth/session";
export const SIGNOUT_PATH = "/api/auth/signout";
export const SIGNIN_PATH = "/api/auth/signin/google";

const answer = z.object({
  available: z.boolean(),
  signedIn: z.boolean(),
  email: z.string().min(1).max(320).optional(),
});

export type AccountView =
  | { available: false }
  | { available: true; signedIn: false }
  | { available: true; signedIn: true; email: string };

function view(body: unknown): AccountView | null {
  const parsed = answer.safeParse(body);
  if (!parsed.success) return null;
  const { available, signedIn, email } = parsed.data;
  if (!available) return { available: false };
  if (signedIn && email !== undefined) return { available: true, signedIn: true, email };
  return { available: true, signedIn: false };
}

/** This session's sign-in. Null when the server did not answer, so the header simply shows nothing. */
export async function readAccountView(send: typeof fetch = fetch): Promise<AccountView | null> {
  try {
    const response = await send(SESSION_PATH, { cache: "no-store", credentials: "same-origin" });
    return response.status === 200 ? view(await response.json()) : null;
  } catch {
    return null;
  }
}

/** Signs this session out. The new view, or null when the server did not answer. */
export async function postSignOut(send: typeof fetch = fetch): Promise<AccountView | null> {
  try {
    const response = await send(SIGNOUT_PATH, { method: "POST", credentials: "same-origin" });
    return response.status === 200 ? view(await response.json()) : null;
  } catch {
    return null;
  }
}

const RETURNABLE = /^\/(p\/[0-9a-f]{32})?$/;

/** Where the sign-in button goes: Google, by way of Dreamloom, then back to this page when it is one Dreamloom returns to. */
export function signInHref(pathname: string): string {
  const from = RETURNABLE.test(pathname) ? pathname : "/";
  return `${SIGNIN_PATH}?from=${encodeURIComponent(from)}`;
}

/** Words for a sign-in that came back without finishing, each with what to do next. */
export const SIGNIN_WORDS = {
  failed: "Google sign-in did not finish. Try again.",
  unverified: "Google has not verified that address, so Dreamloom cannot use it. Try another Google account.",
  busy: "Dreamloom is busy right now. Try signing in again in a minute.",
} as const;

export type SignInOutcome = keyof typeof SIGNIN_WORDS;

export function signInOutcome(search: string): SignInOutcome | null {
  const word = new URLSearchParams(search).get("signin");
  return word !== null && Object.hasOwn(SIGNIN_WORDS, word) ? (word as SignInOutcome) : null;
}
