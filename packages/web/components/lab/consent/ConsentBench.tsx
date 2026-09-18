import type { ReactNode } from "react";
import type { Hex } from "viem";
import { MONAD_EXPLORER, addresses, shortHex } from "@/lib/chain/client";
import type { ConsentEntry, ConsentReading } from "@/lib/chain/consent";
import { NOTHING_STATED, plainStatement } from "@/lib/chain/consent";
import { ConsentSection } from "@/components/consent/ConsentSection";
import { ConsentStamp } from "@/components/consent/ConsentStamp";
import { ConsentChip } from "@/components/consent/Summary";
import { Reveal } from "@/components/lab/sponsors/Reveal";
import { Surface } from "@/components/lab/sponsors/Surface";
import type { MatchConsent } from "@/lib/verifier/client";
import { ChoicePanel } from "./ChoicePanel";

/** One real passport, with everything the chain said about it while this page rendered. */
export interface Subject {
  id: Hex;
  /** Why this picture is on the bench, in one line. */
  caption: string;
  /** The name in the pinned document, or null when no gateway answered. */
  title: string | null;
  registeredAt: number;
  owner: Hex | null;
  reading: ConsentReading;
  history: ConsentEntry[];
}

/**
 * The consent bench, now showing only what Ram picked: the ledger with its four
 * rows and its history, the plates control, and the stamp a verify answer
 * prints.
 *
 * Every word a card shows about a statement was read from MoolamConsent on the
 * request, and a picture with one statement has one segment on its rule,
 * because there is nothing else to draw.
 */
export function ConsentBench({
  subjects,
  standard,
  minInterval,
  now,
}: {
  subjects: Subject[];
  standard: string;
  minInterval: number;
  now: number;
}) {
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
                These are the pieces as they ship on a passport page and under a verify answer, in the language this
                page is being read in.
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
            title="The card, as a ledger"
            caption="The passport's whole life as one rule, with the four uses and the dated history under it. Drag the thumb and the chain is asked what was in force on that day."
          >
            <div className="mt-12 flex flex-col gap-16">
              {subjects.map((subject) => (
                <div key={subject.id}>
                  <PassportHead subject={subject} />
                  <Reveal delay={0.06}>
                    <ConsentSection
                      id={subject.id}
                      owner={subject.owner}
                      registeredAt={subject.registeredAt}
                      record={{
                        reading: subject.reading,
                        history: subject.history,
                        standard,
                        minInterval,
                        now,
                      }}
                    />
                  </Reveal>
                </div>
              ))}
            </div>
          </Act>

          <Act
            number="02"
            title="The holder's control"
            caption="Three plain choices, a way in for anyone who wants to answer the four uses one at a time, and the conditions field that only exists while a choice needs one. Nothing here signs anything: on a real passport page this sits under the card, for its holder alone."
          >
            <div className="mt-12 max-w-[46rem]">
              <ChoicePanel />
            </div>
          </Act>

          <Act
            number="03"
            title="The stamp under a match"
            caption="What a verify answer prints once a picture is proved: the holder's statement, the day it was written, and the two answers that are not a statement at all."
          >
            <div className="mt-12 flex flex-col gap-14">
              {subjects.map((subject) => (
                <div key={subject.id}>
                  <PassportHead subject={subject} />
                  <Reveal delay={0.06}>
                    <div className="mt-6 border-t border-line pt-8">
                      <ConsentStamp consent={stampConsent(subject.reading, standard)} />
                    </div>
                  </Reveal>
                </div>
              ))}

              <Reveal>
                <div className="border-t border-line pt-8">
                  <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-text-faint">
                    And when the service could not read the register
                  </p>
                  <ConsentStamp consent={{ source: "unavailable" }} className="mt-5" />
                </div>
              </Reveal>
            </div>
          </Act>
        </div>
      </div>
    </Surface>
  );
}

/**
 * One chain reading in the shape the verify service answers with, so the stamp
 * on this bench is fed exactly what it is fed in production.
 */
function stampConsent(reading: ConsentReading, standard: string): MatchConsent {
  const entry = reading.entry;
  if (!reading.stated || entry === null) {
    return { source: "chain", stated: false };
  }

  return {
    source: "chain",
    stated: true,
    standard,
    ...entry.consent,
    constraintInfo: entry.constraintInfo.length === 0 ? undefined : entry.constraintInfo,
    at: Number(entry.at),
    writer: entry.writer,
  };
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
