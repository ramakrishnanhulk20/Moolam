import type { ReactNode } from "react";
import type { Hex } from "viem";
import { MONAD_EXPLORER, addresses, shortHex } from "@/lib/chain/client";
import type { ConsentEntry, ConsentReading } from "@/lib/chain/consent";
import { NOTHING_STATED, plainStatement } from "@/lib/chain/consent";
import { ConsentRecord } from "@/components/consent/ConsentRecord";
import { ledgerEntry } from "@/components/consent/ledger";
import { ConsentChip } from "@/components/consent/Summary";
import { VerifyLine } from "@/components/consent/VerifyLine";
import { Reveal } from "@/components/lab/sponsors/Reveal";
import { Surface } from "@/components/lab/sponsors/Surface";
import { ChoicePanel } from "./ChoicePanel";
import { LedgerPanel } from "./LedgerPanel";

/** One real passport, with everything the chain said about it while this page rendered. */
export interface Subject {
  id: Hex;
  /** Why this picture is on the bench, in one line. */
  caption: string;
  /** The name in the pinned document, or null when no gateway answered. */
  title: string | null;
  registeredAt: number;
  reading: ConsentReading;
  history: ConsentEntry[];
}

/**
 * The consent bench: one feature, drawn every way it could be drawn, on real
 * statements.
 *
 * The labels are English on purpose while Ram picks a variant; the ten
 * languages come with the roll-in. Every word a card shows about a statement
 * was read from MoolamConsent on the request, and a picture with one statement
 * has one segment on its rule, because there is nothing else to draw.
 */
export function ConsentBench({ subjects, standard, now }: { subjects: Subject[]; standard: string; now: number }) {
  return (
    <Surface>
      <div className="px-5 pb-32 pt-10 sm:px-8 lg:px-14">
        <header className="mx-auto w-full max-w-[100rem]">
          <Reveal>
            <p className="flex items-center gap-3 font-mono text-[11px] uppercase tracking-[0.24em] text-accent">
              <span className="motif h-[9px] w-[9px]" />
              Consent bench
            </p>
          </Reveal>

          <Reveal delay={0.08}>
            <h1 className="mt-7 max-w-[17ch] font-display text-[clamp(3rem,10vw,9rem)] font-semibold uppercase leading-[0.85] tracking-[-0.055em]">
              What may a machine do with this picture?
            </h1>
          </Reveal>

          <div className="mt-10 grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,0.9fr)] lg:gap-16">
            <Reveal delay={0.16} className="min-w-0">
              <p className="max-w-[58ch] text-base leading-relaxed text-text-muted">
                A file can carry a line saying its creator refuses AI training, and anyone can strip that line out on
                the way past. Moolam writes the same statement to a register on Monad, where the holder is the only
                address that can write it and nobody can take it back out. Four real pictures below, read from the
                chain while this page rendered: what their holders said, when they said it, and what a reader is owed
                when they said nothing at all.
              </p>
              <p className="mt-5 max-w-[58ch] text-sm leading-relaxed text-text-faint">
                The card is drawn two ways. Pick one and it rolls into the passport page, the studio and the verify
                answer.
              </p>
            </Reveal>

            <Reveal delay={0.24} className="min-w-0">
              <ul className="grid gap-px border border-line bg-line sm:grid-cols-2">
                {subjects.map((subject) => {
                  const summary = subject.reading.stated
                    ? plainStatement(subject.reading.entry?.consent ?? NOTHING_STATED)
                    : "none";
                  return (
                    <li key={subject.id} className="bg-bg px-4 py-5">
                      <ConsentChip summary={summary} />
                      <p className="mt-3 max-w-[20ch] font-display text-[1.05rem] font-semibold leading-[1.1] tracking-[-0.02em]">
                        {subject.title ?? shortHex(subject.id)}
                      </p>
                    </li>
                  );
                })}
              </ul>
            </Reveal>
          </div>

          <Reveal delay={0.3}>
            <p className="tap-row mt-10 font-mono text-[10px] uppercase tracking-[0.18em] text-text-faint">
              read from{" "}
              <a
                href={`${MONAD_EXPLORER}/address/${addresses.consent}`}
                target="_blank"
                rel="noreferrer"
                className="transition-colors duration-200 hover:text-accent"
              >
                {addresses.consent}
              </a>{" "}
              on monad mainnet
            </p>
          </Reveal>
        </header>

        <div className="mx-auto mt-24 flex w-full max-w-[100rem] flex-col gap-28 lg:mt-36 lg:gap-40">
          <Act
            number="01"
            title="The card, as a record"
            caption="Variant A. The passport page's own voice: a headline anyone can act on, the four uses under it, and every statement this picture has ever carried."
          >
            <div className="mt-12 flex flex-col gap-16">
              {subjects.map((subject, at) => (
                <div key={subject.id}>
                  <PassportHead subject={subject} />
                  <Reveal delay={0.06}>
                    <ConsentRecord
                      reading={subject.reading}
                      history={subject.history}
                      standard={standard}
                      className={at % 2 === 1 ? "lg:ms-16" : ""}
                    />
                  </Reveal>
                </div>
              ))}
            </div>
          </Act>

          <Act
            number="02"
            title="The card, as a ledger"
            caption="Variant B. The same facts as one rule from the day the picture was registered to now. Drag the thumb and the chain is asked what was in force on that day."
          >
            <div className="mt-12 flex flex-col gap-16">
              {subjects.map((subject) => (
                <div key={subject.id}>
                  <PassportHead subject={subject} />
                  <Reveal delay={0.06}>
                    <LedgerPanel
                      id={subject.id}
                      registeredAt={subject.registeredAt}
                      now={now}
                      entries={subject.history.map(ledgerEntry)}
                      standing={{
                        stated: subject.reading.stated,
                        entry: subject.reading.entry === null ? null : ledgerEntry(subject.reading.entry),
                      }}
                      standard={standard}
                    />
                  </Reveal>
                </div>
              ))}
            </div>
          </Act>

          <Act
            number="03"
            title="The creator's control"
            caption="Three plain choices, a way in for anyone who wants to answer the four uses one at a time, and the conditions field that only exists while a choice needs one. Nothing here signs anything: it prints the call it would make."
          >
            <div className="mt-12 grid gap-12 lg:grid-cols-2 lg:gap-16">
              <ChoicePanel variant="plates" label="Variant A, plates" passportId={subjects[0].id} />
              <ChoicePanel variant="rule" label="Variant B, stops on a rule" passportId={subjects[0].id} />
            </div>
          </Act>

          <Act
            number="04"
            title="The line under a match"
            caption="What a verify answer prints once a picture is proved. The same reads as the cards above, in one sentence."
          >
            <div className="mt-12 flex flex-col gap-14">
              {subjects.map((subject) => (
                <div key={subject.id}>
                  <PassportHead subject={subject} />
                  <Reveal delay={0.06}>
                    <div className="mt-6 grid gap-10 border-t border-line pt-8 lg:grid-cols-2 lg:gap-16">
                      <div className="min-w-0">
                        <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-text-faint">
                          Variant A, one sentence
                        </p>
                        <VerifyLine variant="sentence" reading={subject.reading} className="mt-5" />
                      </div>
                      <div className="min-w-0">
                        <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-text-faint">
                          Variant B, a stamp
                        </p>
                        <VerifyLine variant="stamp" reading={subject.reading} className="mt-5" />
                      </div>
                    </div>
                  </Reveal>
                </div>
              ))}
            </div>
          </Act>
        </div>
      </div>
    </Surface>
  );
}

function Act({
  number,
  title,
  caption,
  children,
}: {
  number: string;
  title: string;
  caption: string;
  children: ReactNode;
}) {
  return (
    <section>
      <Reveal>
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:gap-16">
          <div className="flex min-w-0 items-start gap-6">
            <span className="font-mono text-[11px] tracking-[0.2em] text-accent">{number}</span>
            <h2 className="max-w-[14ch] font-display text-[clamp(2rem,5vw,4.2rem)] font-semibold uppercase leading-[0.9] tracking-[-0.045em]">
              {title}
            </h2>
          </div>
          <p className="max-w-[54ch] text-sm leading-relaxed text-text-muted lg:mt-3">{caption}</p>
        </div>
      </Reveal>
      {children}
    </section>
  );
}

function PassportHead({ subject }: { subject: Subject }) {
  return (
    <Reveal>
      <div className="flex flex-wrap items-baseline justify-between gap-x-8 gap-y-2">
        <p className="max-w-[26ch] font-display text-[clamp(1.1rem,2.2vw,1.6rem)] font-semibold leading-[1.05] tracking-[-0.03em]">
          {subject.title ?? "No gateway answered for this picture"}
        </p>
        <a
          href={`${MONAD_EXPLORER}/nft/${addresses.registry}/${BigInt(subject.id).toString()}`}
          target="_blank"
          rel="noreferrer"
          className="tap font-mono text-[10px] uppercase tracking-[0.18em] text-text-faint transition-colors duration-200 hover:text-accent"
        >
          {shortHex(subject.id, 8, 6)}
        </a>
      </div>
      <p className="mt-2 max-w-[60ch] text-sm leading-relaxed text-text-faint">{subject.caption}</p>
    </Reveal>
  );
}
