import * as oidc from "openid-client";
import { env } from "./env";

/**
 * Sign in with Google, by OpenID Connect's authorization code flow with PKCE, a state and a nonce,
 * through openid-client. Google's endpoints are written here rather than discovered, so a sign-in
 * makes one call to Google (the token exchange) and nothing else.
 *
 * openid-client checks the ID token's issuer, audience, expiry, issue time and nonce. Its signature
 * is not checked again, because the token comes straight from Google's token endpoint over TLS,
 * which OpenID Connect Core 3.1.3.7 allows. What is checked here on top: Google said the address is
 * verified, and the subject and address are plain strings of a sane size.
 */

export const CALLBACK_PATH = "/api/auth/callback/google";

const GOOGLE: oidc.ServerMetadata = {
  issuer: "https://accounts.google.com",
  authorization_endpoint: "https://accounts.google.com/o/oauth2/v2/auth",
  token_endpoint: "https://oauth2.googleapis.com/token",
  jwks_uri: "https://www.googleapis.com/oauth2/v3/certs",
};

/** The longest address Moolam's rule takes, in code points, so a signed-in address can always be sent. */
const MAX_EMAIL_CODE_POINTS = 254;
const TOKEN_TIMEOUT_SECONDS = 15;

/** Whether Google sign-in is set up. Without both settings the button is not shown and nothing else changes. */
export function googleReady(): boolean {
  const e = env();
  return e.GOOGLE_CLIENT_ID !== undefined && e.GOOGLE_CLIENT_SECRET !== undefined;
}

function config(): oidc.Configuration {
  const e = env();
  if (e.GOOGLE_CLIENT_ID === undefined || e.GOOGLE_CLIENT_SECRET === undefined) {
    throw new Error("Google sign-in is not configured");
  }
  const configured = new oidc.Configuration(GOOGLE, e.GOOGLE_CLIENT_ID, e.GOOGLE_CLIENT_SECRET);
  configured.timeout = TOKEN_TIMEOUT_SECONDS;
  return configured;
}

/** The one redirect address Google is told, the one registered with it: Dreamloom's origin and the callback path. */
export function redirectUri(): string {
  return `${env().origin}${CALLBACK_PATH}`;
}

export interface SignInStart {
  url: URL;
  state: string;
  nonce: string;
  verifier: string;
}

/** A fresh verifier, state and nonce, and Google's sign-in page asking for them. */
export async function startGoogleSignIn(): Promise<SignInStart> {
  const verifier = oidc.randomPKCECodeVerifier();
  const state = oidc.randomState();
  const nonce = oidc.randomNonce();
  const url = oidc.buildAuthorizationUrl(config(), {
    redirect_uri: redirectUri(),
    response_type: "code",
    scope: "openid email",
    code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
    code_challenge_method: "S256",
    state,
    nonce,
    prompt: "select_account",
  });
  return { url, state, nonce, verifier };
}

export interface GoogleUser {
  sub: string;
  email: string;
}

/** Why a sign-in was refused, in a fixed word that is safe to log. */
export type SignInRefusal = "token" | "unverified";

/**
 * Finishes a sign-in from the query Google sent the visitor back with. The callback address is
 * rebuilt from Dreamloom's own origin, never from the request's host, so the redirect address sent
 * with the code is always the registered one.
 *
 * Returns the user, or a refusal word: "token" when openid-client refused the answer (a wrong state,
 * issuer, audience, nonce, an expired token, a failed exchange) and "unverified" when Google did not
 * say the address is verified or the token lacks a usable subject or address.
 */
export async function finishGoogleSignIn(
  search: URLSearchParams,
  expected: { state: string; nonce: string; verifier: string },
): Promise<GoogleUser | SignInRefusal> {
  const current = new URL(redirectUri());
  for (const [name, value] of search) current.searchParams.append(name, value);
  let claims: oidc.IDToken | undefined;
  try {
    const tokens = await oidc.authorizationCodeGrant(config(), current, {
      pkceCodeVerifier: expected.verifier,
      expectedState: expected.state,
      expectedNonce: expected.nonce,
      idTokenExpected: true,
    });
    claims = tokens.claims();
  } catch {
    return "token";
  }
  if (claims === undefined) return "token";
  return verifiedUser(claims);
}

/** The subject and address from checked ID token claims, only when Google says the address is verified. */
export function verifiedUser(claims: Record<string, unknown>): GoogleUser | "unverified" {
  const { sub, email, email_verified: verified } = claims;
  if (verified !== true) return "unverified";
  if (typeof sub !== "string" || sub.length === 0 || sub.length > 255) return "unverified";
  if (typeof email !== "string") return "unverified";
  const trimmed = email.trim();
  const at = trimmed.lastIndexOf("@");
  if (at <= 0 || at === trimmed.length - 1 || [...trimmed].length > MAX_EMAIL_CODE_POINTS) return "unverified";
  return { sub, email: trimmed };
}
