// Attack 1 of the second attack pass: a hostile RPC answers hashPassport with the digest of a
// different passport, so the creator's passkey would sign the attacker's picture while the screen
// shows their own.
// The chain read is stubbed here, which is the whole point: the browser is being lied to on
// purpose. Nothing is sent and no network is touched.
// Does NOT cover the registry's side of the same attack. The contract binds the digest to the
// struct it was handed, and that half is executed on a fork of Monad mainnet by
// packages/agents/scripts/attack-pass-2.ts, attack 1b.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Hex } from "viem";
import { describe, expect, it, vi } from "vitest";
import type { PassportInput } from "@/lib/chain/calldata";
import { DigestMismatch, assertDigestMatches, localPassportDigest } from "@/lib/chain/digest";

const chain = vi.hoisted(() => ({ hashPassport: vi.fn() }));

vi.mock("@/lib/chain/registry", () => ({ hashPassport: chain.hashPassport }));

const { hashPassport } = await import("@/lib/chain/registry");

const CREATOR = "0x559F357aDa3A96d11AEa679eC0D622E4AF15F67c" as Hex;

/** What the creator sees on screen and believes they are signing. */
const MINE: PassportInput = {
  exactHash: `0x${"ab".repeat(32)}`,
  parentId: `0x${"00".repeat(32)}`,
  creator: CREATOR,
  generatorAgentId: 0n,
  phash: 17297841240124424192n,
  blockhash256: `0x${"cd".repeat(32)}`,
  manifestHash: `0x${"00".repeat(32)}`,
  kind: 0,
  fingerprintVersion: 1,
  metadataURI: "ipfs://bafkreimine",
  deadline: 1_788_878_342n,
};

/** The same creator, the attacker's picture and the attacker's metadata. */
const THEIRS: PassportInput = {
  ...MINE,
  exactHash: `0x${"ba".repeat(32)}`,
  metadataURI: "ipfs://bafkreitheirs",
};

/**
 * The two lines the studio runs before it touches the passkey, in their order: build the digest
 * here, ask the registry for its own, and only then prompt.
 */
async function signStep(input: PassportInput, prompt: () => void): Promise<Hex> {
  const digest = localPassportDigest(input);
  assertDigestMatches(digest, await hashPassport(input));
  prompt();
  return digest;
}

describe("a hostile RPC answering with another passport's digest", () => {
  it("is refused before the passkey is prompted", async () => {
    chain.hashPassport.mockResolvedValue(localPassportDigest(THEIRS));
    const prompt = vi.fn();

    await expect(signStep(MINE, prompt)).rejects.toThrow(DigestMismatch);
    expect(prompt).not.toHaveBeenCalled();
  });

  it("names both digests, so the refusal says what disagreed", async () => {
    chain.hashPassport.mockResolvedValue(localPassportDigest(THEIRS));

    const refusal = await signStep(MINE, () => undefined).catch((error: unknown) => error as DigestMismatch);

    expect(refusal).toBeInstanceOf(DigestMismatch);
    expect(refusal.local).toBe(localPassportDigest(MINE));
    expect(refusal.fromChain).toBe(localPassportDigest(THEIRS));
    expect(refusal.local).not.toBe(refusal.fromChain);
  });

  it("lets an honest answer through, so the refusal is the lie and not the check", async () => {
    chain.hashPassport.mockResolvedValue(localPassportDigest(MINE));
    const prompt = vi.fn();

    await expect(signStep(MINE, prompt)).resolves.toBe(localPassportDigest(MINE));
    expect(prompt).toHaveBeenCalledTimes(1);
  });

  it("is checked before the prompt in the studio itself, not only in this test", () => {
    const source = readFileSync(fileURLToPath(new URL("../../lib/studio/useStudio.ts", import.meta.url)), "utf8");
    const body = source.slice(source.indexOf("const registerImage = useCallback"));

    const checked = body.indexOf("assertDigestMatches(digest, await hashPassport(input))");
    const prompted = body.indexOf("await signDigest(");

    expect(checked).toBeGreaterThan(-1);
    expect(checked).toBeLessThan(prompted);
  });
});
