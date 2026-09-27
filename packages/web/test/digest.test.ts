import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Hex } from "viem";
import type { PassportInput } from "@/lib/chain/calldata";
import { CHAIN_ID, addresses } from "@/lib/chain/client";
import { DigestMismatch, assertDigestMatches, localBindDigest, localPassportDigest } from "@/lib/chain/digest";

/**
 * The deployed registry is the only judge of whether the digest this app builds is the one the
 * contract will check. Its answers are read once, not on every run: hashPassport, bindNonce and
 * hashBind were called on chain 143 at the block named in test/fixtures/digest-golden.json, and
 * the local digests here are held to those recorded values, offline.
 *
 * To re-record them (after a redeploy, or when an input below changes), from packages/web:
 *   npx tsx scripts/record-digest-golden.ts
 * The script carries the same inputs, and each test first checks the fixture was recorded for
 * exactly these, so a change on one side only fails here instead of passing against a stale value.
 *
 * Does NOT cover a registry changed after the recorded block (it is immutable, so only a redeploy,
 * which moves the address this test checks), or the wallet's nonce today.
 */

const FIXTURE = fileURLToPath(new URL("./fixtures/digest-golden.json", import.meta.url));

interface Golden {
  chainId: number;
  registry: Hex;
  blockNumber: string;
  passport: Record<"base" | "otherPicture", { input: Record<string, string | number>; digest: Hex }>;
  bind: { wallet: Hex; qx: Hex; qy: Hex; nonce: string; digest: Hex };
}

function golden(): Golden {
  if (!existsSync(FIXTURE)) {
    throw new Error(
      "test/fixtures/digest-golden.json is missing. Record the registry's answers once with " +
        "`npx tsx scripts/record-digest-golden.ts` from packages/web.",
    );
  }
  const recorded = JSON.parse(readFileSync(FIXTURE, "utf8")) as Golden;
  // A fixture from another deployment would compare these digests against another contract's domain.
  expect(recorded.chainId).toBe(CHAIN_ID);
  expect(recorded.registry.toLowerCase()).toBe(addresses.registry.toLowerCase());
  return recorded;
}

/** The same shape the script writes: the three bigint fields as decimal strings. */
function recordedInput(input: PassportInput): Record<string, string | number> {
  return {
    ...input,
    generatorAgentId: input.generatorAgentId.toString(),
    phash: input.phash.toString(),
    deadline: input.deadline.toString(),
  };
}

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
  it("is the same 32 bytes the deployed registry hashed at the recorded block", () => {
    const { passport } = golden();

    expect(passport.base.input).toEqual(recordedInput(INPUT));
    expect(localPassportDigest(INPUT)).toBe(passport.base.digest);
  });

  it("changes when a single field of the picture changes", () => {
    const { passport } = golden();
    const other = { ...INPUT, exactHash: `0x${"ac".repeat(32)}` as Hex };

    expect(passport.otherPicture.input).toEqual(recordedInput(other));
    expect(localPassportDigest(other)).not.toBe(localPassportDigest(INPUT));
    expect(localPassportDigest(other)).toBe(passport.otherPicture.digest);
  });
});

describe("the bind digest built in the browser", () => {
  it("is the same 32 bytes the deployed registry hashed, at the wallet's nonce at the recorded block", () => {
    const { bind } = golden();
    const qx = `0x${"11".repeat(32)}` as Hex;
    const qy = `0x${"22".repeat(32)}` as Hex;

    expect({ wallet: bind.wallet, qx: bind.qx, qy: bind.qy }).toEqual({ wallet: WALLET, qx, qy });
    expect(localBindDigest(WALLET, qx, qy, BigInt(bind.nonce))).toBe(bind.digest);
  });
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
