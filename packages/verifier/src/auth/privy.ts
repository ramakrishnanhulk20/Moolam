import { readFileSync } from "node:fs";
import { createLocalJWKSet, createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { env } from "../env.js";

/** The issuer Privy stamps on every access token, whatever the app. */
const ISSUER = "privy.io";

/** Privy signs access tokens with ES256 only. Naming it stops an "alg": "none" style downgrade. */
const ALGORITHM = "ES256";

/** Either a key set resolver, as jose builds from a JWKS, or one key a test signed with. */
export type PrivyKeys = JWTVerifyGetKey | CryptoKey | Uint8Array;

export interface PrivyIdentity {
  /** The Privy user id from the token's sub claim, the same value across that user's sessions. */
  userId: string;
}

/** A token we will not act on. Every route turns this into 401 and never into 500. */
export class InvalidToken extends Error {}

let cachedKeys: JWTVerifyGetKey | undefined;

/**
 * The key set this service checks Privy tokens against.
 *
 * Normally that is the app's published JWKS, fetched on first use and cached by jose, which
 * re-fetches by itself when a token names a key it has not seen. PRIVY_JWKS_OVERRIDE_PATH points
 * at a local JWKS file instead, for tests that sign their own tokens; env.ts refuses that variable
 * when NODE_ENV is production.
 *
 * Throws when PRIVY_APP_ID is missing, which is a boot-time misconfiguration rather than a caller
 * error: the prepare route is not mounted at all without it.
 */
export function privyKeys(): JWTVerifyGetKey {
  if (cachedKeys === undefined) {
    const appId = requireAppId();
    cachedKeys =
      env.PRIVY_JWKS_OVERRIDE_PATH === undefined
        ? createRemoteJWKSet(new URL(`https://auth.privy.io/api/v1/apps/${appId}/jwks.json`))
        : createLocalJWKSet(JSON.parse(readFileSync(env.PRIVY_JWKS_OVERRIDE_PATH, "utf8")));
  }
  return cachedKeys;
}

/**
 * Checks a Privy access token and returns who sent it.
 *
 * The token must be signed by the app's own key set, carry the issuer Privy uses, name this app
 * in its audience, and still be inside its expiry. A token from another Privy app fails on the
 * audience, which is the check that stops a stranger's app minting credit against our pinning
 * account.
 *
 * Throws InvalidToken for anything wrong with the token, including a key set that cannot be
 * fetched, so a caller never learns the difference between a bad signature and a bad network.
 */
export async function verifyPrivyToken(token: string, keys?: PrivyKeys): Promise<PrivyIdentity> {
  const audience = requireAppId();
  if (token.trim().length === 0) {
    throw new InvalidToken("no access token");
  }

  let userId: unknown;
  try {
    const { payload } = await jwtVerify(token, keys ?? privyKeys(), {
      issuer: ISSUER,
      audience,
      algorithms: [ALGORITHM],
    });
    userId = payload.sub;
  } catch (error) {
    throw new InvalidToken(error instanceof Error ? error.message : String(error));
  }

  if (typeof userId !== "string" || userId.length === 0) {
    throw new InvalidToken("the token carries no user id");
  }
  return { userId };
}

/** Reads the bearer token out of an Authorization header, or undefined when there is none. */
export function bearerToken(header: string | undefined): string | undefined {
  if (header === undefined) {
    return undefined;
  }
  const match = /^Bearer (.+)$/i.exec(header.trim());
  return match?.[1]?.trim();
}

function requireAppId(): string {
  if (env.PRIVY_APP_ID === undefined) {
    throw new Error("PRIVY_APP_ID is missing, so no Privy access token can be checked.");
  }
  return env.PRIVY_APP_ID;
}
