import { decodeFunctionData, encodeErrorResult, getAddress, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { registryAbi } from "@/lib/chain/client";
import { bindPasskeyCalldata, decodeRegistryError, passportInputFrom, registerCalldata } from "@/lib/chain/calldata";
import type { WebAuthnAuth } from "@/lib/passkey/webauthn";

const CREATOR = "0x85a88ca81ff5f681d96ab86fa60ccb8452a139a6" as Hex;
const WORD = `0x${"ab".repeat(32)}` as Hex;
const ZERO = `0x${"00".repeat(32)}` as Hex;

const prepared = {
  exactHash: WORD,
  parentId: ZERO,
  generatorAgentId: "10249",
  phash: "17297841240124424192",
  blockhash256: `0x${"cd".repeat(32)}` as Hex,
  manifestHash: WORD,
  kind: 1,
  fingerprintVersion: 1,
  metadataURI: "ipfs://bafkreimetadata",
};

const auth: WebAuthnAuth = {
  r: `0x${"11".repeat(32)}`,
  s: `0x${"22".repeat(32)}`,
  challengeIndex: 23n,
  typeIndex: 1n,
  authenticatorData: `0x${"33".repeat(37)}`,
  clientDataJSON: '{"type":"webauthn.get","challenge":"abc","origin":"http://localhost:3210"}',
};

describe("passportInputFrom", () => {
  it("adds the creator and an hour long deadline, and turns the decimal strings into bigints", () => {
    const input = passportInputFrom(prepared, CREATOR, 1_700_000_000_000);

    expect(input.creator).toBe(CREATOR);
    expect(input.deadline).toBe(1_700_003_600n);
    expect(input.phash).toBe(17297841240124424192n);
    expect(input.generatorAgentId).toBe(10249n);
    expect(input.exactHash).toBe(WORD);
    expect(input.kind).toBe(1);
  });

  it("keeps a pHash that would lose digits as a JSON number", () => {
    const input = passportInputFrom(prepared, CREATOR, 1_700_000_000_000);
    expect(input.phash.toString()).toBe(prepared.phash);
    expect(Number(input.phash).toString()).not.toBe(prepared.phash);
  });

  it("rounds the clock down to whole seconds", () => {
    expect(passportInputFrom(prepared, CREATOR, 1_700_000_000_999).deadline).toBe(1_700_003_600n);
  });
});

describe("the calldata builders", () => {
  it("encodes bindPasskey so the ABI decodes the same struct back", () => {
    const data = bindPasskeyCalldata(WORD, `0x${"ef".repeat(32)}`, auth);
    const decoded = decodeFunctionData({ abi: registryAbi, data });

    expect(decoded.functionName).toBe("bindPasskey");
    expect(decoded.args?.[0]).toBe(WORD);
    expect(decoded.args?.[2]).toEqual(auth);
  });

  it("encodes register with the passport fields in the order the contract hashes them", () => {
    const input = passportInputFrom(prepared, CREATOR, 1_700_000_000_000);
    const decoded = decodeFunctionData({ abi: registryAbi, data: registerCalldata(input, auth) });

    expect(decoded.functionName).toBe("register");
    // viem hands the address back checksummed, which is the same 20 bytes.
    expect(decoded.args?.[0]).toEqual({ ...input, creator: getAddress(CREATOR) });
    expect(decoded.args?.[1]).toEqual(auth);
    expect(decoded.args?.[2]).toBe("0x");
  });
});

describe("decodeRegistryError", () => {
  it("names the error behind a revert viem buried in a cause", () => {
    const data = encodeErrorResult({ abi: registryAbi, errorName: "PassportAlreadyExists", args: [WORD] });

    expect(decodeRegistryError({ cause: { cause: { data } } })).toBe("PassportAlreadyExists");
    expect(decodeRegistryError({ data })).toBe("PassportAlreadyExists");
  });

  it("names the other refusals the studio has to explain", () => {
    const cases: [string, unknown[]][] = [
      ["SignatureExpired", [1_700_000_000n]],
      ["PasskeyNotBound", [CREATOR]],
      ["InvalidPasskeySignature", []],
      ["InvalidGeneratorSignature", []],
      ["UnknownAgent", [10249n]],
    ];

    for (const [errorName, args] of cases) {
      const data = encodeErrorResult({ abi: registryAbi, errorName, args });
      expect(decodeRegistryError({ cause: { data } })).toBe(errorName);
    }
  });

  it("says nothing for a rejected wallet prompt or an error with no revert data", () => {
    expect(decodeRegistryError(new Error("User rejected the request."))).toBeUndefined();
    expect(decodeRegistryError({ cause: { data: "0xdeadbeef" } })).toBeUndefined();
    expect(decodeRegistryError(undefined)).toBeUndefined();
  });
});
