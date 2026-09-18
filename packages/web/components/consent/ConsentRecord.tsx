import { MONAD_EXPLORER, addresses, shortHex } from "@/lib/chain/client";
import type { ConsentEntry, ConsentReading } from "@/lib/chain/consent";
import { NOTHING_STATED, plainStatement } from "@/lib/chain/consent";
import { ConsentHistory } from "./History";
import { ConsentChip, ConsentHeadline, ConsentLine } from "./Summary";
import { UseRows } from "./UseRows";
import { USE_LABELS, constrainedUses, momentText } from "./words";

/**
 * The card as a record: what the holder said, who said it, when, and what they
 * had said before.
 *
 * It reads like the rest of a passport page on purpose. The same mono labels,
 * the same hairlines, the same two columns that do not match: a statement about
 * AI is one more fact the chain holds about this picture, not a banner bolted
 * over it.
 */
export function ConsentRecord({
  reading,
  history,
  standard,
  className = "",
}: {
  reading: ConsentReading;
  history: ConsentEntry[];
  /** The vocabulary, read from the contract rather than written into the page. */
  standard: string;
  className?: string;
}) {
  const entry = reading.entry;
  const consent = entry?.consent ?? NOTHING_STATED;
  const summary = plainStatement(consent);
  const conditions = entry !== null && entry.constraintInfo.length > 0 ? entry.constraintInfo : null;
  const conditional = constrainedUses(consent);

  return (
    <section className={`border-y border-line bg-bg ${className}`}>
      <div className="grid gap-10 px-5 py-10 sm:px-8 sm:py-12 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,0.95fr)] lg:gap-16">
        <div className="min-w-0 rise">
          <p className="font-mono text-[11px] uppercase tracking-[0.28em] text-text-faint">Statement on AI use</p>

          <ConsentHeadline
            summary={summary}
            className="mt-5 max-w-[14ch] text-[clamp(1.9rem,4.4vw,3.4rem)]"
          />

          <div className="mt-6 flex flex-wrap items-center gap-4">
            <ConsentChip summary={summary} />
            <a
              href={`${MONAD_EXPLORER}/address/${addresses.consent}`}
              target="_blank"
              rel="noreferrer"
              className="tap font-mono text-[10px] uppercase tracking-[0.18em] text-text-faint transition-colors duration-200 hover:text-accent"
            >
              {standard}
            </a>
          </div>

          <ConsentLine summary={summary} className="mt-6" />

          {conditions === null ? null : (
            <div className="mt-8 border-s-2 border-accent/50 ps-5">
              <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-text-faint">
                Conditions, in the holder&apos;s words
              </p>
              <p className="mt-2.5 max-w-[56ch] break-words text-base leading-relaxed text-text">{conditions}</p>
              {conditional.length === 0 ? null : (
                <p className="mt-2.5 max-w-[56ch] text-xs leading-relaxed text-text-faint">
                  Applies to {conditional.map((field) => USE_LABELS[field].toLowerCase()).join(", ")}.
                </p>
              )}
            </div>
          )}

          {entry === null ? null : (
            <dl className="mt-10 grid gap-x-8 gap-y-5 border-t border-line pt-6 sm:grid-cols-2">
              <Field label="Stated by" value={shortHex(entry.writer)} href={`${MONAD_EXPLORER}/address/${entry.writer}`} />
              <Field label="Written on" value={momentText(Number(entry.at))} />
            </dl>
          )}
        </div>

        {/* The rows and the history sit lower than the headline and hang off a
            rule, so the card opens on a sentence rather than on a table. */}
        <div className="min-w-0 rise lg:mt-14 lg:border-s lg:border-line lg:ps-12" style={{ animationDelay: "90ms" }}>
          <p className="font-mono text-[11px] uppercase tracking-[0.28em] text-text-faint">The four uses</p>
          <UseRows consent={consent} className="mt-4" />

          <p className="mt-10 font-mono text-[11px] uppercase tracking-[0.28em] text-text-faint">
            {history.length === 0 ? "No statement yet" : history.length === 1 ? "One statement" : `${history.length} statements`}
          </p>
          <ConsentHistory entries={history} className="mt-5" />
        </div>
      </div>
    </section>
  );
}

function Field({ label, value, href }: { label: string; value: string; href?: string }) {
  return (
    <div className="min-w-0">
      <dt className="font-mono text-[10px] uppercase tracking-[0.2em] text-text-faint">{label}</dt>
      <dd className="tap-row mt-1.5 break-all font-mono text-sm">
        {href === undefined ? (
          value
        ) : (
          <a href={href} target="_blank" rel="noreferrer" className="transition-colors duration-200 hover:text-accent">
            {value}
          </a>
        )}
      </dd>
    </div>
  );
}
