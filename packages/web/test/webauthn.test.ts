import { describe, expect, it } from "vitest";
import { P256_ORDER } from "@/lib/passkey/der";
import { assertionToAuth, base64url, challengeFromDigest } from "@/lib/passkey/webauthn";
import { base64urlOf, buildAssertion, encodeDerSignature, makeP256Key, toArrayBuffer } from "./fixtures";

const DIGEST = "0x9b1f2c3d4e5a60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f9" as const;

function clientData(json: string): ArrayBuffer {
  return toArrayBuffer(new TextEncoder().encode(json));
}

describe("assertionToAuth", () => {
  it("finds the indices the contract reads in a Chrome shaped clientDataJSON", async () => {
    const key = await makeP256Key();
    const challenge = challengeFromDigest(DIGEST);
    const assertion = await buildAssertion(key, challenge);

    const auth = assertionToAuth(assertion);
    const json = auth.clientDataJSON;

    expect(json).toBe(
      `{"type":"webauthn.get","challenge":"${base64urlOf(challenge)}","origin":"http://localhost:3210","crossOrigin":false}`,
    );
    expect(auth.typeIndex).toBe(1n);
    expect(auth.challengeIndex).toBe(23n);
    expect(json.slice(Number(auth.typeIndex), Number(auth.typeIndex) + 21)).toBe('"type":"webauthn.get"');
    expect(json.slice(Number(auth.challengeIndex))).toMatch(/^"challenge":"/);
    expect(auth.authenticatorData).toBe(
      `0x${Buffer.from(new Uint8Array(assertion.authenticatorData)).toString("hex")}`,
    );
  });

  it("keeps clientDataJSON verbatim when the browser adds fields of its own", () => {
    const json =
      '{"type":"webauthn.get","challenge":"abc","origin":"https://moolam.xyz","crossOrigin":false,"other":"ignored"}';
    const auth = assertionToAuth({
      authenticatorData: toArrayBuffer(new Uint8Array(37)),
      clientDataJSON: clientData(json),
      signature: toArrayBuffer(encodeDerSignature(7n, 9n)),
    });

    expect(auth.clientDataJSON).toBe(json);
    expect(auth.typeIndex).toBe(1n);
    expect(auth.challengeIndex).toBe(23n);
  });

  it("throws when either marker is missing", () => {
    const signature = toArrayBuffer(encodeDerSignature(7n, 9n));
    const authenticatorData = toArrayBuffer(new Uint8Array(37));

    expect(() =>
      assertionToAuth({
        authenticatorData,
        clientDataJSON: clientData('{"type":"webauthn.get","origin":"http://localhost:3210"}'),
        signature,
      }),
    ).toThrow(/"challenge":/);

    expect(() =>
      assertionToAuth({
        authenticatorData,
        clientDataJSON: clientData('{"challenge":"abc","origin":"http://localhost:3210"}'),
        signature,
      }),
    ).toThrow(/"type":/);
  });

  it("folds a high s so the contract will take it", () => {
    const high = P256_ORDER - 12345n;
    const auth = assertionToAuth({
      authenticatorData: toArrayBuffer(new Uint8Array(37)),
      clientDataJSON: clientData('{"type":"webauthn.get","challenge":"abc"}'),
      signature: toArrayBuffer(encodeDerSignature(42n, high)),
    });

    expect(auth.r).toBe(`0x${(42n).toString(16).padStart(64, "0")}`);
    expect(auth.s).toBe(`0x${(12345n).toString(16).padStart(64, "0")}`);
  });
});

describe("challengeFromDigest", () => {
  it("hands back the 32 raw bytes, which base64url encode to what the contract rebuilds", () => {
    const bytes = challengeFromDigest(DIGEST);
    expect(bytes.length).toBe(32);
    expect(base64url(bytes)).toBe(base64urlOf(bytes));
    expect(base64url(bytes)).not.toContain("=");
  });

  it("refuses anything that is not 32 bytes", () => {
    expect(() => challengeFromDigest("0x1234")).toThrow(/32 byte/);
  });
});
