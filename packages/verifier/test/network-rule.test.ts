// Holds the service's copy of Chainlink's thumbnail rule to the workflow's own (WO-313a). It checks
// that the rule src/networkRule.ts loads takes its limits from config.network.json and
// lookalike-rule.ts and that the service's own constants are the same numbers, that it answers as
// the workflow's functions do on real thumbnails, that the esbuild bundle the compiled service
// loads answers the same as the source, and that workflow.ts still holds the rule the entry
// restates. Does NOT cover the workflow's fetching, consensus or report writing, nor the remake
// loop in makeThumbnail, which test/thumbnail-guard.test.ts covers.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import sharp from "sharp";
import { afterAll, describe, expect, it } from "vitest";
import { hammingHex as workflowHammingHex } from "../../workflow/moolam-verifier/blockhash.js";
import { decodeJpeg } from "../../workflow/moolam-verifier/decode.js";
import { dihedralFingerprints } from "../../workflow/moolam-verifier/dihedral.js";
import { LOOKALIKE_BLOCKHASH_BITS } from "../../workflow/moolam-verifier/lookalike-rule.js";
import { hamming64 as workflowHamming64 } from "../../workflow/moolam-verifier/phash.js";
import { BLOCKHASH_MATCH_THRESHOLD, PHASH_MATCH_THRESHOLD, fingerprint } from "../src/fingerprint.js";
import { networkRule, type NetworkRule } from "../src/networkRule.js";
import { FingerprintUnstable } from "../src/prepare.js";
import { generateImage } from "../scripts/guard-corpus.js";

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOW_DIR = path.join(PACKAGE_ROOT, "..", "workflow", "moolam-verifier");

const networkConfig = JSON.parse(readFileSync(path.join(WORKFLOW_DIR, "config.network.json"), "utf8")) as {
  matchThreshold: number;
};

describe("the limits", () => {
  it("are config.network.json's threshold and lookalike-rule.ts's block hash bits, the same two the service holds", async () => {
    const rule = await networkRule();

    expect(rule.phashBits).toBe(networkConfig.matchThreshold);
    expect(rule.blockhashBits).toBe(LOOKALIKE_BLOCKHASH_BITS);
    expect(PHASH_MATCH_THRESHOLD).toBe(networkConfig.matchThreshold);
    expect(BLOCKHASH_MATCH_THRESHOLD).toBe(LOOKALIKE_BLOCKHASH_BITS);
    expect(new FingerprintUnstable(1).limit).toBe(networkConfig.matchThreshold);
    expect(new FingerprintUnstable(1, "blockhash").limit).toBe(LOOKALIKE_BLOCKHASH_BITS);
  });

  it("are the ones workflow.ts applies, in the text the entry restates", () => {
    const source = readFileSync(path.join(WORKFLOW_DIR, "workflow.ts"), "utf8").replace(/\s+/g, " ");

    expect(source).toContain("const pairs = dihedralFingerprints(decodeJpeg(bytes)); const upright = pairs[0];");
    expect(source).toContain("hamming64(BigInt(upright.phash), BigInt(storedPhashHex))");
    expect(source).toContain("hammingHex(upright.blockhash, storedBlockhash)");
    expect(source).toContain(
      "matched: distance <= nodeRuntime.config.matchThreshold && blockhashDistance <= LOOKALIKE_BLOCKHASH_BITS,",
    );
  });

  it("decode with the same jpeg-js the workflow is pinned to", () => {
    const pinned = (file: string): string =>
      (JSON.parse(readFileSync(file, "utf8")) as { dependencies: Record<string, string> }).dependencies["jpeg-js"] as string;

    expect(pinned(path.join(PACKAGE_ROOT, "package.json"))).toBe(pinned(path.join(WORKFLOW_DIR, "package.json")));
    const installed = JSON.parse(
      readFileSync(path.join(PACKAGE_ROOT, "..", "..", "node_modules", "jpeg-js", "package.json"), "utf8"),
    ) as { version: string };
    expect(installed.version).toBe(pinned(path.join(WORKFLOW_DIR, "package.json")));
  });
});

/**
 * Thumbnails at three qualities of six pictures, including grainy ones whose block hash sits near
 * its limit at the lowest quality, each with the print that was registered for its own picture.
 */
async function table(): Promise<{ thumbnail: Buffer; print: Awaited<ReturnType<typeof fingerprint>> }[]> {
  const rows: { thumbnail: Buffer; print: Awaited<ReturnType<typeof fingerprint>> }[] = [];
  for (const seed of [0, 3, 5, 37, 51, 113]) {
    const picture = await generateImage(seed);
    const print = await fingerprint(picture);
    for (const quality of [85, 40, 12]) {
      const thumbnail = await sharp(picture)
        .resize({ width: 512, height: 512, fit: "inside", withoutEnlargement: true })
        .jpeg({ quality, progressive: false })
        .toBuffer();
      rows.push({ thumbnail, print });
    }
  }
  return rows;
}

/** The verdict the workflow reaches for these bytes, from its own functions and the files it reads. */
function workflowMatched(thumbnail: Buffer, stored: { phash: bigint; blockhash: string }): boolean {
  const upright = dihedralFingerprints(decodeJpeg(new Uint8Array(thumbnail)))[0];
  if (upright === undefined) {
    throw new Error("no fingerprints");
  }
  return (
    workflowHamming64(BigInt(upright.phash), stored.phash) <= networkConfig.matchThreshold &&
    workflowHammingHex(upright.blockhash, stored.blockhash) <= LOOKALIKE_BLOCKHASH_BITS
  );
}

describe("the rule's answer", () => {
  it("is the workflow's matched for the same bytes, against the picture's own print and against other pictures'", async () => {
    const rule = await networkRule();
    const rows = await table();
    let matched = 0;
    let notMatched = 0;

    for (const [index, row] of rows.entries()) {
      for (const other of [row.print, (rows[(index + 4) % rows.length] as (typeof rows)[number]).print]) {
        const answer = rule.measure(new Uint8Array(row.thumbnail), other).matched;
        expect(answer).toBe(workflowMatched(row.thumbnail, other));
        if (answer) {
          matched += 1;
        } else {
          notMatched += 1;
        }
      }
    }
    expect(matched).toBeGreaterThan(0);
    expect(notMatched).toBeGreaterThan(0);
  }, 120_000);

  it("refuses bytes the workflow's decoder cannot read, as the network would write no verdict", async () => {
    const rule = await networkRule();
    const print = (await table())[0]?.print as Awaited<ReturnType<typeof fingerprint>>;

    expect(() => rule.measure(new Uint8Array(), print)).toThrow();
    expect(() => rule.measure(new Uint8Array([1, 2, 3, 4]), print)).toThrow();
  }, 60_000);
});

describe("the bundle the compiled service loads", () => {
  const folder = mkdtempSync(path.join(tmpdir(), "network-rule-"));
  afterAll(() => rmSync(folder, { recursive: true, force: true }));

  it("answers exactly as the source does, with no import left to resolve", async () => {
    const bundle = path.join(folder, "networkRuleEntry.js");
    execFileSync(process.execPath, [path.join(PACKAGE_ROOT, "scripts", "bundle-network-rule.mjs"), bundle]);
    expect(readFileSync(bundle, "utf8")).not.toMatch(/from "\.\.\/\.\.\/workflow|from "\.\/(blockhash|decode|dihedral|phash)"/);

    const bundled = ((await import(/* @vite-ignore */ pathToFileURL(bundle).href)) as { networkRule: NetworkRule })
      .networkRule;
    const source = await networkRule();
    expect(bundled.phashBits).toBe(source.phashBits);
    expect(bundled.blockhashBits).toBe(source.blockhashBits);

    for (const row of (await table()).slice(0, 9)) {
      expect(bundled.measure(new Uint8Array(row.thumbnail), row.print)).toEqual(
        source.measure(new Uint8Array(row.thumbnail), row.print),
      );
    }
  }, 120_000);
});
