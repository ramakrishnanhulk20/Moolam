import type { Hex, PassportRecord } from "../types.js";
import type { DocumentReader } from "../unseal.js";
import {
  PictureBook,
  inLookalikeOrder,
  lookalikeHalfOn,
  missingOf,
  type BacklogSettings,
  type BacklogView,
} from "./backlog.js";
import { LookalikeLedger, type LedgerChain } from "./ledger.js";

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
 */
export function lookalikeKnowledge(options: {
  settings: BacklogSettings;
  readDocument?: DocumentReader;
  chain?: LedgerChain;
  clock?: () => number;
}): LookalikeKnowledge {
  const { settings } = options;
  const book = new PictureBook(options.readDocument, options.clock);
  const half = lookalikeHalfOn(settings);
  const ledger =
    half && options.chain !== undefined && settings.receiver !== undefined && settings.activation !== undefined
      ? new LookalikeLedger(options.chain, settings.receiver, settings.activation)
      : undefined;
  const records = (): BacklogView["records"] =>
    half ? (ledger?.view() ?? { ready: false, newestAt: () => undefined }) : undefined;

  let running: Promise<void> | undefined;
  const run = async (passports: ReadonlyMap<Hex, PassportRecord>): Promise<void> => {
    await ledger?.advance();
    const view = records();
    const waiting: string[] = [];
    for (const record of inLookalikeOrder(passports)) {
      const missing = missingOf(record, settings, view);
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
