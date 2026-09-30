// Covers the messages the kit signs against the verify service's own encoders: the PlatformPrepare
// digest (a live import of the service's prepareDigest and a fixed vector), the signature recovered
// by the service's own registry-rule recovery, the platform id against the service's key hash, and
// the passport digest against the service's passportDigest.
// Does NOT cover the registry accepting the digest on chain or the service's routes end to end:
// fork.test.ts registers against the real registry bytecode, and packages/verifier tests its routes.

import { getAddress, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { domain as serviceRegistryDomain, passportDigest as servicePassportDigest } from "@moolam/verifier/src/generate/eip712.js";
import { platformKeyHash } from "@moolam/verifier/src/platform/key.js";
import { MODE as SERVICE_MODE, prepareDigest as servicePrepareDigest, signedByAddress } from "@moolam/verifier/src/platform/signatures.js";
import type { ChainReader } from "../src/chain.js";
import { MOOLAM_REGISTRY } from "../src/constants.js";
import { MODE, passportDigest, prepareDigest, type PassportInput } from "../src/eip712.js";
import { platformIdOf, sha256Hex, signPlatformPrepare } from "../src/prepare.js";

const KEY = "a1".repeat(32);

/** A reader that answers only the one read signPlatformPrepare makes: the latest block's time. */
function clockAt(timestamp: bigint): ChainReader {
  return { getBlock: async () => ({ timestamp }) } as unknown as ChainReader;
}

describe("the PlatformPrepare message", () => {
  it("numbers the two modes as the service does", () => {
    expect(MODE).toEqual(SERVICE_MODE);
  });

  it("names the platform by the same key hash the service stores", () => {
    expect(platformIdOf(KEY)).toBe(`0x${platformKeyHash(KEY).toString("hex")}`);
    expect(platformIdOf(KEY.toUpperCase())).toBe(platformIdOf(KEY));
  });

  it("hashes a fixed message to the vector the service's encoder gives", () => {
    const message = {
      mode: 1,
      pictureHash: `0x${"11".repeat(32)}` as Hex,
      platformId: platformIdOf(KEY),
      nonce: `0x${"22".repeat(32)}` as Hex,
      issuedAt: 1_790_000_000n,
    };
    expect(message.platformId).toBe("0x52fe6094743bfd4f9be4321d98adc7e23c1ab622b0ba830e271d1ee1cbfd7850");
    expect(prepareDigest(message)).toBe("0xefba7b5d6b5a0325ba9eb2e2f2f77c7659b6b8bb5d656b15f57c325b3b208977");
    expect(prepareDigest(message)).toBe(servicePrepareDigest(message));
  });

  it("signs a message the service recovers to the agent owner, with chain time and a fresh nonce", async () => {
    const agent = privateKeyToAccount(generatePrivateKey());
    const file = new TextEncoder().encode("a picture's bytes");
    const signed = await signPlatformPrepare({ file, mode: "platform", platformKey: KEY, agentAccount: agent, reader: clockAt(1_790_000_123n) });

    expect(signed.message).toMatchObject({ mode: 0, pictureHash: sha256Hex(file), platformId: platformIdOf(KEY), issuedAt: 1_790_000_123n });
    expect(signed.message.nonce).toMatch(/^0x[0-9a-f]{64}$/);
    expect(await signedByAddress(servicePrepareDigest(signed.message), signed.signature, agent.address)).toBe(true);

    const again = await signPlatformPrepare({ file, mode: "cosign", platformKey: KEY, agentAccount: agent, reader: clockAt(1_790_000_123n) });
    expect(again.message.nonce).not.toBe(signed.message.nonce);
    expect(again.message.mode).toBe(1);
  });

  it("refuses a key that is not the 64 hex characters Moolam issues, without quoting it", async () => {
    const agent = privateKeyToAccount(generatePrivateKey());
    const attempt = signPlatformPrepare({ file: new Uint8Array([1]), mode: "platform", platformKey: "not-a-real-platform-key", agentAccount: agent, reader: clockAt(1n) });
    await expect(attempt).rejects.toMatchObject({ code: "invalid-input" });
    await expect(attempt).rejects.not.toThrow(/not-a-real-platform-key/);
  });
});

describe("the passport digest", () => {
  it("is the digest the service computes for the same fields", () => {
    const input: PassportInput = {
      exactHash: `0x${"ab".repeat(32)}`,
      parentId: `0x${"00".repeat(32)}`,
      creator: getAddress("0x85a88c1e4bd2ba1d2bc3dd3f1b1e3cb9b8ae0a11"),
      generatorAgentId: 10249n,
      phash: 0x336b806a7e894e76n,
      blockhash256: "0x000f003f187f3eff1878047c3c7d3c7b3e7f00ff01ff0007000300071fff3fff",
      manifestHash: `0x${"cd".repeat(32)}`,
      kind: 0,
      fingerprintVersion: 1,
      metadataURI: "ipfs://bafkreiggnfemzyzzrs6ba2ycklbfghbmpwd6mmzcy3rxhh4ovfxkfvvzsm",
      deadline: 1_790_001_800n,
    };
    const service = servicePassportDigest({ ...input, kind: 0 }, serviceRegistryDomain(MOOLAM_REGISTRY, 143));
    expect(passportDigest(input)).toBe(service);
  });
});
