import type { Hex, PassportRecord } from "../types.js";
import type { DocumentReader } from "../unseal.js";
import {
  PictureBook,
  inLookalikeOrder,
  lookalikeHalfOn,
  missingOf,
  type BacklogSettings,
  type BacklogView,
  type LookalikeRecordView,
} from "./backlog.js";
import { indexRecordView, type LookalikeIndexReader } from "./indexRecords.js";
import { LookalikeLedger, type LedgerChain } from "./ledger.js";

/**
 * How long the backlog waits before asking an index that did not serve Lookalike rows again. The
 * index gains them only with a redeploy, so ten minutes costs one query in ten refreshes of a
 * shared rate limit while the chain scan stands in.
 */
export const INDEX_ABSENT_RETRY_MS = 10 * 60 * 1000;

/** What the backlog knows besides the index, and the background refresh that keeps it current. */
export interface LookalikeKnowledge {
  settings: BacklogSettings;
  /** The view an answer reads: fixed between refreshes, never read from the network. */
  view: () => BacklogView;
  /**
   * Reads on the look-alike records and the documents of the passports that still wait, oldest
   * first. Never throws. A refresh asked for while one runs joins it rather than starting another.
   */
  refresh: (passports: ReadonlyMap<Hex, PassportRecord>) => Promise<void>;
}

/**
 * Builds the backlog's knowledge. With no document reader nothing is ever read, and every waiting
 * passport stays unjudged, so the backlog answers "not-ready"; with the look-alike half on and no
 * chain, the records are never caught up, with the same answer. Both are the safe defaults under a
 * test runner.
 *
 * Look-alike records come from the index's Lookalike rows (WO-276) whenever the index serves them,
 * through the same LookalikeRecordView, and the chain scan is not run at all. The scan stands in
 * only while the index does not have the entity, and the index is asked again every
 * INDEX_ABSENT_RETRY_MS. An index that serves the rows and then fails a read leaves the records
 * not ready until a read succeeds, never a guess from an older list.
 */
export function lookalikeKnowledge(options: {
  settings: BacklogSettings;
  readDocument?: DocumentReader;
  chain?: LedgerChain;
  index?: LookalikeIndexReader;
  clock?: () => number;
}): LookalikeKnowledge {
  const { settings } = options;
  const book = new PictureBook(options.readDocument, options.clock);
  const half = lookalikeHalfOn(settings);
  const ledger =
    half && options.chain !== undefined && settings.receiver !== undefined && settings.activation !== undefined
      ? new LookalikeLedger(options.chain, settings.receiver, settings.activation)
      : undefined;
  const clock = options.clock ?? Date.now;
  const NOT_READY: LookalikeRecordView = { ready: false, newestAt: () => undefined };
  // "index" once the index has served its rows; "ledger" while it has said it has none.
  let source: "unknown" | "index" | "ledger" = options.index === undefined ? "ledger" : "unknown";
  let indexView: LookalikeRecordView = NOT_READY;
  let absentAt = 0;
  const records = (): BacklogView["records"] => {
    if (!half) return undefined;
    if (source === "index") return indexView;
    if (source === "ledger") return ledger?.view() ?? NOT_READY;
    return NOT_READY;
  };

  const readRecords = async (): Promise<void> => {
    const reader = options.index;
    const activation = settings.activation;
    if (!half || activation === undefined) return;
    if (reader !== undefined && (source !== "ledger" || clock() - absentAt >= INDEX_ABSENT_RETRY_MS)) {
      const read = await reader(activation);
      if (read.kind === "rows") {
        source = "index";
        indexView = indexRecordView(read.newest);
        return;
      }
      if (read.kind === "failed" && source !== "ledger") {
        indexView = NOT_READY;
        return;
      }
      source = "ledger";
      absentAt = clock();
    }
    if (source === "ledger") await ledger?.advance();
  };

  let running: Promise<void> | undefined;
  const run = async (passports: ReadonlyMap<Hex, PassportRecord>): Promise<void> => {
    // A backlog that is off answers "not-ready" whatever is read, so nothing is read for it.
    if (!half) return;
    await readRecords();
    const view = records();
    if (view === undefined) return;
    const waiting: string[] = [];
    for (const record of inLookalikeOrder(passports)) {
      const missing = missingOf(record, view);
      if (missing !== "unknown" && (missing.verdict || missing.lookalike) && book.wants(record.metadataURI)) {
        waiting.push(record.metadataURI);
      }
    }
    await book.readSome(waiting);
  };

  return {
    settings,
    view: () => ({ settings, pictureOf: (uri) => book.checkOf(uri), records: records() }),
    refresh: async (passports) => {
      if (running === undefined) {
        running = run(passports)
          .catch(() => undefined)
          .finally(() => {
            running = undefined;
          });
      }
      await running;
    },
  };
}
