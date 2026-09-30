import { useTranslations } from "next-intl";
import type { Statement } from "@/lib/chain/consent";
import { SUMMARY_TONES } from "./tones";

/**
 * The state of a statement in two words, beside a heading.
 *
 * Drawn in the same shape as the standing chip on a passport page, so a reader
 * who has seen one has seen this. The colour is the only place a refusal shows
 * as a colour at all, and it is a cold blue rather than the red this page keeps
 * for things that went wrong.
 */
export function ConsentChip({ summary, className = "" }: { summary: Statement; className?: string }) {
  const t = useTranslations("passport.consent");
  const tone = SUMMARY_TONES[summary];

  return (
    <p
      className={`inline-flex items-center gap-2.5 border border-line bg-bg-raised px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.2em] ${tone.ink} ${className}`}
    >
      <span aria-hidden className={`motif h-2 w-2 ${tone.fill}`} />
      {t(`chip.${summary}`)}
    </p>
  );
}
