import type { ConsentEntry } from "@/lib/chain/consent";
import { plainStatement } from "@/lib/chain/consent";
import { MONAD_EXPLORER, shortHex } from "@/lib/chain/client";
import { UseBlock } from "./Marks";
import { SUMMARY_HEADLINES, SUMMARY_TONES, momentText } from "./words";

/**
 * Every statement this passport has carried, newest first.
 *
 * A register that kept only the latest statement would let a holder open their
 * work to training, watch it get used, then close it and leave no trace of the
 * day it was open. So the list is the product: one dated line per statement,
 * and the newest is marked as the one that stands.
 */
export function ConsentHistory({ entries, className = "" }: { entries: ConsentEntry[]; className?: string }) {
  if (entries.length === 0) {
    return (
      <p className={`max-w-[46ch] text-sm leading-relaxed text-text-muted ${className}`}>
        This passport has no statements at all. The first one written will sit here with its date, and nothing written
        after it can take its place.
      </p>
    );
  }

  const newestFirst = [...entries].reverse();

  return (
    <ol className={`border-s border-line ${className}`}>
      {newestFirst.map((entry, at) => {
        const summary = plainStatement(entry.consent);
        const tone = SUMMARY_TONES[summary];
        return (
          <li key={`${entry.at.toString()}-${at}`} className="relative ps-6 pb-7 last:pb-0">
            <span aria-hidden className={`absolute -start-[4.5px] top-1.5 h-[9px] w-[9px] ${tone.fill}`} />

            <p className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <span className="font-mono text-[11px] tracking-[0.12em] text-text-muted">
                {momentText(Number(entry.at))}
              </span>
              {at === 0 ? (
                <span className="font-mono text-[9px] uppercase tracking-[0.2em] text-text-faint">stands today</span>
              ) : null}
            </p>

            <p className="mt-2 flex items-center gap-3">
              <UseBlock consent={entry.consent} className={tone.ink} size="h-2.5 w-2.5" />
              <span className={`text-sm ${tone.ink}`}>{SUMMARY_HEADLINES[summary]}</span>
            </p>

            {entry.constraintInfo.length === 0 ? null : (
              <p className="mt-2 max-w-[52ch] break-words text-xs leading-relaxed text-text-muted">
                {entry.constraintInfo}
              </p>
            )}

            <p className="tap-row mt-2 font-mono text-[10px] tracking-[0.14em] text-text-faint">
              written by{" "}
              <a
                href={`${MONAD_EXPLORER}/address/${entry.writer}`}
                target="_blank"
                rel="noreferrer"
                className="transition-colors duration-200 hover:text-accent"
              >
                {shortHex(entry.writer)}
              </a>
            </p>
          </li>
        );
      })}
    </ol>
  );
}
