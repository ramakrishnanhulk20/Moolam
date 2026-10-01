/**
 * The one trust mark a passport wears, issued worst first (L30).
 *
 * This file is kept byte for byte the same in packages/web/components/mark/mark.ts and
 * packages/verifier/src/mcp/mark.ts, and a verifier test compares the two, so the site and the MCP
 * server can never give one passport two different marks. It imports nothing for the same reason:
 * each side reads its own sources and hands the facts in.
 *
 * Only a verdict Chainlink's network wrote can light "Checked by Chainlink" or "Does not match".
 * A simulator verdict is kept in the record and never counts here. Only a look-alike record that
 * came through the network and passed the index's order and distance checks can light "Registered
 * after a look-alike" (L4, L5), and only the newest one per passport is ever handed in (L6).
 *
 * Every fact is a read, and a read that failed is said, never guessed (L32): a fact that could
 * decide a worse mark than the one this function would otherwise issue, and could not be read,
 * makes the answer "unread".
 */

/** The eight marks, worst first. */
export const MARK_STATES = [
  "upheld",
  "mismatch",
  "lookalike",
  "challenged",
  "waiting",
  "checked",
  "sealed",
  "nothing",
] as const;

export type MarkState = (typeof MARK_STATES)[number];

/** One verdict written back on chain about this passport's picture. */
export interface MarkVerdict {
  /** True only for a verdict Chainlink's network delivered (L4); a simulator run is false. */
  network: boolean;
  matched: boolean;
  /** pHash bits apart, of 64, as the chain's two fingerprints count them. */
  phashBits: number;
  /** Unix seconds the verdict was written. */
  at: number;
}

/** The newest look-alike record the index holds for this passport. */
export interface MarkLookalike {
  network: boolean;
  /** The index's order and distance checks (L5). */
  valid: boolean;
  /** The earlier passport's id, or null for a record that found none. */
  earlier: string | null;
  executedAt: number;
}

/** What the registry says about a challenge on this passport. */
export type MarkDispute = "none" | "open" | "upheld" | "rejected";

/** Whether the passport names a picture Chainlink can fetch. */
export type MarkPicture = "public" | "sealed" | "none";

export interface MarkInput {
  /** The registry's dispute status, or null when it could not be read. */
  dispute: MarkDispute | null;
  /** Every verdict on chain for this passport, or null when they could not be read. */
  verdicts: readonly MarkVerdict[] | null;
  /**
   * `{ read: true, record: null }` when the index holds no look-alike record for this passport,
   * `{ read: false }` when that could not be read.
   */
  lookalike: { read: true; record: MarkLookalike | null } | { read: false };
  /** What the document says the passport points at, or null when it could not be read. */
  picture: MarkPicture | null;
  /** The pHash bits at or under which two pictures look alike: the shared rule's number. */
  phashLimit: number;
}

export type Mark =
  | { state: "unread" }
  | { state: "upheld" }
  | {
      state: "mismatch";
      verdict: MarkVerdict;
      /** True when the look fingerprint was within its limit, so only the layout one failed. */
      secondPrint: boolean;
    }
  | { state: "lookalike"; lookalike: MarkLookalike & { earlier: string } }
  | { state: "challenged" }
  | { state: "waiting" }
  | { state: "checked"; verdict: MarkVerdict }
  | { state: "sealed" }
  | { state: "nothing" };

/** The newest network verdict, by the time it was written, or null when there is none. */
export function newestNetworkVerdict(verdicts: readonly MarkVerdict[]): MarkVerdict | null {
  let newest: MarkVerdict | null = null;
  for (const verdict of verdicts) {
    if (verdict.network && (newest === null || verdict.at > newest.at)) {
      newest = verdict;
    }
  }
  return newest;
}

/** True for a record that may light the look-alike mark: the network's, valid, and naming a passport. */
export function lightsLookalike(record: MarkLookalike | null): record is MarkLookalike & { earlier: string } {
  return record !== null && record.network && record.valid && record.earlier !== null;
}

/**
 * Issues the mark. Each step only runs once every worse mark has been ruled out by a read that
 * succeeded, so a failed read can only ever cost the mark, never print a better one.
 */
export function issueMark(input: MarkInput): Mark {
  if (input.dispute === null) {
    return { state: "unread" };
  }
  if (input.dispute === "upheld") {
    return { state: "upheld" };
  }

  if (input.verdicts === null) {
    return { state: "unread" };
  }
  const verdict = newestNetworkVerdict(input.verdicts);
  if (verdict !== null && !verdict.matched) {
    return { state: "mismatch", verdict, secondPrint: verdict.phashBits <= input.phashLimit };
  }

  if (!input.lookalike.read) {
    return { state: "unread" };
  }
  const record = input.lookalike.record;
  if (lightsLookalike(record)) {
    return { state: "lookalike", lookalike: record };
  }

  if (input.dispute === "open") {
    return { state: "challenged" };
  }

  if (verdict !== null) {
    return { state: "checked", verdict };
  }

  if (input.picture === null) {
    return { state: "unread" };
  }
  if (input.picture === "sealed") {
    return { state: "sealed" };
  }
  return input.picture === "none" ? { state: "nothing" } : { state: "waiting" };
}
