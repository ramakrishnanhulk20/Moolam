// Covers the Privy access token check: a token this app's key signed passes, and a wrong
// audience, an expired token, a foreign key and a malformed string are each refused.
// Does NOT cover fetching the real JWKS from auth.privy.io, which needs the network, nor Privy's
// own login flow: the tokens here are signed locally with an ES256 key of our own.

import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { InvalidToken, verifyPrivyToken } from "../src/auth/privy.js";

// env.ts validates at import and reads PRIVY_APP_ID once, so the test app id has to be in place
// before any module in this file loads. vi.hoisted runs before the imports above.
const APP_ID = vi.hoisted(() => {
  const id = "moolamtestapp0000001";
  process.env.PRIVY_APP_ID = id;
  return id;
});

let signing: CryptoKey;
let verifying: CryptoKey;
let stranger: CryptoKey;

async function token(claims: { audience?: string; expires?: string | number; key?: CryptoKey } = {}): Promise<string> {
  return await new SignJWT({})
    .setProtectedHeader({ alg: "ES256" })
    .setIssuer("privy.io")
    .setAudience(claims.audience ?? APP_ID)
    .setSubject("did:privy:test-user")
    .setIssuedAt()
    .setExpirationTime(claims.expires ?? "1h")
    .sign(claims.key ?? signing);
}

describe("verifyPrivyToken", () => {
  beforeAll(async () => {
    const pair = await generateKeyPair("ES256", { extractable: true });
    signing = pair.privateKey;
    verifying = pair.publicKey;
    stranger = (await generateKeyPair("ES256", { extractable: true })).privateKey;
    // The public half exports as a JWK, which is the shape privyKeys() would fetch from Privy.
    expect((await exportJWK(verifying)).kty).toBe("EC");
  });

  it("accepts a token signed by the app's key and returns the user id", async () => {
    expect(await verifyPrivyToken(await token(), verifying)).toEqual({ userId: "did:privy:test-user" });
  });

  it("refuses a token minted for another Privy app", async () => {
    await expect(verifyPrivyToken(await token({ audience: "someoneelsesapp00001" }), verifying)).rejects.toBeInstanceOf(
      InvalidToken,
    );
  });

  it("refuses a token that has expired", async () => {
    const expired = await token({ expires: Math.floor(Date.now() / 1000) - 120 });
    await expect(verifyPrivyToken(expired, verifying)).rejects.toBeInstanceOf(InvalidToken);
  });

  it("refuses a token signed by a key that is not the app's", async () => {
    await expect(verifyPrivyToken(await token({ key: stranger }), verifying)).rejects.toBeInstanceOf(InvalidToken);
  });

  it("refuses a malformed token and an empty one", async () => {
    await expect(verifyPrivyToken("not.a.token", verifying)).rejects.toBeInstanceOf(InvalidToken);
    await expect(verifyPrivyToken("", verifying)).rejects.toBeInstanceOf(InvalidToken);
  });
});
