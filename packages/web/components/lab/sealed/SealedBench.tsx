"use client";

import { useState } from "react";
import { Reveal } from "@/components/lab/sponsors/Reveal";
import { CardFrame } from "./CardFrame";
import { Surface } from "@/components/lab/sponsors/Surface";
import { Mono } from "@/components/passport/Mono";
import { SealSwitch } from "@/components/sealed/SealSwitch";
import { SealedPlate } from "@/components/sealed/SealedPlate";
import { SealedShareCard } from "@/components/sealed/SealedShareCard";
import type { SketchDrawing } from "@/components/sealed/Sketch";

/** One real passport, with everything the chain said about it while the page rendered. */
export interface SealedSubject {
  id: string;
  shortId: string;
  /** Why this picture is on the bench, in one line. */
  caption: string;
  title: string | null;
  /** 256 bits of the block hash, or null when the registry had no record for this id. */
  bits: boolean[] | null;
  blockhash: string | null;
  /** The perceptual hash as the registry stores it, and as hex, so both can be checked. */
  phash: string | null;
  phashHex: string | null;
  registered: string;
  agentId: string;
  plateLine: string;
  cardLine: string;
}

const PLATE_WORDS = { sealed: "Sealed", untitled: "Untitled" };

const SWITCH_WORDS = {
  label: "Keep this picture sealed",
  note: "Moolam publishes the passport, not the picture. Save the file we hand back: it is the only copy that can unseal this passport.",
  panelHeading: "What becomes public",
  panelLine:
    "Everything below goes out the moment you sign, and nothing can be taken back off an immutable registry. The picture itself is not on the list.",
  sketchCaption: "The whole of the picture that becomes public.",
  inFile: "Pinned file",
  onChain: "On Monad",
  leftOut: "Left out",
  promptLabel: "Include the prompt",
  promptNote: "The prompt stays private unless you include it.",
};

/**
 * The sealed bench: how a passport with no picture in it looks on the three
 * screens that will have to show one, and the switch the creator flips before
 * any of that happens.
 *
 * Every plate on this page is drawn from a block hash read off Monad while the
 * page rendered, which is the honest thing to draw: that hash is public, it is
 * all that is public of a sealed picture, and a mocked one would be showing Ram
 * a promise instead of the product.
 */
export function SealedBench({ subjects }: { subjects: SealedSubject[] }) {
  const [poster, second] = subjects;

  return (
    <Surface>
      <div className="pb-32 pt-10">
        <header className="mx-auto w-full max-w-[100rem] px-5 sm:px-8 lg:px-14">
          <Reveal>
            <p className="flex items-center gap-3 font-mono text-[11px] uppercase tracking-[0.24em] text-accent">
              <span className="motif h-[9px] w-[9px]" />
              Sealed bench
            </p>
          </Reveal>

          <Reveal delay={0.08}>
            <h1 className="mt-7 max-w-[16ch] font-display text-[clamp(3rem,10vw,9rem)] font-semibold uppercase leading-[0.85] tracking-[-0.055em]">
              A passport with nothing to show
            </h1>
          </Reveal>

          <div className="mt-10 grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,0.85fr)] lg:gap-16">
            <Reveal delay={0.16} className="min-w-0">
              <p className="max-w-[58ch] text-base leading-relaxed text-text-muted">
                A creator registers a picture on Monad and keeps the picture. The passport, the date and the statement
                on AI use are public; the file never leaves their machine, and Moolam keeps no copy of it. What every
                screen can still draw is the 16 by 16 block hash, a reading of light and dark that the registry holds
                for every passport. So that is what a sealed passport shows: not a broken picture, not a grey box, the
                measurement itself.
              </p>
              <p className="mt-5 max-w-[58ch] text-sm leading-relaxed text-text-faint">
                The two pictures below are real records on mainnet, read while this page rendered. Their titles, their
                dates and every bit in every plate came off the chain.
              </p>
            </Reveal>

            <Reveal delay={0.24} className="min-w-0">
              <ul className="grid gap-px border border-line bg-line">
                {subjects.map((subject) => (
                  <li key={subject.id} className="bg-bg p-5">
                    <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-accent">{subject.shortId}</p>
                    <p className="mt-2.5 font-display text-[1.05rem] font-semibold leading-tight tracking-[-0.02em]">
                      {subject.title ?? "Untitled"}
                    </p>
                    <p className="mt-2 max-w-[42ch] text-xs leading-relaxed text-text-faint">{subject.caption}</p>
                  </li>
                ))}
              </ul>
            </Reveal>
          </div>
        </header>

        <Drawing
          drawing="grid"
          number="One"
          name="The grid"
          note="The bits as bits, in the language the passport page already uses under a re-check: hard cells, one square for each of the 256 measurements. It reads as a record."
          rolls="Rolls into the passport page header, where a published picture sits today, and into Explore's sheet."
          poster={poster}
          second={second}
        />

        <Drawing
          drawing="relief"
          number="Two"
          name="The relief"
          note="The same 256 bits, out of focus. It is what the measurement honestly is, a picture resolved down to sixteen squares of light and dark, and it reads as a still nobody is allowed to see yet."
          rolls="The same two places. Only the drawing of the sketch changes; the type, the sizes and the words are one component."
          poster={poster}
          second={second}
        />

        <section className="mx-auto mt-28 w-full max-w-[100rem] px-5 sm:px-8 lg:px-14">
          <Reveal>
            <p className="font-mono text-[11px] uppercase tracking-[0.24em] text-accent">The link preview</p>
            <h2 className="mt-5 max-w-[20ch] font-display text-[clamp(1.9rem,4.4vw,3.4rem)] font-semibold uppercase leading-[0.95] tracking-[-0.035em]">
              What lands in a chat
            </h2>
          </Reveal>

          <div className="mt-10 grid gap-10 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,0.65fr)] lg:gap-16">
            <Reveal delay={0.1} className="min-w-0">
              {poster.bits === null ? (
                <Missing subject={poster} />
              ) : (
                <div className="border border-line">
                  <CardPreview subject={poster} />
                </div>
              )}
            </Reveal>

            <Reveal delay={0.18} className="min-w-0">
              <p className="max-w-[46ch] text-sm leading-relaxed text-text-muted">
                Drawn here at its real 1200 by 630 and shrunk to fit, so the type is exactly the size a crawler gets.
                The card a published passport carries puts the registered picture where the sketch is. Everything else
                on it, the mark, the id, the title, the accent line, is the card the app already ships.
              </p>
              <p className="mt-5 max-w-[46ch] text-xs leading-relaxed text-text-faint">
                Rolls into the passport card route, which draws with satori rather than a browser. This is the layout
                for that work, not the route itself.
              </p>
            </Reveal>
          </div>
        </section>

        <section className="mx-auto mt-28 w-full max-w-[100rem] px-5 sm:px-8 lg:px-14">
          <Reveal>
            <p className="font-mono text-[11px] uppercase tracking-[0.24em] text-accent">The studio</p>
            <h2 className="mt-5 max-w-[22ch] font-display text-[clamp(1.9rem,4.4vw,3.4rem)] font-semibold uppercase leading-[0.95] tracking-[-0.035em]">
              Say what becomes public, before the passkey
            </h2>
            <p className="mt-6 max-w-[62ch] text-sm leading-relaxed text-text-muted">
              Both switches below are live. The left one is the studio&apos;s upload path, where nobody drew the
              picture and there is no prompt to keep back; the right one is the generate path, which puts a model and a
              prompt on the list. Each sketch is a real fingerprint read off the chain. The list itself is not written
              into the panel: it comes from one constant that a test holds against the verify service&apos;s own
              schema, key for key.
            </p>
          </Reveal>

          <div className="mt-12 grid gap-12 lg:grid-cols-2 lg:gap-16">
            <Reveal delay={0.1} className="min-w-0">
              <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-text-faint">
                Off, as the studio opens, on the upload path
              </p>
              <SwitchCase subject={poster} generated={false} start={false} className="mt-5" />
              <p className="mt-6 max-w-[48ch] text-xs leading-relaxed text-text-faint">
                Rolls into the studio, under the AI use choice and above the register button.
              </p>
            </Reveal>

            <Reveal delay={0.18} className="min-w-0">
              <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-text-faint">
                On, on the generate path
              </p>
              <SwitchCase subject={second} generated start className="mt-5" />
              <p className="mt-6 max-w-[48ch] text-xs leading-relaxed text-text-faint">
                The panel grows in place. Nothing above it moves, which is the point: a creator reading this list is
                about to sign.
              </p>
            </Reveal>
          </div>
        </section>
      </div>
    </Surface>
  );
}

/** One drawing of the sketch, shown at both the sizes it has to work at. */
function Drawing({
  drawing,
  number,
  name,
  note,
  rolls,
  poster,
  second,
}: {
  drawing: SketchDrawing;
  number: string;
  name: string;
  note: string;
  rolls: string;
  poster: SealedSubject;
  second: SealedSubject;
}) {
  return (
    <section className="mt-28">
      <div className="mx-auto w-full max-w-[100rem] px-5 sm:px-8 lg:px-14">
        <Reveal>
          <p className="font-mono text-[11px] uppercase tracking-[0.24em] text-accent">Drawing {number}</p>
          <h2 className="mt-5 max-w-[18ch] font-display text-[clamp(1.9rem,4.4vw,3.4rem)] font-semibold uppercase leading-[0.95] tracking-[-0.035em]">
            {name}
          </h2>
          <p className="mt-6 max-w-[62ch] text-sm leading-relaxed text-text-muted">{note}</p>
        </Reveal>
      </div>

      <div className="mt-10">
        {poster.bits === null ? (
          <div className="mx-auto w-full max-w-[100rem] px-5 sm:px-8 lg:px-14">
            <Missing subject={poster} />
          </div>
        ) : (
          <SealedPlate
            bits={poster.bits}
            title={poster.title}
            shortId={poster.shortId}
            words={{ ...PLATE_WORDS, line: poster.plateLine }}
            drawing={drawing}
            size="poster"
          />
        )}
      </div>

      <div className="mx-auto mt-12 w-full max-w-[100rem] px-5 sm:px-8 lg:px-14">
        <div className="grid gap-10 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] lg:gap-16">
          <div className="grid grid-cols-2 gap-5 sm:gap-6">
            {[poster, second].map((subject, at) => (
              <Reveal key={subject.id} delay={0.08 * at} className="min-w-0">
                {subject.bits === null ? (
                  <Missing subject={subject} />
                ) : (
                  <SealedPlate
                    bits={subject.bits}
                    title={subject.title}
                    words={{ ...PLATE_WORDS, line: subject.plateLine }}
                    drawing={drawing}
                  />
                )}
              </Reveal>
            ))}
          </div>

          <Reveal delay={0.16} className="min-w-0">
            <p className="max-w-[52ch] text-sm leading-relaxed text-text-muted">{rolls}</p>
            <dl className="mt-7 border-t border-line">
              {[poster, second].map((subject) => (
                <div key={subject.id} className="border-b border-line py-4">
                  <dt className="font-mono text-[10px] uppercase tracking-[0.2em] text-text-faint">
                    {subject.title ?? "Untitled"}
                  </dt>
                  <dd className="mt-2 space-y-1.5 text-[11px] leading-relaxed text-text-muted">
                    <p>
                      <span className="text-text-faint">blockhash256 </span>
                      <Mono value={subject.blockhash ?? "not read"} />
                    </p>
                    <p>
                      <span className="text-text-faint">phash </span>
                      <Mono value={subject.phash ?? "not read"} /> <span className="text-text-faint">(</span>
                      <Mono value={subject.phashHex ?? ""} />
                      <span className="text-text-faint">)</span>
                    </p>
                    <p>
                      <span className="text-text-faint">registered </span>
                      {subject.registered}
                      <span className="text-text-faint"> agent </span>
                      {subject.agentId}
                    </p>
                  </dd>
                </div>
              ))}
            </dl>
            <p className="mt-5 max-w-[52ch] text-xs leading-relaxed text-text-faint">
              Every plate above is drawn from the blockhash256 printed here. Read the same word off the registry with
              cast and the squares will match, line for line.
            </p>
          </Reveal>
        </div>
      </div>
    </section>
  );
}

/** The card preview at its real size, inside a frame that shrinks it to the column. */
function CardPreview({ subject }: { subject: SealedSubject }) {
  return (
    <CardFrame>
      <SealedShareCard
        bits={subject.bits ?? []}
        title={subject.title}
        shortId={subject.shortId}
        words={{ sealed: "Sealed", untitled: "Untitled", line: subject.cardLine }}
      />
    </CardFrame>
  );
}

/** One live switch, holding its own two answers the way the studio will hold them. */
function SwitchCase({
  subject,
  generated,
  start,
  className,
}: {
  subject: SealedSubject;
  generated: boolean;
  start: boolean;
  className?: string;
}) {
  const [on, setOn] = useState(start);
  const [includePrompt, setIncludePrompt] = useState(false);

  return (
    <SealSwitch
      on={on}
      onChange={setOn}
      bits={subject.bits}
      generated={generated}
      includePrompt={includePrompt}
      onIncludePrompt={setIncludePrompt}
      words={SWITCH_WORDS}
      className={className}
    />
  );
}

/** What the bench says when the registry had no record for an id it was given. */
function Missing({ subject }: { subject: SealedSubject }) {
  return (
    <div className="border border-dashed border-line-strong p-6">
      <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-text-faint">{subject.shortId}</p>
      <p className="mt-3 max-w-[40ch] text-sm leading-relaxed text-text-muted">
        The registry did not hand back a record for this id while the page rendered, so there is no block hash to draw.
        Nothing is invented here.
      </p>
    </div>
  );
}
