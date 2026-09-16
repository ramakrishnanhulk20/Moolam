// Attack 4 of the second attack pass: a passkey assertion that is cryptographically perfect and
// was made for another site. One carries sha256("evil.example") as the relying party hash, the
// other says it was signed at https://evil.example. Both are real signatures over the right
// challenge, so only the two site fields separate them from an honest one.
// The assertions are built here from the same primitives test/fixtures.ts uses, because the
// shared builder is pinned to localhost and this attack needs another site.
// Does NOT cover the registry, which cannot see either field: it verifies the signature and
// nothing about where the signature was made. That is why this check lives in the browser, and
// the studio passes rpId and origin on every call, which test/studio.test.ts holds it to.

import { describe, expect, it } from "vitest";
import type { Hex } from "viem";
import { assertionToAuth, challengeFromDigest } from "@/lib/passkey/webauthn";
import { checkAuth } from "@/lib/passkey/verify";
import { base64urlOf, concat, exportPoint, makeP256Key, rawSignatureToDer, sha256, toArrayBuffer } from "../fixtures";

const DIGEST = "0x9b1f2c3d4e5a60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f9" as Hex;

/** The site a Moolam session actually runs under, and what checkAuth is asked to expect. */
const SITE = { rpId: "localhost", origin: "http://localhost:3210" };

/** User Present plus User Verified, which is what the registry demands. */
const FLAGS = 0x05;

/**
 * One assertion, signed for whichever site it is given.
 *
 * The signature covers authenticatorData and the hash of clientDataJSON, so an attacker who owns
 * evil.example produces a perfectly valid one. Nothing here is forged.
 */
async function assertionFor(rpId: string, origin: string, challenge: Uint8Array) {
  const key = await makeP256Key();

  const authenticatorData = new Uint8Array(37);
  authenticatorData.set(await sha256(new TextEncoder().encode(rpId)), 0);
  authenticatorData[32] = FLAGS;

  const clientDataJSON = new TextEncoder().encode(
    `{"type":"webauthn.get","challenge":"${base64urlOf(challenge)}","origin":"${origin}","crossOrigin":false}`,
  );

  const raw = new Uint8Array(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      key.privateKey,
      concat(authenticatorData, await sha256(clientDataJSON)) as unknown as ArrayBuffer,
    ),
  );

  return {
    auth: assertionToAuth({
      authenticatorData: toArrayBuffer(authenticatorData),
      clientDataJSON: toArrayBuffer(clientDataJSON),
      signature: toArrayBuffer(rawSignatureToDer(raw)),
    }),
    point: await exportPoint(key.publicKey),
  };
}

describe("an assertion made for another site", () => {
  it("is refused when the relying party hash belongs to evil.example", async () => {
    const { auth, point } = await assertionFor("evil.example", SITE.origin, challengeFromDigest(DIGEST));

    expect(await checkAuth(auth, DIGEST, point.qx, point.qy, SITE)).toMatchObject({
      ok: false,
      problem: "wrong-relying-party",
    });
  });

  it("is refused when the signature was made at https://evil.example", async () => {
    const { auth, point } = await assertionFor(SITE.rpId, "https://evil.example", challengeFromDigest(DIGEST));

    expect(await checkAuth(auth, DIGEST, point.qx, point.qy, SITE)).toMatchObject({
      ok: false,
      problem: "wrong-origin",
    });
  });

  it("is accepted when both fields are this site, so the refusals are the site and not the key", async () => {
    const { auth, point } = await assertionFor(SITE.rpId, SITE.origin, challengeFromDigest(DIGEST));

    expect(await checkAuth(auth, DIGEST, point.qx, point.qy, SITE)).toEqual({ ok: true });
  });

  it("is a valid signature either way, which is what makes the two fields the only defence", async () => {
    const { auth, point } = await assertionFor("evil.example", "https://evil.example", challengeFromDigest(DIGEST));

    expect(await checkAuth(auth, DIGEST, point.qx, point.qy)).toEqual({ ok: true });
  });
});
