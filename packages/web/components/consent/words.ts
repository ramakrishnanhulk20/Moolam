import type { Consent, Statement, Use, UseField } from "@/lib/chain/consent";

/**
 * The words and the colours a statement is drawn in, in one place.
 *
 * The lab page is English only while Ram picks a card, so the sentences sit
 * here rather than in the ten message files. When a variant is chosen these
 * keys are what move into messages/, and every screen that reads a statement
 * keeps reading one vocabulary.
 */

/** The standard's four uses, in the order the contract stores them, in plain words. */
export const USE_LABELS: Record<UseField, string> = {
  aiTraining: "AI training",
  aiGenerativeTraining: "Generative AI training",
  aiInference: "AI inference",
  dataMining: "Data mining",
};

/** One use's state, said the way a creator would say it rather than in the enum's own spelling. */
export const USE_STATES: Record<Use, string> = {
  allowed: "Allowed",
  notAllowed: "Not allowed",
  constrained: "Conditions apply",
  unspecified: "Not stated",
};

/** The headline the card opens on. */
export const SUMMARY_HEADLINES: Record<Statement, string> = {
  open: "Open to AI use",
  closed: "Not for AI training",
  ask: "Ask the holder first",
  mixed: "Stated use by use",
  none: "Nothing stated yet",
};

/** The one line under the headline. Never more than a reader needs to act. */
export const SUMMARY_LINES: Record<Statement, string> = {
  open: "The holder allows all four uses in the standard, training included.",
  closed: "The holder refuses all four uses in the standard. This is a choice, not a fault.",
  ask: "The holder allows these uses only on their own conditions. Anyone who cannot ask has to read it as no.",
  mixed: "This statement answers each use on its own terms.",
  none: "Nobody has written a statement for this picture yet. Nothing stated is not permission.",
};

/**
 * The colours a summary is drawn in.
 *
 * They come from the status family, which is colder than the one accent and
 * kept apart from it on purpose. A refusal is drawn in the calm blue rather
 * than the red an error would take: a holder saying no is the register working,
 * not the page failing.
 */
export interface SummaryTone {
  ink: string;
  fill: string;
  edge: string;
}

export const SUMMARY_TONES: Record<Statement, SummaryTone> = {
  open: { ink: "text-verified", fill: "bg-verified", edge: "border-verified" },
  closed: { ink: "text-pending", fill: "bg-pending", edge: "border-pending" },
  ask: { ink: "text-disputed", fill: "bg-disputed", edge: "border-disputed" },
  mixed: { ink: "text-text", fill: "bg-text", edge: "border-line-strong" },
  none: { ink: "text-text-faint", fill: "bg-line-strong", edge: "border-line" },
};

/** The same five states in two or three words, for a chip beside a heading. */
export const SUMMARY_CHIPS: Record<Statement, string> = {
  open: "Open to AI",
  closed: "No AI use",
  ask: "Conditions",
  mixed: "Use by use",
  none: "Not stated",
};

/** One use's own ink, from the same cold family as the summary above it. */
export const USE_TONES: Record<Use, string> = {
  allowed: "text-verified",
  notAllowed: "text-pending",
  constrained: "text-disputed",
  unspecified: "text-text-faint",
};

/** The tail of the sentence a verify answer prints, after the date. */
export const SUMMARY_TAILS: Record<Statement, string> = {
  open: "open to AI use, training included",
  closed: "not for AI training",
  ask: "ask first, conditions apply",
  mixed: "allowed for some uses and not for others",
  none: "nothing about AI use",
};

/**
 * A statement is dated by the block it was written in, which is UTC, so it is
 * read back in UTC. The time zone is fixed here rather than taken from the
 * machine for a second reason: the server and the browser draw the same card
 * and two clocks in two zones would hand back two different days.
 *
 * The parts are assembled by hand because the whole point of a date on this
 * card is that it is read once and remembered, and the British short month is
 * "Sept" while everywhere else writes "Sep".
 */
const PARTS = new Intl.DateTimeFormat("en-US", {
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
  timeZone: "UTC",
});

function partsOf(unixSeconds: number): Record<string, string> {
  const found: Record<string, string> = {};
  for (const part of PARTS.formatToParts(new Date(unixSeconds * 1000))) {
    found[part.type] = part.value;
  }
  return found;
}

/** "18 Sep 2026". */
export function dayText(unixSeconds: number): string {
  const part = partsOf(unixSeconds);
  return `${part.day} ${part.month} ${part.year}`;
}

/** "18 Sep 2026, 07:38 UTC". */
export function momentText(unixSeconds: number): string {
  const part = partsOf(unixSeconds);
  return `${part.day} ${part.month} ${part.year}, ${part.hour}:${part.minute} UTC`;
}

/** Which uses carry conditions, for the line that says what the conditions are about. */
export function constrainedUses(consent: Consent): UseField[] {
  return (Object.keys(USE_LABELS) as UseField[]).filter((field) => consent[field] === "constrained");
}
