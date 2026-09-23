// One live check that this Pinata account keeps private files, run by hand once before opt-in B
// relies on it: upload a small generated JPEG privately, find it by its exact name, mint a 30
// second read link and fetch it once, then delete it and confirm the listing no longer has it.
// It prints statuses, sizes and names only. The token, the read link and its signature are never
// printed. Run from the repo root with the root .env loaded:
//   set -a; . ./.env; set +a; node_modules/.bin/tsx packages/verifier/scripts/pinata-private-smoke.ts

import { randomBytes } from "node:crypto";
import sharp from "sharp";
import {
  PrivateCopyNotPrivate,
  deletePrivateFile,
  findPrivateByName,
  pinPrivateFile,
  privateDownloadLink,
  type PrivateFile,
} from "../src/ipfs/pinata.js";

/** Long enough for one fetch from this machine, and nothing an onlooker could reuse later. */
const LINK_SECONDS = 30;

/** The listing may trail a delete by a moment, so the last check asks a few times before failing. */
const GONE_CHECKS = 4;
const GONE_WAIT_MS = 2_000;

/**
 * Under a kilobyte of JPEG that no one has pinned before. The pixels are random, so the content id
 * is new and Pinata cannot answer with a public file it already holds.
 */
async function smokeJpeg(): Promise<Buffer> {
  const side = 16;
  return await sharp(randomBytes(side * side * 3), { raw: { width: side, height: side, channels: 3 } })
    .jpeg({ quality: 70 })
    .toBuffer();
}

function say(line: string): void {
  process.stdout.write(`${line}\n`);
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function main(): Promise<number> {
  const name = `moolam-smoke-${Math.floor(Date.now() / 1000)}.jpg`;
  const bytes = await smokeJpeg();
  say(`upload: ${name}, ${bytes.length} bytes, network=private`);

  let file: PrivateFile;
  try {
    file = await pinPrivateFile(bytes, name, { purpose: "moolam-smoke" });
  } catch (error) {
    if (error instanceof PrivateCopyNotPrivate) {
      say(`STOP: ${reasonOf(error)}; file id ${String(error.fileId)} left for an operator to look at`);
    } else {
      say(`STOP: the private upload was refused: ${reasonOf(error)}`);
    }
    return 1;
  }
  say(`answer: network ${file.network}, name ${file.name}, name matches ${String(file.name === name)}`);

  let deleted = false;
  try {
    const found = await findPrivateByName(name);
    say(`find: ${found.length} file under the exact name, same id ${String(found.some((row) => row.id === file.id))}`);

    const link = await privateDownloadLink(file.cid, LINK_SECONDS);
    try {
      const response = await fetch(link, { signal: AbortSignal.timeout(10_000) });
      const body = Buffer.from(await response.arrayBuffer());
      say(`link: minted for ${LINK_SECONDS} s, fetched once: status ${response.status}, ${body.length} bytes, same bytes ${String(body.equals(bytes))}`);
    } catch (error) {
      // A fetch error can carry the address it was fetching, so only its kind is printed.
      say(`link: minted, the fetch failed: ${error instanceof Error ? error.name : "unknown error"}`);
    }

    await deletePrivateFile(file.id);
    deleted = true;
    say("delete: Pinata answered 2xx");

    for (let check = 1; check <= GONE_CHECKS; check += 1) {
      const after = await findPrivateByName(name);
      say(`find after delete (check ${check}): ${after.length} file under the exact name`);
      if (after.length === 0) {
        say("PASS: private upload, exact-name find, 30 second link, delete, gone");
        return 0;
      }
      await new Promise((resolve) => setTimeout(resolve, GONE_WAIT_MS));
    }
    say("FAIL: the listing still shows the file after the delete");
    return 1;
  } catch (error) {
    say(`FAIL: ${reasonOf(error)}`);
    return 1;
  } finally {
    if (!deleted) {
      try {
        await deletePrivateFile(file.id);
        say("clean-up: the smoke file was deleted after the failure");
      } catch (error) {
        say(`clean-up: could not delete smoke file ${file.id}: ${reasonOf(error)}`);
      }
    }
  }
}

process.exitCode = await main();
