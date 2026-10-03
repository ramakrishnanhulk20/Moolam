// Covers how makeThumbnail and assertStableFingerprint hold a thumbnail to Chainlink's rule
// (WO-313a): a thumbnail the network accepts is kept as it was always made, one it rejects is made
// again at the next higher quality and then at smaller sizes, within the byte cap, and a picture
// with no thumbnail the network accepts is refused with FingerprintUnstable naming the closest miss.
// The remake order and the refusal are driven by a stand-in rule so each step is exact; the last
// test runs real pictures the old guard let through against the real rule. Does NOT cover the
// routes' answers for a refusal, which test/intake-routes.test.ts and test/unseal.test.ts cover, nor
// the rule's own agreement with the workflow, which test/network-rule.test.ts covers.

import sharp from "sharp";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { hammingHex as workflowHammingHex } from "../../workflow/moolam-verifier/blockhash.js";
import { decodeJpeg } from "../../workflow/moolam-verifier/decode.js";
import { dihedralFingerprints } from "../../workflow/moolam-verifier/dihedral.js";
import { hamming64 as workflowHamming64 } from "../../workflow/moolam-verifier/phash.js";
import { generateImage } from "../scripts/guard-corpus.js";
import type { NetworkRule } from "../src/networkRule.js";
import { transforms } from "../src/transforms.js";
import { makeImage } from "./helpers.js";

const control = vi.hoisted(() => ({ rule: undefined as NetworkRule | undefined }));

vi.mock("../src/networkRule.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/networkRule.js")>();
  return { ...real, networkRule: async () => control.rule ?? (await real.networkRule()) };
});

const { FingerprintUnstable, assertStableFingerprint, makeThumbnail, prepareOrFallback } = await import("../src/prepare.js");
const { fingerprint } = await import("../src/fingerprint.js");
const { networkRule } = await import("../src/networkRule.js");

beforeEach(() => {
  control.rule = undefined;
});

/** The width in pixels a baseline JPEG declares, read from its frame header. */
function jpegWidth(bytes: Uint8Array): number {
  for (let at = 2; at + 9 < bytes.length; ) {
    if (bytes[at] !== 0xff) {
      at += 1;
      continue;
    }
    const marker = bytes[at + 1] as number;
    if (marker >= 0xc0 && marker <= 0xc2) {
      return ((bytes[at + 7] as number) << 8) | (bytes[at + 8] as number);
    }
    at += 2 + (((bytes[at + 2] as number) << 8) | (bytes[at + 3] as number));
  }
  throw new Error("no frame header");
}

interface Call {
  width: number;
  length: number;
}

/** A stand-in rule that records every thumbnail it is asked about and answers by the distances `by` gives. */
function standIn(by: (call: Call) => { phashDistance: number; blockhashDistance: number } | "unreadable") {
  const calls: Call[] = [];
  const rule: NetworkRule = {
    phashBits: 10,
    blockhashBits: 40,
    measure(thumbnail) {
      const call = { width: jpegWidth(thumbnail), length: thumbnail.length };
      calls.push(call);
      const answer = by(call);
      if (answer === "unreadable") {
        throw new Error("the decoder cannot read this");
      }
      return { ...answer, matched: answer.phashDistance <= 10 && answer.blockhashDistance <= 40 };
    },
  };
  return { rule, calls };
}

const GOOD = { phashDistance: 2, blockhashDistance: 5 };
const picture = async (): Promise<Buffer> => await makeImage(81);

/** What makeThumbnail made before the rule was applied: 512 pixels, the highest quality from 85 down that fits, baseline. */
async function plainThumbnail(image: Buffer, cap = 60_000): Promise<Buffer> {
  const resized = sharp(image).resize({ width: 512, height: 512, fit: "inside", withoutEnlargement: true });
  let thumbnail = await resized.clone().jpeg({ quality: 85, progressive: false }).toBuffer();
  for (let quality = 80; thumbnail.length > cap && quality >= 30; quality -= 5) {
    thumbnail = await resized.clone().jpeg({ quality, progressive: false }).toBuffer();
  }
  return thumbnail;
}

describe("a thumbnail the network accepts", () => {
  it("is the one that was always made, measured once", async () => {
    const image = await picture();
    const { rule, calls } = standIn(() => GOOD);
    control.rule = rule;

    const thumbnail = await makeThumbnail(image);

    expect(thumbnail.equals(await plainThumbnail(image))).toBe(true);
    expect(calls).toHaveLength(1);
    await expect(assertStableFingerprint((await fingerprint(image)).phash, thumbnail)).resolves.toBeLessThanOrEqual(10);
  }, 60_000);
});

describe("a thumbnail the network rejects", () => {
  it("is made again at the next higher quality before any smaller size", async () => {
    const image = await picture();
    const { rule, calls } = standIn((call) => (calls.length === 1 ? { phashDistance: 2, blockhashDistance: 41 } : GOOD));
    control.rule = rule;

    const thumbnail = await makeThumbnail(image);

    expect(calls).toHaveLength(2);
    expect(jpegWidth(thumbnail)).toBe(512);
    expect(thumbnail.length).toBeGreaterThan((await plainThumbnail(image)).length);
    await expect(assertStableFingerprint((await fingerprint(image)).phash, thumbnail)).resolves.toBeLessThanOrEqual(10);
  }, 60_000);

  it("then goes to smaller sizes, largest first, and keeps the first that passes", async () => {
    const image = await picture();
    const { rule, calls } = standIn((call) => (call.width <= 384 ? GOOD : { phashDistance: 2, blockhashDistance: 41 }));
    control.rule = rule;

    const thumbnail = await makeThumbnail(image);

    expect(jpegWidth(thumbnail)).toBe(384);
    const widths = calls.map((call) => call.width);
    expect(widths.slice(-2)).toEqual([448, 384]);
    expect(widths.filter((width) => width === 512).length).toBeGreaterThanOrEqual(1);
    expect(widths).toEqual([...widths].sort((a, b) => b - a));
    await expect(assertStableFingerprint((await fingerprint(image)).phash, thumbnail)).resolves.toBeLessThanOrEqual(10);
  }, 60_000);

  it("keeps every remake inside the byte cap, the private copy's smaller cap included", async () => {
    const image = await picture();
    const cap = 6_000;
    const { rule, calls } = standIn((call) => (call.width <= 320 ? GOOD : { phashDistance: 2, blockhashDistance: 41 }));
    control.rule = rule;

    const thumbnail = await makeThumbnail(image, cap);

    expect(calls.length).toBeGreaterThan(1);
    expect(calls.every((call) => call.length <= cap)).toBe(true);
    expect(thumbnail.length).toBeLessThanOrEqual(cap);
    expect(jpegWidth(thumbnail)).toBe(320);
  }, 60_000);

  it("is refused with the closest miss when no remake passes, and the first thumbnail is what comes back", async () => {
    const image = await picture();
    const { rule, calls } = standIn((call) => ({ phashDistance: 2, blockhashDistance: 40 + call.width / 32 }));
    control.rule = rule;

    const thumbnail = await makeThumbnail(image);

    expect(thumbnail.equals(await plainThumbnail(image))).toBe(true);
    expect([...new Set(calls.map((call) => call.width))]).toEqual([512, 448, 384, 320, 256]);
    const refused = assertStableFingerprint((await fingerprint(image)).phash, thumbnail);
    await expect(refused).rejects.toBeInstanceOf(FingerprintUnstable);
    await expect(refused).rejects.toMatchObject({ distance: 48, limit: 40 });
    await expect(refused).rejects.toThrow(/block hash is 48 of 256 bits/);
  }, 60_000);

  it("names the pHash when that is the measure missed by most", async () => {
    const image = await picture();
    control.rule = standIn(() => ({ phashDistance: 25, blockhashDistance: 3 })).rule;

    const thumbnail = await makeThumbnail(image);

    await expect(assertStableFingerprint((await fingerprint(image)).phash, thumbnail)).rejects.toMatchObject({
      distance: 25,
      limit: 10,
    });
  }, 60_000);

  it("counts a thumbnail the network's decoder cannot read as not matched, and refuses when none can be read", async () => {
    const image = await picture();
    control.rule = standIn(() => "unreadable").rule;

    const thumbnail = await makeThumbnail(image);

    await expect(assertStableFingerprint((await fingerprint(image)).phash, thumbnail)).rejects.toMatchObject({
      name: "FingerprintUnstable",
      distance: 64,
    });
  }, 60_000);
});

describe("assertStableFingerprint fails closed", () => {
  it("refuses a thumbnail makeThumbnail did not make, and one made for another picture", async () => {
    const image = await picture();
    const { phash } = await fingerprint(image);
    control.rule = standIn(() => GOOD).rule;
    const made = await makeThumbnail(image);

    await expect(assertStableFingerprint(phash, await plainThumbnail(image))).rejects.toThrow(/not made by makeThumbnail/);
    await expect(assertStableFingerprint(phash ^ 1n, made)).rejects.toThrow(/not made by makeThumbnail/);
    await expect(assertStableFingerprint(phash, made)).resolves.toBeLessThanOrEqual(10);
  }, 60_000);
});

describe("with the real rule", () => {
  /** The uploads the old guard let through that master's rule marks not matched, or refused though it would match. */
  const DRIFTING: [number, string][] = [
    [51, "crop-25"],
    [66, "crop-25"],
    [87, "crop-25"],
    [113, "resize-10"],
    [86, "crop-25"],
  ];

  it("never signs an upload whose thumbnail the network would mark not matched, and remakes where a remake helps", async () => {
    const rule = await networkRule();
    let remade = 0;
    let signed = 0;

    for (const [seed, name] of DRIFTING) {
      const original = await generateImage(seed);
      const upload = (await transforms(original))[name as keyof Awaited<ReturnType<typeof transforms>>];
      const prepared = await prepareOrFallback(upload, {
        title: "drifting",
        claimGenerator: "moolam-studio/0.1.0",
        action: "c2pa.opened",
      });
      const measured = rule.measure(new Uint8Array(prepared.thumbnail), prepared.print);
      const upright = dihedralFingerprints(decodeJpeg(new Uint8Array(prepared.thumbnail)))[0];
      const workflowSays =
        workflowHamming64(BigInt(upright?.phash as string), prepared.print.phash) <= rule.phashBits &&
        workflowHammingHex(upright?.blockhash as string, prepared.print.blockhash) <= rule.blockhashBits;
      expect(measured.matched).toBe(workflowSays);

      const outcome = await assertStableFingerprint(prepared.print.phash, prepared.thumbnail).then(
        () => "signed",
        (error: unknown) => (error instanceof FingerprintUnstable ? "refused" : Promise.reject(error)),
      );
      if (outcome === "signed") {
        signed += 1;
        expect(measured.matched).toBe(true);
      }
      if (!(await plainThumbnail(prepared.bytes)).equals(prepared.thumbnail)) {
        remade += 1;
      }
    }
    expect(signed).toBeGreaterThan(0);
    expect(remade).toBeGreaterThan(0);
  }, 300_000);
});
