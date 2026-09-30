// Covers the platform list's loader and the one label predicate: signatures recovered offline,
// the whole list refused on any bad entry, names colliding after NFKC, case fold and trim, and
// the label's terms including a rotation.
// Does NOT cover the operator script's command line, the web app's copy (platforms-copy.test.ts
// in packages/web does), ownerOf read from the chain (agentOwnerUnchanged is only given a stub
// here), smart contract wallets as signers (only plain keys can sign an entry), or look-alike
// letters from two scripts, which the name rule does not claim to catch.

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Hex } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import {
  agentOwnerUnchanged,
  loadPlatforms,
  nameKey,
  onboardingTypedData,
  platformLabel,
  recordMessage,
  type LabelPassport,
  type Platform,
  type PlatformRecord,
} from "../src/platforms/platforms.js";

const acmeOwner = privateKeyToAccount(`0x${"11".repeat(32)}`);
const acmeCreator = privateKeyToAccount(`0x${"12".repeat(32)}`);
const acmeNewCreator = privateKeyToAccount(`0x${"13".repeat(32)}`);
const loomOwner = privateKeyToAccount(`0x${"21".repeat(32)}`);
const loomCreator = privateKeyToAccount(`0x${"22".repeat(32)}`);
const stranger = privateKeyToAccount(`0x${"99".repeat(32)}`);

function keyHash(seed: string): string {
  return `0x${createHash("sha256").update(seed).digest("hex")}`;
}

interface Draft {
  name: string;
  agentId: string;
  owner: PrivateKeyAccount;
  creator: PrivateKeyAccount;
  key: string;
  validFrom: number;
  validTo?: number;
}

async function signed(draft: Draft): Promise<PlatformRecord> {
  const unsigned: PlatformRecord = {
    name: draft.name,
    agentId: draft.agentId,
    ownerAtOnboarding: draft.owner.address,
    creatorWallet: draft.creator.address,
    keyHash: keyHash(draft.key),
    validFrom: draft.validFrom,
    ...(draft.validTo === undefined ? {} : { validTo: draft.validTo }),
    acceptedAt: draft.validFrom,
    ownerSignature: "",
    creatorSignature: "",
  };
  const typed = onboardingTypedData(recordMessage(unsigned));
  return {
    ...unsigned,
    ownerSignature: await draft.owner.signTypedData(typed),
    creatorSignature: await draft.creator.signTypedData(typed),
  };
}

const acme: Draft = { name: "Acme Images", agentId: "42", owner: acmeOwner, creator: acmeCreator, key: "acme-1", validFrom: 1_000 };
const loom: Draft = { name: "Loom Studio", agentId: "77", owner: loomOwner, creator: loomCreator, key: "loom-1", validFrom: 1_000 };

function passport(overrides: Partial<LabelPassport> = {}): LabelPassport {
  return {
    creator: acmeCreator.address.toLowerCase(),
    kind: 0,
    generatorAgentId: 42n,
    manifestHash: `0x${"ab".repeat(32)}`,
    registeredAt: 1_500n,
    ...overrides,
  };
}

async function loaded(records: PlatformRecord[]): Promise<Platform[]> {
  const list = await loadPlatforms(records);
  if (!list.ok) throw new Error(list.reason);
  return list.platforms;
}

describe("loadPlatforms", () => {
  it("loads a valid two-entry list with checksummed addresses and bigint ids", async () => {
    const records = [await signed(acme), await signed(loom)];
    records[0] = { ...records[0]!, creatorWallet: acmeCreator.address.toLowerCase() };
    const platforms = await loaded(records);
    expect(platforms.map((platform) => platform.name)).toEqual(["Acme Images", "Loom Studio"]);
    expect(platforms[0]!.agentId).toBe(42n);
    expect(platforms[0]!.creatorWallet).toBe(acmeCreator.address);
    expect(platforms[0]!.validTo).toBeNull();
  });

  it("starts with the shipped list empty and accepted", async () => {
    expect(await loadPlatforms()).toEqual({ ok: true, platforms: [] });
  });

  it.each([
    ["name", { name: "Acme Imagez" }],
    ["agent id", { agentId: "43" }],
    ["key hash", { keyHash: keyHash("someone else's key") }],
    ["owner signature", { ownerSignature: "0x" + "ab".repeat(65) }],
  ] as const)("refuses the whole list when one entry's %s is tampered", async (_field, change) => {
    const good = await signed(loom);
    const tampered = { ...(await signed(acme)), ...change };
    const list = await loadPlatforms([good, tampered]);
    expect(list.ok).toBe(false);
    expect(list.platforms).toEqual([]);
    if (!list.ok) expect(list.reason).toMatch(/^entry 1: /);
  });

  it("refuses a creator signature made by someone other than the creator wallet", async () => {
    const record = await signed(acme);
    const typed = onboardingTypedData(recordMessage(record));
    const list = await loadPlatforms([{ ...record, creatorSignature: await stranger.signTypedData(typed) }]);
    expect(list).toMatchObject({ ok: false, reason: "entry 0: creator signature does not recover to creatorWallet" });
  });

  it("refuses a second platform whose name matches after NFKC, case fold and trim", async () => {
    expect(nameKey("  ＡＣＭＥ　images ")).toBe(nameKey("Acme Images"));
    expect(nameKey("STRASSE")).toBe(nameKey("Straße"));
    const clash = await signed({ ...loom, name: "ACME images" });
    const list = await loadPlatforms([await signed(acme), clash]);
    expect(list).toMatchObject({ ok: false, platforms: [], reason: "entries 0 and 1: the same name in two spellings" });
  });

  it("refuses a name stored in any form but its cleaned one, even when correctly signed", async () => {
    for (const name of [" Acme Images", "ＡＣＭＥ Images", "Acme  Images", "Acme​Images"]) {
      const list = await loadPlatforms([await signed({ ...acme, name })]);
      expect(list.ok).toBe(false);
    }
  });

  it("refuses two windows of one platform that overlap", async () => {
    const first = await signed(acme);
    const second = await signed({ ...acme, creator: acmeNewCreator, key: "acme-2", validFrom: 2_000 });
    expect(await loadPlatforms([first, second])).toMatchObject({ ok: false, reason: "entries 0 and 1: two windows of one platform overlap" });
  });
});

describe("platformLabel", () => {
  it("gives the label before a rotation and not after it", async () => {
    const platforms = await loaded([
      await signed({ ...acme, validTo: 2_000 }),
      await signed({ ...acme, creator: acmeNewCreator, key: "acme-2", validFrom: 2_000 }),
    ]);
    expect(platformLabel(passport({ registeredAt: 1_999n }), platforms, 3_000n)).toMatchObject({ status: "kit", name: "Acme Images" });
    expect(platformLabel(passport({ registeredAt: 2_000n }), platforms, 3_000n)).toMatchObject({ status: "outsideKit", name: "Acme Images" });
    const fromNewWallet = passport({ creator: acmeNewCreator.address, registeredAt: 2_000n });
    expect(platformLabel(fromNewWallet, platforms, 3_000n)).toMatchObject({ status: "kit", name: "Acme Images" });
  });

  it("reads a Captured passport from a listed wallet as outside the kit", async () => {
    const platforms = await loaded([await signed(acme)]);
    expect(platformLabel(passport({ kind: 1 }), platforms, 3_000n)).toMatchObject({ status: "outsideKit", name: "Acme Images" });
  });

  it.each([
    ["a wrong agent id", { generatorAgentId: 43n }],
    ["a zero manifestHash", { manifestHash: `0x${"0".repeat(64)}` }],
    ["a registeredAt before validFrom", { registeredAt: 999n }],
    ["a registeredAt after now", { registeredAt: 3_001n }],
  ] as const)("gives no label for %s", async (_case, change) => {
    const platforms = await loaded([await signed(acme)]);
    expect(platformLabel(passport(change), platforms, 3_000n)?.status).toBe("outsideKit");
  });

  it("gives nothing for an unlisted creator or a creator that is not an address", async () => {
    const platforms = await loaded([await signed(acme)]);
    expect(platformLabel(passport({ creator: stranger.address }), platforms, 3_000n)).toBeNull();
    expect(platformLabel(passport({ creator: "not an address" }), platforms, 3_000n)).toBeNull();
  });
});

describe("agentOwnerUnchanged", () => {
  it("holds only while the owner read now is the owner that signed, and fails closed on a read error", async () => {
    const [platform] = await loaded([await signed(acme)]);
    expect(await agentOwnerUnchanged(platform!, async () => acmeOwner.address.toLowerCase() as Hex)).toBe(true);
    expect(await agentOwnerUnchanged(platform!, async () => stranger.address)).toBe(false);
    expect(await agentOwnerUnchanged(platform!, async () => Promise.reject(new Error("rpc down")))).toBe(false);
  });
});
