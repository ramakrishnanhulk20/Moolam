// Covers what the platform routes keep in the data folder across a restart and the checks the
// pending store makes on every read and every step: the nonce memory, the per-key quota and the
// platform day ceiling each read back by a fresh instance; a nonce file that cannot be believed
// closes prepares; a pending record's fixed fields and set-once fields cannot be rewritten by a
// step, an expired record cannot move, and a frozen file whose bytes changed is refused. Also the
// key check: an unknown key, a key outside its entry's window and a malformed header find no entry;
// and the signature rule the routes share with the registry's ECDSA: high s, v of 0 or 1 and a
// short signature are refused.
// Does NOT cover the routes themselves (platform-routes.test.ts does), several processes sharing one
// folder, or a writer who recomputes every digest in a record to match.

import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { getAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterAll, describe, expect, it } from "vitest";
import { dailyQuota, fileQuotaStore } from "../src/generate/quota.js";
import { fileDayStore, globalDay } from "../src/limits/globalDay.js";
import { buildFileSet } from "../src/platform/files.js";
import { platformForKey } from "../src/platform/key.js";
import { fileNonceStore, nonceMemory } from "../src/platform/nonces.js";
import { fieldsDigest, registryDomain, signingDigest, type PassportFields } from "../src/platform/passport.js";
import {
  FrozenFileChanged,
  expiredFrom,
  handleHash,
  newHandle,
  pendingStore,
  type PendingRecord,
} from "../src/platform/pending.js";
import { recoverLikeRegistry, signedByAddress } from "../src/platform/signatures.js";
import type { Platform } from "../src/platforms/platforms.js";
import { PLATFORM_STATE_FILES } from "../src/stateDir.js";

const made: string[] = [];
function folder(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "moolam-platform-state-"));
  made.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

const bytes32 = (byte: string): Hex => `0x${byte.repeat(64)}`;
const NOW = 1_800_000_000n;
const dom = registryDomain();
const creator = getAddress("0xa11ce00000000000000000000000000000000001");

function freshRecord(handle: string): { record: PendingRecord; files: ReturnType<typeof buildFileSet> } {
  const image = randomBytes(2048);
  const set = buildFileSet({
    slug: "state-test",
    image,
    thumbnail: randomBytes(512),
    manifestDoc: { manifestHash: bytes32("c") },
    metadata: (uris) => ({ name: "state test", ...uris }),
  });
  const fields: PassportFields = {
    exactHash: set.entries.image.sha256 as Hex,
    parentId: bytes32("0"),
    generatorAgentId: "42",
    phash: "12345",
    blockhash256: bytes32("b"),
    manifestHash: bytes32("c"),
    kind: 0,
    fingerprintVersion: 1,
    metadataURI: `ipfs://${set.entries.metadata.cid}`,
  };
  return {
    files: set,
    record: {
      version: 1,
      handleHash: handleHash(handle),
      keyHash: bytes32("d"),
      platformName: "Acme Images",
      agentId: "42",
      fields,
      files: set.entries,
      fieldsDigest: fieldsDigest(fields, dom),
      createdAt: Number(NOW),
      openBy: Number(NOW + 1800n),
      state: "awaiting-creator",
      creator: null,
      deadline: null,
      digest: null,
      agentSignature: null,
    },
  };
}

describe("platform state across a restart", () => {
  it("keeps the nonce memory, and refuses a replay after the restart", () => {
    const file = path.join(folder(), PLATFORM_STATE_FILES.nonces);
    const seen = { platform: bytes32("a"), nonce: bytes32("1"), picture: bytes32("2"), expiresAt: Number(NOW + 600n) };
    expect(nonceMemory(fileNonceStore(file)).accept(seen, NOW)).toEqual({ ok: true });

    const after = nonceMemory(fileNonceStore(file));
    expect(after.accept({ ...seen, picture: bytes32("3") }, NOW + 10n)).toEqual({ ok: false, reason: "replayed" });
    expect(after.accept({ ...seen, nonce: bytes32("4") }, NOW + 10n)).toEqual({ ok: false, reason: "same-picture" });
    expect(after.accept({ ...seen, platform: bytes32("b") }, NOW + 10n)).toEqual({ ok: true });
    // Past the window the old entry is gone, and a replay there fails on time in the route instead.
    expect(nonceMemory(fileNonceStore(file)).accept(seen, NOW + 601n)).toEqual({ ok: true });
  });

  it("closes every prepare for one window after a nonce file it cannot believe", () => {
    const file = path.join(folder(), PLATFORM_STATE_FILES.nonces);
    writeFileSync(file, "{not json");
    let clock = 0;
    const memory = nonceMemory(fileNonceStore(file), { clockMs: () => clock });
    const seen = { platform: bytes32("a"), nonce: bytes32("1"), picture: bytes32("2"), expiresAt: Number(NOW + 600n) };
    expect(memory.accept(seen, NOW)).toEqual({ ok: false, reason: "closed" });
    clock = 600_001;
    expect(memory.accept(seen, NOW)).toEqual({ ok: true });
  });

  it("keeps the per-key quota and the platform day ceiling", () => {
    const dir = folder();
    const quotaFile = path.join(dir, PLATFORM_STATE_FILES.quota);
    const key = bytes32("e");
    expect(dailyQuota(1, { store: fileQuotaStore(quotaFile), now: () => 1000 }).take(key).ok).toBe(true);
    expect(dailyQuota(1, { store: fileQuotaStore(quotaFile), now: () => 2000 }).take(key).ok).toBe(false);

    const dayFile = path.join(dir, PLATFORM_STATE_FILES.dayCeiling);
    const max = { prepares: 1, generations: 0, edits: 0, unseals: 0, links: 0 };
    expect(globalDay(max, () => 1000, { store: fileDayStore(dayFile) }).tryTake("prepares").ok).toBe(true);
    expect(globalDay(max, () => 2000, { store: fileDayStore(dayFile) }).tryTake("prepares").ok).toBe(false);
  });

  it("keeps a pending record, readable by a fresh store on the same folder", () => {
    const dir = folder();
    const handle = newHandle();
    const { record, files } = freshRecord(handle);
    pendingStore(dir, dom).create(handle, record, files.bytes);
    const opened = pendingStore(dir, dom).open(handle);
    expect(opened.kind).toBe("record");
    // The handle itself is never a file name.
    expect(readdirSync(dir).some((name) => name.includes(handle))).toBe(false);
  });
});

describe("the pending store's checks", () => {
  it("lets each step set its own fields once and refuses a step that rewrites a fixed or set field", () => {
    const store = pendingStore(folder(), dom);
    const handle = newHandle();
    const { record, files } = freshRecord(handle);
    store.create(handle, record, files.bytes);

    const deadline = NOW + 1800n;
    const setCreator = (current: PendingRecord, who: string): PendingRecord =>
      ({
        ...current,
        state: "creator-set",
        creator: who,
        deadline: Number(deadline),
        digest: signingDigest(current.fields as PassportFields, who, deadline, dom),
      }) as PendingRecord;

    const rewritten = store.advance(handle, "awaiting-creator", (current) => ({
      ...setCreator(current, creator),
      fields: { ...current.fields, generatorAgentId: "43" },
    }));
    expect(rewritten).toMatchObject({ kind: "refused" });

    expect(store.advance(handle, "awaiting-creator", (current) => setCreator(current, creator)).kind).toBe("record");
    // The same step again finds the record already past it.
    const again = store.advance(handle, "awaiting-creator", (current) => setCreator(current, getAddress(`0x${"b".repeat(40)}`)));
    expect(again).toMatchObject({ kind: "refused" });
    expect(store.open(handle)).toMatchObject({ kind: "record", record: { creator } });

    const expired = store.advance(handle, "creator-set", (current) => expiredFrom(current, NOW + 2000n));
    expect(expired.kind).toBe("record");
    for (const from of ["awaiting-creator", "creator-set", "signed", "expired"] as const) {
      expect(store.advance(handle, from, (current) => current).kind).toBe("refused");
    }
  });

  it("refuses a frozen file whose bytes changed on disk", () => {
    const dir = folder();
    const store = pendingStore(dir, dom);
    const handle = newHandle();
    const { record, files } = freshRecord(handle);
    store.create(handle, record, files.bytes);
    expect(store.frozen(handle, record, "image").equals(files.bytes.image)).toBe(true);

    const lookup = createHash("sha256").update(Buffer.from(handle, "hex")).digest("hex");
    writeFileSync(path.join(dir, lookup, "image.bin"), randomBytes(2048));
    expect(() => store.frozen(handle, record, "image")).toThrow(FrozenFileChanged);
  });

  it("clears a record past its keep time and counts only waiting records toward a key's bytes", () => {
    const store = pendingStore(folder(), dom);
    const handle = newHandle();
    const { record, files } = freshRecord(handle);
    store.create(handle, record, files.bytes);
    const total = Object.values(record.files).reduce((sum, one) => sum + one.bytes, 0);
    expect(store.heldBytes(record.keyHash, NOW)).toBe(total);
    expect(store.heldBytes(bytes32("f"), NOW)).toBe(0);
    expect(store.heldBytes(record.keyHash, NOW + 1800n + 86_401n)).toBe(0);
    expect(store.open(handle)).toEqual({ kind: "missing" });
  });
});

describe("the signature rule", () => {
  const ORDER = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
  const signer = privateKeyToAccount(`0x${"41".repeat(32)}`);
  const digest = bytes32("7");

  it("takes a low-s signature with v 27 or 28 and refuses the other forms the registry's ECDSA refuses", async () => {
    const good = await signer.sign({ hash: digest });
    expect(await recoverLikeRegistry(digest, good)).toBe(signer.address);

    const r = good.slice(2, 66);
    const s = BigInt(`0x${good.slice(66, 130)}`);
    const v = Number.parseInt(good.slice(130), 16);
    const highS = `0x${r}${(ORDER - s).toString(16).padStart(64, "0")}${(v === 27 ? 28 : 27).toString(16)}`;
    const zeroV = `0x${r}${good.slice(66, 130)}${(v - 27).toString(16).padStart(2, "0")}`;
    expect(await recoverLikeRegistry(digest, highS)).toBeUndefined();
    expect(await recoverLikeRegistry(digest, zeroV)).toBeUndefined();
    expect(await recoverLikeRegistry(digest, good.slice(0, 130))).toBeUndefined();
    expect(await signedByAddress(digest, good, signer.address.toLowerCase())).toBe(true);
    expect(await signedByAddress(digest, good, getAddress(`0x${"9".repeat(40)}`))).toBe(false);
  });
});

describe("the key check", () => {
  const key = randomBytes(32).toString("hex");
  const entry = (validFrom: bigint, validTo: bigint | null): Platform => ({
    name: "Acme Images",
    agentId: 42n,
    ownerAtOnboarding: getAddress(`0x${"1".repeat(40)}`),
    creatorWallet: getAddress(`0x${"2".repeat(40)}`),
    keyHash: `0x${createHash("sha256").update(Buffer.from(key, "hex")).digest("hex")}`,
    origins: ["https://acme.example"],
    validFrom,
    validTo,
    acceptedAt: validFrom,
  });

  it("finds the entry for its key, in either case, only inside the entry's window", () => {
    const listed = [entry(100n, 200n)];
    expect(platformForKey(`Bearer ${key}`, listed, 150n)?.name).toBe("Acme Images");
    expect(platformForKey(`Bearer ${key.toUpperCase()}`, listed, 150n)?.name).toBe("Acme Images");
    expect(platformForKey(`Bearer ${key}`, listed, 99n)).toBeUndefined();
    expect(platformForKey(`Bearer ${key}`, listed, 200n)).toBeUndefined();
    expect(platformForKey(`Bearer ${randomBytes(32).toString("hex")}`, listed, 150n)).toBeUndefined();
    expect(platformForKey(`Bearer ${key}x`, listed, 150n)).toBeUndefined();
    expect(platformForKey(undefined, listed, 150n)).toBeUndefined();
  });
});
