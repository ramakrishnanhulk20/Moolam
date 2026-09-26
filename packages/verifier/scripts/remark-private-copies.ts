// Re-marks the private copies kept before V12 (commit ddf35fa), once. Such a copy is the raw
// thumbnail of the signed file, so its bytes are the public thumbnail's, and Pinata answers a public
// pin of those bytes with the private file: an unseal or a public /prepare of the same picture under
// another passport can then never pin its thumbnail (review pass 6, sealed #3, V52).
//
// It lists every private sealed-thumb-<id>.jpg, reads each one through a short read link, and finds
// the ones with no "moolam-private-copy <id>" comment in them. A dry run, the default, prints how
// many there are and their passport ids and changes nothing. With --live it uploads, for each one,
// the marked form keepPrivateCopy writes today under the same name, and only once that upload is
// confirmed private deletes the unmarked file. It prints counts and passport ids only: never a
// token, a read link or a file id. Running it against the live account is Ram's call. Run from the
// repo root with the root .env loaded:
//   set -a; . ./.env; set +a; node_modules/.bin/tsx packages/verifier/scripts/remark-private-copies.ts
//   set -a; . ./.env; set +a; node_modules/.bin/tsx packages/verifier/scripts/remark-private-copies.ts --live

import { pathToFileURL } from "node:url";
import type { FastifyBaseLogger } from "fastify";
import {
  PRIVATE_SWEEP_PAGES,
  deletePrivateFile,
  listPrivatePage,
  privateDownloadLink,
  type PrivateListing,
} from "../src/ipfs/pinata.js";
import { THUMBNAIL_MAX_BYTES } from "../src/prepare.js";
import { PRIVATE_COPY_COMMENT, keepPrivateCopy, type PrivateCopy } from "../src/sealed.js";
import type { Hex } from "../src/types.js";

/** The only names this script acts on: the whole name, in the lower case hex /prepare writes. */
const THUMBNAIL_NAME = /^sealed-thumb-(0x[0-9a-f]{64})\.jpg$/;

/**
 * How many listing calls one run makes, each PRIVATE_SWEEP_PAGES pages of 100: 20,000 files, far
 * more than the account holds. A listing that has not ended by then changes nothing.
 */
const MAX_LIST_ROUNDS = 100;

/** How long each read link lives: one fetch from this machine, and nothing an onlooker could reuse. */
const LINK_SECONDS = 60;

const DOWNLOAD_TIMEOUT_MS = 15_000;

/** A private copy is a thumbnail under THUMBNAIL_MAX_BYTES, so anything past twice that is not one. */
const DOWNLOAD_MAX_BYTES = 2 * THUMBNAIL_MAX_BYTES;

export interface RemarkDeps {
  list: (from: string | undefined) => Promise<{ files: PrivateListing[]; next: string | undefined }>;
  /** The file's bytes. Throws when they cannot be read; no message may carry the read link. */
  download: (file: PrivateListing) => Promise<Buffer>;
  /** Uploads the marked form under the passport's name, as /prepare does today. */
  keep: (thumbnail: Buffer, passportId: Hex) => Promise<PrivateCopy>;
  remove: (fileId: string) => Promise<void>;
}

export interface RemarkSummary {
  live: boolean;
  /** Private files whose name is exactly a thumbnail name. */
  copies: number;
  /** Copies already carrying their own passport's mark. */
  marked: number;
  /** Passport ids of the copies still in the unmarked form. */
  unmarked: Hex[];
  /** Passport ids whose marked copy was uploaded and whose unmarked copy was deleted. */
  remarked: Hex[];
  /** Copies left as they were, with the reason. */
  failed: { passportId: Hex; reason: string }[];
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function liveDownload(file: PrivateListing): Promise<Buffer> {
  const link = await privateDownloadLink(file.cid, LINK_SECONDS);
  const response = await fetch(link, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS), redirect: "error" });
  if (!response.ok) {
    throw new Error(`the gateway answered ${response.status}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > DOWNLOAD_MAX_BYTES) {
    throw new Error(`the file is ${bytes.length} bytes, more than a private copy can be`);
  }
  return bytes;
}

/** keepPrivateCopy writes to a service log; here only its warnings and errors are said, and never a field. */
function scriptLog(say: (line: string) => void): FastifyBaseLogger {
  const quiet = (): void => undefined;
  const loud = (_fields: unknown, message?: unknown): void => {
    say(`  keepPrivateCopy: ${String(message ?? "")}`);
  };
  return { info: quiet, debug: quiet, trace: quiet, warn: loud, error: loud, fatal: loud } as unknown as FastifyBaseLogger;
}

/**
 * One run. Lists the whole private account before it changes anything, and throws, having changed
 * nothing, when the listing cannot be finished. Never throws once the work has started: each copy
 * that could not be read, uploaded or deleted is left as it was and named in `failed`.
 */
export async function remarkPrivateCopies(options: {
  live: boolean;
  say?: (line: string) => void;
  deps?: Partial<RemarkDeps>;
}): Promise<RemarkSummary> {
  const say = options.say ?? ((line: string): void => void process.stdout.write(`${line}\n`));
  const deps: RemarkDeps = {
    list: options.deps?.list ?? (async (from) => await listPrivatePage(from, PRIVATE_SWEEP_PAGES)),
    download: options.deps?.download ?? liveDownload,
    keep: options.deps?.keep ?? (async (thumbnail, passportId) => await keepPrivateCopy(thumbnail, passportId, scriptLog(say))),
    remove: options.deps?.remove ?? deletePrivateFile,
  };

  const listed: PrivateListing[] = [];
  let from: string | undefined;
  let ended = false;
  for (let round = 0; round < MAX_LIST_ROUNDS && !ended; round += 1) {
    const page = await deps.list(from);
    listed.push(...page.files);
    from = page.next;
    ended = from === undefined;
  }
  if (!ended) {
    throw new Error(`the private listing ran past ${MAX_LIST_ROUNDS} rounds, so nothing was changed`);
  }

  const summary: RemarkSummary = { live: options.live, copies: 0, marked: 0, unmarked: [], remarked: [], failed: [] };
  const toMark: { file: PrivateListing; passportId: Hex; bytes: Buffer }[] = [];
  for (const file of listed) {
    const passportId = THUMBNAIL_NAME.exec(file.name)?.[1] as Hex | undefined;
    if (passportId === undefined) {
      continue;
    }
    summary.copies += 1;
    let bytes: Buffer;
    try {
      bytes = await deps.download(file);
    } catch (error) {
      summary.failed.push({ passportId, reason: `could not be read: ${reasonOf(error)}` });
      continue;
    }
    const text = bytes.toString("latin1");
    if (text.includes(`${PRIVATE_COPY_COMMENT} ${passportId}`)) {
      summary.marked += 1;
    } else if (text.includes(PRIVATE_COPY_COMMENT)) {
      summary.failed.push({ passportId, reason: "it carries another passport's mark, so it is left for an operator" });
    } else {
      summary.unmarked.push(passportId);
      toMark.push({ file, passportId, bytes });
    }
  }

  say(
    `${summary.unmarked.length} of ${summary.copies} private copies are in the unmarked form kept before V12` +
      (options.live ? "" : ". Dry run: nothing was changed. Run with --live to re-mark them."),
  );
  for (const passportId of summary.unmarked) {
    say(`  ${passportId}`);
  }

  if (options.live) {
    for (const { file, passportId, bytes } of toMark) {
      let kept: PrivateCopy;
      try {
        kept = await deps.keep(bytes, passportId);
      } catch (error) {
        summary.failed.push({ passportId, reason: `the marked copy was not uploaded: ${reasonOf(error)}` });
        continue;
      }
      if (!("kept" in kept)) {
        summary.failed.push({ passportId, reason: `the marked copy was refused: ${kept.refused.status} ${kept.refused.body.error}` });
        continue;
      }
      // Deleted only after the marked copy is confirmed private under the same name, so a failure
      // on the way never leaves the passport with no copy at all.
      try {
        await deps.remove(file.id);
        summary.remarked.push(passportId);
      } catch (error) {
        summary.failed.push({
          passportId,
          reason: `the marked copy is kept and the unmarked one could not be deleted: ${reasonOf(error)}`,
        });
      }
    }
    say(`${summary.remarked.length} re-marked`);
  }
  for (const { passportId, reason } of summary.failed) {
    say(`  left as it was: ${passportId}, ${reason}`);
  }
  return summary;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  remarkPrivateCopies({ live: process.argv.includes("--live") })
    .then((summary) => {
      process.exit(summary.failed.length === 0 ? 0 : 1);
    })
    .catch((error: unknown) => {
      process.stdout.write(`STOP: ${reasonOf(error)}\n`);
      process.exit(1);
    });
}
