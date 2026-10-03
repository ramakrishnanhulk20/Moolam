// Measures the thumbnail guard against what Chainlink's network does with the same thumbnail.
//
//   npx tsx scripts/guard-measure.ts before [path-to-the-old-prepare-module]
//       also reads every passport registered since the network went live, and writes guard-before.txt
//   npx tsx scripts/guard-measure.ts after
//       the corpus only, and writes guard-after.txt
//
// For each of the robustness proof's 24 pictures and its 15 transforms, used as an upload, and for
// 96 more pictures from the same generator, it runs the service's own prepareOrFallback and the
// guard the routes call (assertStableFingerprint), then measures the thumbnail the way the workflow
// does, with the workflow's own decode and fingerprint code and nothing of this service's, against
// the print that would be registered. The 24 pictures hold no failure today; the 96 are where the
// guard's gap shows.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { PACKAGE_ROOT } from "../src/env.js";
import * as currentPrepare from "../src/prepare.js";
import { transforms } from "../src/transforms.js";
import { hammingHex } from "../../workflow/moolam-verifier/blockhash.js";
import { decodeJpeg } from "../../workflow/moolam-verifier/decode.js";
import { dihedralFingerprints } from "../../workflow/moolam-verifier/dihedral.js";
import { LOOKALIKE_BLOCKHASH_BITS } from "../../workflow/moolam-verifier/lookalike-rule.js";
import { hamming64 } from "../../workflow/moolam-verifier/phash.js";
import { choosePicture, type RecordReply } from "../../workflow/moolam-verifier/picture.js";
import { pinnedFetchUrl } from "../../workflow/moolam-verifier/pinned.js";
import { CORPUS_SIZE, generateImage } from "./guard-corpus.js";

const REPO_ROOT = path.resolve(PACKAGE_ROOT, "..", "..");
const NETWORK_CONFIG = path.join(REPO_ROOT, "packages", "workflow", "moolam-verifier", "config.network.json");
const INDEX_URL = "https://indexer.dev.hyperindex.xyz/95bf5b3/v1/graphql";
const SINCE = 1790924898;
const WIDER_FIRST_SEED = CORPUS_SIZE;
const WIDER_LAST_SEED = 119;

interface NetworkConfig {
  matchThreshold: number;
  gateway: string;
  verifierUrl: string;
}

interface Distances {
  phash: number;
  blockhash: number;
}

/** The workflow's own measurement of one thumbnail, or why it could not make one. */
function networkDistances(thumbnail: Uint8Array, stored: { phash: bigint; blockhash: string }): Distances | string {
  try {
    const upright = dihedralFingerprints(decodeJpeg(thumbnail))[0];
    if (upright === undefined) {
      return "no fingerprints";
    }
    return {
      phash: hamming64(BigInt(upright.phash), stored.phash),
      blockhash: hammingHex(upright.blockhash, stored.blockhash),
    };
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

interface Row {
  set: "robustness" | "wider";
  label: string;
  guardPasses: boolean;
  guardDistance: number | undefined;
  network: Distances | string;
}

const masterMatched = (row: Row, threshold: number): boolean =>
  typeof row.network !== "string" && row.network.phash <= threshold && row.network.blockhash <= LOOKALIKE_BLOCKHASH_BITS;

const pHashOnlyMatched = (row: Row, threshold: number): boolean =>
  typeof row.network !== "string" && row.network.phash <= threshold;

async function measureCorpus(prepare: typeof currentPrepare): Promise<Row[]> {
  const { FingerprintUnstable, assertStableFingerprint, prepareOrFallback } = prepare;
  const rows: Row[] = [];
  for (let seed = 0; seed <= WIDER_LAST_SEED; seed += 1) {
    const original = await generateImage(seed);
    const uploads: [string, Buffer][] = [["original", original], ...Object.entries(await transforms(original))];
    for (const [name, upload] of uploads) {
      const prepared = await prepareOrFallback(upload, {
        title: "guard measure",
        claimGenerator: "moolam-guard-measure/1",
        action: "c2pa.opened",
      });
      let guardPasses = true;
      let guardDistance: number | undefined;
      try {
        guardDistance = await assertStableFingerprint(prepared.print.phash, prepared.thumbnail);
      } catch (error) {
        if (!(error instanceof FingerprintUnstable)) {
          throw error;
        }
        guardPasses = false;
        guardDistance = error.distance;
      }
      rows.push({
        set: seed < WIDER_FIRST_SEED ? "robustness" : "wider",
        label: `seed ${String(seed).padStart(2, "0")} ${name}`,
        guardPasses,
        guardDistance,
        network: networkDistances(new Uint8Array(prepared.thumbnail), {
          phash: prepared.print.phash,
          blockhash: prepared.print.blockhash,
        }),
      });
    }
    process.stderr.write(`  measured seed ${seed} of ${WIDER_LAST_SEED}\n`);
  }
  return rows;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The gateway answers 500 to a cold request and 200 to the next one, so a 5xx is asked again. */
async function fetchBytes(url: string): Promise<{ status: number; bytes: Buffer }> {
  for (let attempt = 1; ; attempt += 1) {
    const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    const answer = { status: response.status, bytes: Buffer.from(await response.arrayBuffer()) };
    if (answer.status < 500 || attempt === 3) {
      return answer;
    }
    await sleep(3000);
  }
}

interface IndexedPassport {
  id: string;
  phash: string;
  blockhash: string;
  registeredAt: string;
  metadataURI: string;
  attestations: { receiver: string; matched: boolean; distance: number; at: string }[];
}

async function indexedPassports(): Promise<IndexedPassport[]> {
  const query = `query { Passport(where: { registeredAt: { _gte: "${SINCE}" } }, order_by: { registeredAt: asc }, limit: 500) {
    id phash blockhash registeredAt metadataURI
    attestations(order_by: { at: desc }, limit: 3) { receiver matched distance at }
  } }`;
  // The hosted index is shared and rate limited, so a refused or empty answer is tried again a few
  // times, seconds apart, and every try counts toward the 100 queries the order allows.
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const response = await fetch(INDEX_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query }),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await response.text();
    try {
      const body = JSON.parse(text) as { data?: { Passport: IndexedPassport[] }; errors?: unknown };
      if (body.data !== undefined) {
        return body.data.Passport;
      }
    } catch {
      // Falls through to the wait below.
    }
    process.stderr.write(`  index answered ${response.status} (${text.slice(0, 120)}), try ${attempt} of 4\n`);
    await sleep(5000 * attempt);
  }
  throw new Error("the index gave no passports after 4 tries");
}

async function measurePassports(config: NetworkConfig): Promise<string[]> {
  const lines: string[] = [];
  const passports = await indexedPassports();
  lines.push(`Passports registered at or after ${SINCE}: ${passports.length} (1 index query).`);
  let notMatched = 0;
  let pHashOnlyNotMatched = 0;
  for (const passport of passports) {
    await sleep(1000);
    const stored = { phash: BigInt(passport.phash), blockhash: passport.blockhash };
    const documentUrl = pinnedFetchUrl(config.gateway, passport.metadataURI);
    let verdict: string;
    if (documentUrl === null) {
      verdict = `metadata address is not an ipfs:// reference (${passport.metadataURI.slice(0, 12)})`;
    } else {
      const document = await fetchBytes(documentUrl);
      if (document.status !== 200) {
        verdict = `metadata fetch answered ${document.status}`;
      } else {
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(document.bytes.toString("utf8")) as Record<string, unknown>;
        } catch {
          parsed = {};
        }
        let choice = choosePicture(parsed, passport.id, config.gateway);
        if (choice.kind === "ask-record") {
          await sleep(1000);
          const record = await fetchBytes(`${config.verifierUrl}/unseal/${passport.id}`);
          const reply: RecordReply = { status: record.status, body: record.bytes.toString("utf8") };
          choice = choosePicture(parsed, passport.id, config.gateway, reply);
        }
        if (choice.kind !== "fetch") {
          verdict = choice.kind === "refused" ? choice.reason : "no picture to check";
        } else {
          await sleep(1000);
          const thumbnail = await fetchBytes(choice.url);
          if (thumbnail.status !== 200) {
            verdict = `thumbnail ${choice.reference} fetch answered ${thumbnail.status}`;
          } else {
            const network = networkDistances(new Uint8Array(thumbnail.bytes), stored);
            const row: Row = { set: "robustness", label: passport.id, guardPasses: true, guardDistance: undefined, network };
            const master = masterMatched(row, config.matchThreshold);
            const only = pHashOnlyMatched(row, config.matchThreshold);
            notMatched += master ? 0 : 1;
            pHashOnlyNotMatched += only ? 0 : 1;
            const distances = typeof network === "string" ? `cannot measure: ${network}` : `pHash ${network.phash}, blockhash ${network.blockhash}`;
            const said = passport.attestations.map((a) => `${a.receiver.slice(0, 8)} matched=${a.matched} distance=${a.distance}`).join("; ") || "no attestation";
            verdict = `${choice.reference} ${thumbnail.bytes.length} bytes, ${distances}, master rule ${master ? "matched" : "NOT matched"}, pHash-only rule ${only ? "matched" : "NOT matched"}; chain: ${said}`;
          }
        }
      }
    }
    lines.push(`  ${passport.id} registered ${passport.registeredAt} stored ${passport.phash} ${passport.blockhash.slice(0, 18)}...`);
    lines.push(`    ${verdict}`);
  }
  lines.push(`Master's rule marks ${notMatched} of ${passports.length} not matched. The pHash-only rule marks ${pHashOnlyNotMatched} not matched.`);
  return lines;
}

const bits = (row: Row): string => (typeof row.network === "string" ? row.network : `${row.network.phash}, ${row.network.blockhash}`);

function summarise(title: string, rows: Row[], threshold: number): string[] {
  const passes = rows.filter((row) => row.guardPasses);
  const passesButMasterNotMatched = passes.filter((row) => !masterMatched(row, threshold));
  const passesButPHashOnlyNotMatched = passes.filter((row) => !pHashOnlyMatched(row, threshold));
  const refusedButMatched = rows.filter((row) => !row.guardPasses && masterMatched(row, threshold));
  const worst = (pick: (distances: Distances) => number): number =>
    Math.max(0, ...passes.map((row) => (typeof row.network === "string" ? 0 : pick(row.network))));
  return [
    title,
    `  Uploads: ${rows.length}`,
    `  The service guard passes: ${passes.length}. It refuses: ${rows.length - passes.length}.`,
    `  Guard passes and master's rule marks NOT matched: ${passesButMasterNotMatched.length}`,
    `  Guard passes and the pHash-only rule marks NOT matched: ${passesButPHashOnlyNotMatched.length}`,
    `  Guard refuses but master's rule would have matched: ${refusedButMatched.length}`,
    `  Network cannot measure the thumbnail at all: ${rows.filter((row) => typeof row.network === "string").length}`,
    `  Worst network distances over the uploads the guard passes: pHash ${worst((d) => d.phash)} of 64, blockhash ${worst((d) => d.blockhash)} of 256`,
    "  Uploads the guard passes that master's rule marks not matched (pHash bits, blockhash bits):",
    ...(passesButMasterNotMatched.length === 0 ? ["    none"] : passesButMasterNotMatched.map((row) => `    ${row.label}: ${bits(row)}`)),
    "  Every upload the guard refuses (guard distance; pHash bits, blockhash bits):",
    ...(passes.length === rows.length ? ["    none"] : rows.filter((row) => !row.guardPasses).map((row) => `    ${row.label}: ${row.guardDistance}; ${bits(row)}`)),
    "  Uploads the guard refuses that master's rule would have matched (guard distance; pHash bits, blockhash bits):",
    ...(refusedButMatched.length === 0
      ? ["    none"]
      : refusedButMatched.map((row) => `    ${row.label}: ${row.guardDistance}; ${bits(row)}`)),
  ];
}

async function main(): Promise<void> {
  const label = process.argv[2];
  if (label !== "before" && label !== "after") {
    throw new Error("say which run this is: before or after");
  }
  const prepare: typeof currentPrepare = process.argv[3] === undefined ? currentPrepare : await import(process.argv[3]);
  const config = JSON.parse(await readFile(NETWORK_CONFIG, "utf8")) as NetworkConfig;
  const rows = await measureCorpus(prepare);

  const out: string[] = [
    `Thumbnail guard ${label} the change, measured ${new Date().toISOString().slice(0, 10)}`,
    "",
    `Each upload goes through prepareOrFallback (the /prepare path), then assertStableFingerprint on the print and thumbnail it made.`,
    `Network distances come from the workflow's own decodeJpeg and dihedralFingerprints (identity entry) against the registered print.`,
    `Master's rule: pHash <= ${config.matchThreshold} and blockhash <= ${LOOKALIKE_BLOCKHASH_BITS} (workflow.ts measureThumbnail). The pHash-only rule is the live workflow d09ad14.`,
    `"Signed" below means the guard passed the upload: the routes pin and register nothing it refuses.`,
    "",
    ...summarise(
      `Robustness corpus: seeds 0 to ${WIDER_FIRST_SEED - 1}, each an original and 15 transforms used as an upload.`,
      rows.filter((row) => row.set === "robustness"),
      config.matchThreshold,
    ),
    "",
    ...summarise(
      `Wider corpus: seeds ${WIDER_FIRST_SEED} to ${WIDER_LAST_SEED} of the same generator, the same 16 uploads each.`,
      rows.filter((row) => row.set === "wider"),
      config.matchThreshold,
    ),
  ];

  if (label === "before") {
    out.push("", ...(await measurePassports(config)));
  }

  const report = out.join("\n");
  console.log(report);
  const target = path.join(REPO_ROOT, "kitchen", "reports", "push-prep", `guard-${label}.txt`);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `${report}\n`, "utf8");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
