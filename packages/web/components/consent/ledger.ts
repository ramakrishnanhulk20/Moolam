import type { Consent, ConsentEntry, Statement } from "@/lib/chain/consent";
import { plainStatement } from "@/lib/chain/consent";

/**
 * The life of one passport's statements, as a rule a reader can drag along.
 *
 * Everything here is arithmetic on timestamps the chain gave, kept apart from
 * the drawing so it can be read and tested on its own. Nothing is invented: a
 * passport with one statement has one segment, and the stretch before it is the
 * stretch when nobody had said anything.
 */

export const DAY_SECONDS = 86_400;

/** One statement in the shape a browser can carry: whole seconds, never a bigint. */
export interface LedgerEntry {
  at: number;
  writer: string;
  consent: Consent;
  constraintInfo: string;
}

/**
 * A statement on its way from a server render into the card.
 *
 * The timestamp becomes a number here because a bigint cannot cross into a
 * browser component at all, and a block timestamp in seconds fits a JSON number
 * for the next quarter of a million years.
 */
export function ledgerEntry(entry: ConsentEntry): LedgerEntry {
  return {
    at: Number(entry.at),
    writer: entry.writer,
    consent: entry.consent,
    constraintInfo: entry.constraintInfo,
  };
}

/** What the chain answered for one moment. */
export interface LedgerAnswer {
  stated: boolean;
  entry: LedgerEntry | null;
}

/**
 * How the card asks what stood on a day. The card never knows the endpoint:
 * whoever mounts it hands in the asking, so the same card works behind the lab
 * route today and behind whatever the app settles on later.
 */
export type AskConsentAt = (unixSeconds: number, signal: AbortSignal) => Promise<LedgerAnswer>;

/** One stretch of the passport's life, with the statement that stood through it. */
export interface Segment {
  from: number;
  to: number;
  /** Null for the opening stretch, when the picture was registered and nobody had spoken. */
  entry: LedgerEntry | null;
  summary: Statement;
}

/**
 * The passport's life cut into stretches.
 *
 * A statement stands from the second it was written until the next one replaces
 * it, so the last stretch runs to now. An entry written before the passport
 * itself, which cannot happen on this contract, would still not be allowed to
 * run the rule backwards: the start of a stretch is never earlier than the one
 * before it.
 */
export function segmentsOf(registeredAt: number, now: number, entries: LedgerEntry[]): Segment[] {
  const ordered = [...entries].sort((one, other) => one.at - other.at);
  const end = Math.max(now, registeredAt);
  const segments: Segment[] = [];

  let cursor = registeredAt;
  for (const [at, entry] of ordered.entries()) {
    const from = Math.max(cursor, Math.min(entry.at, end));
    if (from > cursor) {
      segments.push({ from: cursor, to: from, entry: null, summary: "none" });
    }
    const next = ordered[at + 1];
    const to = next === undefined ? end : Math.max(from, Math.min(next.at, end));
    segments.push({ from, to, entry, summary: plainStatement(entry.consent) });
    cursor = to;
  }

  if (segments.length === 0) {
    segments.push({ from: registeredAt, to: end, entry: null, summary: "none" });
  }
  return segments;
}

/** Where a moment sits on the rule, from 0 at registration to 1 at now. */
export function fractionOf(at: number, registeredAt: number, now: number): number {
  const span = now - registeredAt;
  if (span <= 0) {
    return 1;
  }
  return Math.min(1, Math.max(0, (at - registeredAt) / span));
}

/** Which stretch a moment falls in, or -1 when it falls outside the rule entirely. */
export function segmentAt(segments: Segment[], seconds: number): number {
  return segments.findIndex((segment, at) =>
    at === segments.length - 1 ? seconds >= segment.from : seconds >= segment.from && seconds < segment.to,
  );
}

/** How many whole days the rule covers, and which day a moment falls on. */
export function daysAcross(registeredAt: number, now: number): number {
  return Math.max(1, Math.ceil((now - registeredAt) / DAY_SECONDS));
}

/**
 * The moment one notch of the scrubber asks about.
 *
 * The notches are days because the question is a day's question: what was
 * allowed on the day this picture was used. The last notch is now rather than a
 * day that has not happened yet.
 */
export function secondsForDay(day: number, registeredAt: number, now: number): number {
  return Math.min(now, registeredAt + day * DAY_SECONDS);
}
