import { describe, expect, it } from "vitest";
import { SoftwarePasskey } from "../../agents/src/chain/passkey";
import { checkAuth } from "@/lib/passkey/verify";
import { assertionToAuth, challengeFromDigest } from "@/lib/passkey/webauthn";
import { encodeDerSignature, toArrayBuffer } from "./fixtures";

const DIGEST = "0x5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b" as const;
// A fixed P-256 scalar so the fixture is deterministic. It signs nothing outside this test.
const FIXTURE_SCALAR = "0x4f3c2b1a09e8d7c6b5a4938271605f4e3d2c1b0a99887766554433221100ffee" as const;

/**
 * The agents package signs passports from a script with a software key. The
 * browser signs them with a real passkey. Both end up in the same struct, and
 * the registry cannot tell them apart, so the two paths are compared here on
 * the same bytes: if they ever drift, one of them starts reverting on chain.
 */
describe("the browser and the agent build the same WebAuthnAuth", () => {
  it("agrees field for field on one signature", async () => {
    const passkey = SoftwarePasskey.fromPrivateKey(FIXTURE_SCALAR);
    const fromAgent = passkey.sign(DIGEST);

    const fromBrowser = assertionToAuth({
      authenticatorData: toArrayBuffer(hexBytes(fromAgent.authenticatorData)),
      clientDataJSON: toArrayBuffer(new TextEncoder().encode(fromAgent.clientDataJSON)),
      signature: toArrayBuffer(encodeDerSignature(BigInt(fromAgent.r), BigInt(fromAgent.s))),
    });

    expect(fromBrowser).toEqual({
      r: fromAgent.r,
      s: fromAgent.s,
      challengeIndex: fromAgent.challengeIndex,
      typeIndex: fromAgent.typeIndex,
      authenticatorData: fromAgent.authenticatorData,
      clientDataJSON: fromAgent.clientDataJSON,
    });
  });

  it("passes the browser's copy of the contract's checks", async () => {
    const passkey = SoftwarePasskey.fromPrivateKey(FIXTURE_SCALAR);
    const fromAgent = passkey.sign(DIGEST);

    const auth = assertionToAuth({
      authenticatorData: toArrayBuffer(hexBytes(fromAgent.authenticatorData)),
      clientDataJSON: toArrayBuffer(new TextEncoder().encode(fromAgent.clientDataJSON)),
      signature: toArrayBuffer(encodeDerSignature(BigInt(fromAgent.r), BigInt(fromAgent.s))),
    });

    expect(await checkAuth(auth, DIGEST, passkey.qx, passkey.qy)).toEqual({ ok: true });
    expect(challengeFromDigest(DIGEST).length).toBe(32);
  });
});

function hexBytes(hex: string): Uint8Array {
  const body = hex.slice(2);
  const out = new Uint8Array(body.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(body.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
