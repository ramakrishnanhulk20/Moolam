import type { Statement, Use } from "@/lib/chain/consent";

/**
 * The colours a statement is drawn in, in one place.
 *
 * They come from the status family, which is colder than the one accent and
 * kept apart from it on purpose. A refusal is drawn in the calm blue rather
 * than the red an error would take: a holder saying no is the register working,
 * not the page failing.
 *
 * The words all live in the message files under passport.consent, so a card and
 * a verify answer read the same vocabulary in the visitor's own language.
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

/** One use's own ink, from the same cold family as the summary above it. */
export const USE_TONES: Record<Use, string> = {
  allowed: "text-verified",
  notAllowed: "text-pending",
  constrained: "text-disputed",
  unspecified: "text-text-faint",
};
