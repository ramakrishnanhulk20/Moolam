import type { Statement } from "@/lib/chain/consent";
import { SUMMARY_CHIPS, SUMMARY_HEADLINES, SUMMARY_LINES, SUMMARY_TONES } from "./words";

/**
 * The state of a statement in two words, beside a heading.
 *
 * Drawn in the same shape as the standing chip on a passport page, so a reader
 * who has seen one has seen this. The colour is the only place a refusal shows
 * as a colour at all, and it is a cold blue rather than the red this page keeps
 * for things that went wrong.
 */
export function ConsentChip({ summary, className = "" }: { summary: Statement; className?: string }) {
  const tone = SUMMARY_TONES[summary];

  return (
    <p
      className={`inline-flex items-center gap-2.5 border border-line bg-bg-raised px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.2em] ${tone.ink} ${className}`}
    >
      <span aria-hidden className={`h-2 w-2 ${tone.fill}`} />
      {SUMMARY_CHIPS[summary]}
    </p>
  );
}

/**
 * What the statement says, in one line a stranger can act on.
 *
 * Kept in the page's own ink rather than the status colour: this is the
 * sentence, not the status, and a headline in blue would read as a warning on
 * a choice that is nobody's fault.
 */
export function ConsentHeadline({ summary, className = "" }: { summary: Statement; className?: string }) {
  return (
    <p
      className={`font-display font-semibold leading-[0.98] tracking-[-0.03em] text-text ${className}`}
    >
      {SUMMARY_HEADLINES[summary]}
    </p>
  );
}

export function ConsentLine({ summary, className = "" }: { summary: Statement; className?: string }) {
  return <p className={`max-w-[46ch] text-sm leading-relaxed text-text-muted ${className}`}>{SUMMARY_LINES[summary]}</p>;
}
