import { maskEmail } from "../email-mask";
import { forgetAccount, readAccount, safeReturn, savePending, takePending, writeAccount } from "./accounts";
import { env, isLoopbackHost } from "./env";
import { finishGoogleSignIn, googleReady, startGoogleSignIn } from "./google";
import { json, logLine, refuse } from "./http";
import { route } from "./routes";
import { newSession, readSession, sessionCookie, sessionHash } from "./session";
import { rebindSession } from "./store";

/**
 * The handlers behind Dreamloom's Google sign-in. The address Google verified stays on the server:
 * it is never put in a URL, a log line or an answer, and the only form that reaches a browser is
 * its mask, and only for the session that signed in with it.
 */

export const SIGNIN_COOKIE = "dl_signin";
const SIGNIN_PATH = "/api/auth";

/** The words a failed sign-in comes back with, in the query of the page the visitor started from. */
export type SignInOutcome = "failed" | "unverified" | "busy";

function secure(request: Request): boolean {
  const url = new URL(request.url);
  return !(url.protocol === "http:" && isLoopbackHost(url.hostname));
}

function signinCookie(value: string, request: Request, maxAgeSeconds: number): string {
  const parts = [`${SIGNIN_COOKIE}=${value}`, `Path=${SIGNIN_PATH}`, "HttpOnly", "SameSite=Lax", `Max-Age=${maxAgeSeconds}`];
  if (secure(request)) parts.push("Secure");
  return parts.join("; ");
}

function readSigninCookie(request: Request): string | null {
  const header = request.headers.get("cookie");
  if (header === null) return null;
  let found: string | null = null;
  for (const part of header.split(";")) {
    const at = part.indexOf("=");
    if (at === -1 || part.slice(0, at).trim() !== SIGNIN_COOKIE) continue;
    if (found !== null) return null;
    found = part.slice(at + 1).trim();
  }
  return found;
}

function redirect(location: string, cookies: string[] = []): Response {
  const headers = new Headers({ location, "cache-control": "no-store" });
  for (const cookie of cookies) headers.append("set-cookie", cookie);
  return new Response(null, { status: 302, headers });
}

/** Back to the page the visitor started from, with a word for the header when the sign-in did not finish. */
function back(returnTo: string, outcome: SignInOutcome | null, cookies: string[] = []): Response {
  const url = new URL(returnTo, env().origin);
  if (outcome !== null) url.searchParams.set("signin", outcome);
  return redirect(url.href, cookies);
}

/** GET /api/auth/signin/google?from=/p/<id>: sends the visitor to Google with a fresh PKCE verifier, state and nonce. */
export function signInWithGoogle(request: Request): Promise<Response> {
  return route(request, async () => {
    if (!googleReady()) return refuse(404, "not-found");
    const returnTo = safeReturn(new URL(request.url).searchParams.get("from"));
    const start = await startGoogleSignIn();
    const id = savePending({ state: start.state, nonce: start.nonce, verifier: start.verifier, returnTo });
    if (id === null) {
      logLine("signin", "too many in flight");
      return back(returnTo, "busy");
    }
    return redirect(start.url.href, [signinCookie(id, request, 600)]);
  });
}

/**
 * GET /api/auth/callback/google: finishes the sign-in this browser started. The sign-in is read once
 * and removed, so a callback cannot be replayed. On success the visitor gets a fresh session, which
 * takes over the pictures their old one wove, and the account is kept under the new session only.
 */
export function googleCallback(request: Request): Promise<Response> {
  return route(request, async () => {
    if (!googleReady()) return refuse(404, "not-found");
    const cleared = signinCookie("", request, 0);
    const pending = takePending(readSigninCookie(request));
    if (pending === null) {
      logLine("signin", "no sign-in in flight");
      return back("/", "failed", [cleared]);
    }
    const search = new URL(request.url).searchParams;
    if (search.has("error")) {
      return back(pending.returnTo, "failed", [cleared]);
    }
    const user = await finishGoogleSignIn(search, pending);
    if (typeof user === "string") {
      logLine("signin", user === "unverified" ? "address not verified" : "token refused");
      return back(pending.returnTo, user === "unverified" ? "unverified" : "failed", [cleared]);
    }
    const old = readSession(request);
    const fresh = newSession();
    const freshHash = sessionHash(fresh);
    if (old !== null) {
      const oldHash = sessionHash(old);
      rebindSession(oldHash, freshHash);
      forgetAccount(oldHash);
    }
    writeAccount(freshHash, user);
    logLine("signin", "signed in");
    return back(pending.returnTo, null, [cleared, sessionCookie(fresh, request)]);
  });
}

/** GET /api/auth/session: whether sign-in is offered, and this session's own masked address when it is signed in. */
export function currentAccount(request: Request): Promise<Response> {
  return route(request, async () => {
    const available = googleReady();
    const session = readSession(request);
    const account = !available || session === null ? null : readAccount(sessionHash(session));
    return json(200, account === null ? { available, signedIn: false } : { available, signedIn: true, email: maskEmail(account.email) });
  });
}

/** POST /api/auth/signout: forgets this session's Google account. Its pictures stay with the session. */
export function signOut(request: Request): Promise<Response> {
  return route(request, async () => {
    const session = readSession(request);
    if (session !== null) forgetAccount(sessionHash(session));
    return json(200, { available: googleReady(), signedIn: false });
  });
}
