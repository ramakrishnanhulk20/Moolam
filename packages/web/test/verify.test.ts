import { describe, expect, it } from "vitest";
import { checkAuth } from "@/lib/passkey/verify";
import { assertionToAuth, challengeFromDigest } from "@/lib/passkey/webauthn";
import { base64urlOf, buildAssertion, exportPoint, makeP256Key } from "./fixtures";

const DIGEST = "0x2f4e6a8c0e1d3b5a79860b4c2d1e0f9a8b7c6d5e4f30211203a4b5c6d7e8f901" as const;
const OTHER_DIGEST = "0x0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20" as const;

async function passing() {
  const key = await makeP256Key();
  const assertion = await buildAssertion(key, challengeFromDigest(DIGEST));
  return { key, auth: assertionToAuth(assertion), point: await exportPoint(key.publicKey) };
}

describe("checkAuth", () => {
  it("accepts an assertion the registry would accept", async () => {
    const { auth, point } = await passing();
    expect(await checkAuth(auth, DIGEST, point.qx, point.qy)).toEqual({ ok: true });
  });

  it("refuses a device that did not verify the user", async () => {
    const key = await makeP256Key();
    const point = await exportPoint(key.publicKey);

    const touchOnly = assertionToAuth(await buildAssertion(key, challengeFromDigest(DIGEST), { flags: 0x01 }));
    expect(await checkAuth(touchOnly, DIGEST, point.qx, point.qy)).toMatchObject({
      ok: false,
      problem: "user-not-verified",
    });

    const noTouch = assertionToAuth(await buildAssertion(key, challengeFromDigest(DIGEST), { flags: 0x04 }));
    expect(await checkAuth(noTouch, DIGEST, point.qx, point.qy)).toMatchObject({
      ok: false,
      problem: "user-not-present",
    });

    const backedUpButNotEligible = assertionToAuth(
      await buildAssertion(key, challengeFromDigest(DIGEST), { flags: 0x15 }),
    );
    expect(await checkAuth(backedUpButNotEligible, DIGEST, point.qx, point.qy)).toMatchObject({
      ok: false,
      problem: "backup-state-without-eligibility",
    });
  });

  it("refuses a signature over a different digest", async () => {
    const { auth, point } = await passing();
    expect(await checkAuth(auth, OTHER_DIGEST, point.qx, point.qy)).toMatchObject({
      ok: false,
      problem: "wrong-challenge",
    });
  });

  it("refuses a challenge that is not the digest at all", async () => {
    const key = await makeP256Key();
    const point = await exportPoint(key.publicKey);
    const auth = assertionToAuth(
      await buildAssertion(key, challengeFromDigest(DIGEST), { challengeText: base64urlOf(new Uint8Array(32)) }),
    );

    expect(await checkAuth(auth, DIGEST, point.qx, point.qy)).toMatchObject({ ok: false, problem: "wrong-challenge" });
  });

  it("refuses an assertion signed by another passkey", async () => {
    const { auth } = await passing();
    const stranger = await exportPoint((await makeP256Key()).publicKey);

    expect(await checkAuth(auth, DIGEST, stranger.qx, stranger.qy)).toMatchObject({
      ok: false,
      problem: "bad-signature",
    });
  });

  it("refuses an assertion that is not a webauthn.get and one with short authenticator data", async () => {
    const { auth, point } = await passing();

    const wrongType = { ...auth, clientDataJSON: auth.clientDataJSON.replace("webauthn.get", "webauthn.create") };
    expect(await checkAuth(wrongType, DIGEST, point.qx, point.qy)).toMatchObject({ ok: false, problem: "wrong-type" });

    const short = { ...auth, authenticatorData: auth.authenticatorData.slice(0, 60) as `0x${string}` };
    expect(await checkAuth(short, DIGEST, point.qx, point.qy)).toMatchObject({
      ok: false,
      problem: "short-authenticator-data",
    });
  });
});
