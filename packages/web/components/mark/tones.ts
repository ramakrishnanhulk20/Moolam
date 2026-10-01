import type { MarkState } from "./mark";

/** The ink a mark is drawn in. Amber is the look-alike mark's own colour; the rest are the status family. */
export type MarkTone = "disputed" | "failed" | "amber" | "pending" | "verified" | "quiet";

export const MARK_TONES: Record<MarkState | "unread", MarkTone> = {
  upheld: "disputed",
  mismatch: "failed",
  lookalike: "amber",
  challenged: "disputed",
  waiting: "pending",
  checked: "verified",
  sealed: "quiet",
  nothing: "quiet",
  unread: "quiet",
};

/** The text colour for each tone. Amber is the lookalike token in styles/globals.css, one shade per theme. */
export const TONE_INK: Record<MarkTone, string> = {
  disputed: "text-disputed",
  failed: "text-failed",
  amber: "text-lookalike",
  pending: "text-pending",
  verified: "text-verified",
  quiet: "text-text-muted",
};

export const TONE_EDGE: Record<MarkTone, string> = {
  disputed: "border-disputed",
  failed: "border-failed",
  amber: "border-lookalike",
  pending: "border-pending",
  verified: "border-verified",
  quiet: "border-line-strong",
};
