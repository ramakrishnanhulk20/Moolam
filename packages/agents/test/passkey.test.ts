// What this file does NOT cover: whether the contract accepts these assertions. That is proved
// on a fork in registry-client.test.ts, where a real MoolamRegistry runs OpenZeppelin's WebAuthn
// over the output of SoftwarePasskey.sign with requireUV true. It also does not cover a real
// device authenticator, which no test on this machine can reach.

import { p256 } from "@noble/curves/nist.js";
import { hexToBytes, keccak256, toHex } from "viem";
import { describe, expect, it } from "vitest";
import { SoftwarePasskey } from "../src/chain/passkey.js";

const CURVE_ORDER = p256.Point.Fn.ORDER;
const HALF_ORDER = CURVE_ORDER >> 1n;

describe("SoftwarePasskey", () => {
  it("builds the client data JSON at the byte offsets the contract reads from", () => {
    const passkey = SoftwarePasskey.random();
    const auth = passkey.sign(keccak256(toHex("a digest to sign")));

    expect(auth.clientDataJSON.indexOf('"type":"webauthn.get"')).toBe(Number(auth.typeIndex));
    expect(auth.clientDataJSON.indexOf('"challenge":"')).toBe(Number(auth.challengeIndex));
  });

  it("sets user presence and user verification in the authenticator data", () => {
    const passkey = SoftwarePasskey.random();
    const auth = passkey.sign(keccak256(toHex("flags")));
    const authenticatorData = hexToBytes(auth.authenticatorData);
    const flags = authenticatorData[32] ?? 0;

    expect(authenticatorData.length).toBe(37);
    expect(flags & 0x01).toBe(0x01);
    expect(flags & 0x04).toBe(0x04);
    // Backed up implies backup eligible, the one flag pairing the library rejects.
    expect((flags & 0x08) === 0x08 || (flags & 0x10) === 0).toBe(true);
  });

  it("keeps every signature in the lower half of the curve order", () => {
    const passkey = SoftwarePasskey.random();

    for (let i = 0; i < 64; i++) {
      const auth = passkey.sign(keccak256(toHex(`challenge ${i}`)));
      const r = BigInt(auth.r);
      const s = BigInt(auth.s);

      expect(r > 0n && r < CURVE_ORDER).toBe(true);
      expect(s > 0n && s <= HALF_ORDER).toBe(true);
    }
  });

  it("refuses a challenge that is not the 32 byte digest", () => {
    const passkey = SoftwarePasskey.random();
    expect(() => passkey.sign("0xdeadbeef")).toThrow(/32 byte digest/);
  });

  it("recreates the same public key from the same private key", () => {
    const key = toHex(p256.utils.randomSecretKey());
    const first = SoftwarePasskey.fromPrivateKey(key);
    const second = SoftwarePasskey.fromPrivateKey(key);

    expect(second.qx).toBe(first.qx);
    expect(second.qy).toBe(first.qy);
  });
});
