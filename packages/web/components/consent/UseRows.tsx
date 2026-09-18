import type { Consent } from "@/lib/chain/consent";
import { USE_FIELDS } from "@/lib/chain/consent";
import { UseMark } from "./Marks";
import { USE_LABELS, USE_STATES, USE_TONES } from "./words";

/**
 * The four uses, one row each, with the mark and the word side by side.
 *
 * The headline above these rows is a summary and every summary loses
 * something: this is where a reader finds out that inference was allowed and
 * training was not. The rows are always four, even when nothing has been
 * stated, so the card is the same height whatever the chain answers.
 */
export function UseRows({ consent, className = "" }: { consent: Consent; className?: string }) {
  return (
    <ul className={`bg-line space-y-px ${className}`}>
      {USE_FIELDS.map((field) => {
        const state = consent[field];
        return (
          <li key={field} className="bg-bg flex items-center justify-between gap-6 py-3.5">
            <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-text-faint">{USE_LABELS[field]}</span>
            <span className={`flex shrink-0 items-center gap-2.5 ${USE_TONES[state]}`}>
              <UseMark state={state} />
              <span className="text-sm leading-none">{USE_STATES[state]}</span>
            </span>
          </li>
        );
      })}
    </ul>
  );
}
