import { createHash, randomBytes } from "node:crypto";
import { vi } from "vitest";

/**
 * Google's token endpoint, played offline. Every fetch the code under test makes goes through here,
 * and anything other than the token endpoint is recorded and refused, so a test proves that no
 * request leaves for Google or anywhere else.
 *
 * The ID token is signed with a throwaway key nobody checks: Dreamloom trusts the token because it
 * came straight from Google's token endpoint over TLS (OpenID Connect Core 3.1.3.7), so openid-client
 * checks its claims, not its signature, and these tests attack the claims.
 */

export const CLIENT_ID = "dreamloom-test.apps.googleusercontent.com";
export const CLIENT_SECRET = "gsecret-marker-5ec9-google";
export const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
export const EMAIL = "rosalind.marker@example.com";
export const MASKED = "r****@example.com";
export const SUB = "110248495921238986420";

function b64url(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

export function idToken(claims: Record<string, unknown>): string {
  return `${b64url(JSON.stringify({ alg: "RS256", typ: "JWT", kid: "test" }))}.${b64url(JSON.stringify(claims))}.${b64url(randomBytes(256))}`;
}

/** Claims a real Google ID token for this sign-in would carry, which a test then spoils one at a time. */
export function goodClaims(nonce: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: "https://accounts.google.com",
    azp: CLIENT_ID,
    aud: CLIENT_ID,
    sub: SUB,
    email: EMAIL,
    email_verified: true,
    nonce,
    iat: now,
    exp: now + 3600,
    ...overrides,
  };
}

export interface TokenCall {
  body: URLSearchParams;
}

export interface GoogleStandIn {
  tokenCalls: TokenCall[];
  /** Every request to anything but the token endpoint. Expected to stay empty. */
  strayCalls: string[];
  /** What the next token exchange answers with: claims for the ID token, or a whole answer. */
  answer: (body: URLSearchParams) => { claims: Record<string, unknown> } | { status: number; json: unknown };
}

export function standInForGoogle(): GoogleStandIn {
  const google: GoogleStandIn = {
    tokenCalls: [],
    strayCalls: [],
    answer: () => ({ status: 500, json: { error: "server_error" } }),
  };
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url !== TOKEN_ENDPOINT) {
      google.strayCalls.push(url);
      throw new TypeError("no network in tests");
    }
    const raw = input instanceof Request ? await input.text() : String(init?.body ?? "");
    const body = new URLSearchParams(raw);
    google.tokenCalls.push({ body });
    const answer = google.answer(body);
    const json =
      "claims" in answer
        ? { access_token: "ya29.test", token_type: "Bearer", expires_in: 3599, scope: "openid email", id_token: idToken(answer.claims) }
        : answer.json;
    const status = "claims" in answer ? 200 : answer.status;
    return new Response(JSON.stringify(json), { status, headers: { "content-type": "application/json" } });
  });
  return google;
}

/** The S256 challenge of a PKCE verifier, computed here independently of openid-client. */
export function challengeOf(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}
