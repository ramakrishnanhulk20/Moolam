import { describe, expect, it } from "vitest";
import type { Hex } from "viem";
import type { PassportInput } from "@/lib/chain/calldata";
import { DigestMismatch, assertDigestMatches, localBindDigest, localPassportDigest } from "@/lib/chain/digest";
import { bindNonce, hashBind, hashPassport } from "@/lib/chain/registry";

/**
 * These read the deployed registry over the public RPC. They send nothing and
 * cost nothing: hashPassport and hashBind are pure views, and they are the
 * only judge of whether the digest this app builds is the one the contract
 * will check.
 */

const WALLET = "0x559F357aDa3A96d11AEa679eC0D622E4AF15F67c" as Hex;

const INPUT: PassportInput = {
  exactHash: `0x${"ab".repeat(32)}`,
  parentId: `0x${"00".repeat(32)}`,
  creator: WALLET,
  generatorAgentId: 10249n,
  phash: 17297841240124424192n,
  blockhash256: `0x${"cd".repeat(32)}`,
  manifestHash: `0x${"ef".repeat(32)}`,
  kind: 0,
  fingerprintVersion: 1,
  metadataURI: "ipfs://bafkreimetadata",
  deadline: 1_788_878_342n,
};

describe("the passport digest built in the browser", () => {
  it("is the same 32 bytes the deployed registry hashes", async () => {
    expect(localPassportDigest(INPUT)).toBe(await hashPassport(INPUT));
  }, 30_000);

  it("changes when a single field of the picture changes", async () => {
    const other = { ...INPUT, exactHash: `0x${"ac".repeat(32)}` as Hex };

    expect(localPassportDigest(other)).not.toBe(localPassportDigest(INPUT));
    expect(localPassportDigest(other)).toBe(await hashPassport(other));
  }, 30_000);
});

describe("the bind digest built in the browser", () => {
  it("is the same 32 bytes the deployed registry hashes, at this wallet's live nonce", async () => {
    const qx = `0x${"11".repeat(32)}` as Hex;
    const qy = `0x${"22".repeat(32)}` as Hex;
    const nonce = await bindNonce(WALLET);

    expect(localBindDigest(WALLET, qx, qy, nonce)).toBe(await hashBind(WALLET, qx, qy, nonce));
  }, 30_000);
});

describe("comparing the two digests", () => {
  it("passes when they match, whatever case the hex came back in", () => {
    const local = localPassportDigest(INPUT);
    expect(() => assertDigestMatches(local, local.toUpperCase().replace("0X", "0x") as Hex)).not.toThrow();
  });

  it("throws DigestMismatch when they do not", () => {
    expect(() => assertDigestMatches(`0x${"11".repeat(32)}`, `0x${"22".repeat(32)}`)).toThrow(DigestMismatch);
  });
});
