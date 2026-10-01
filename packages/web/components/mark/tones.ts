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

/** The text colour for each tone, light and dark. Amber is #875400 on light and #f2a93b on dark (DECISIONS 2026-10-01). */
export const TONE_INK: Record<MarkTone, string> = {
  disputed: "text-disputed",
  failed: "text-failed",
  amber: "text-[#875400] [.dark_&]:text-[#f2a93b]",
  pending: "text-pending",
  verified: "text-verified",
  quiet: "text-text-muted",
};

export const TONE_EDGE: Record<MarkTone, string> = {
  disputed: "border-disputed",
  failed: "border-failed",
  amber: "border-[#875400] [.dark_&]:border-[#f2a93b]",
  pending: "border-pending",
  verified: "border-verified",
  quiet: "border-line-strong",
};
