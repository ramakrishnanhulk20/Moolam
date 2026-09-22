"use client";

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from "react";
import { Reveal } from "@/components/lab/sponsors/Reveal";
import { Surface } from "@/components/lab/sponsors/Surface";
import { holdStill, useBench } from "./bench";
import { Pictures } from "./Pictures";
import { StateDial } from "./StateDial";
import { StatusBand } from "./StatusBand";
import { TurnCard } from "./TurnCard";
import type { BenchState, Path } from "./fixtures";

/**
 * The studio bench: two drawings of one rule, that the effect of a press
 * appears where the press was.
 *
 * Both are fed the same ten states from the same fixtures and both are driven
 * by the dial above them, so what separates them is where the answer lands and
 * nothing else.
 */
export function StudioBench() {
  const bench = useBench();
  const turn = useRef<HTMLElement>(null);
  const band = useRef<HTMLElement>(null);
  const hold = useRef<(() => void) | null>(null);

  // Reading the dial changes the height of both drawings at once. Without this
  // the one Ram is looking at slides under him while he clicks along the states,
  // which is the same complaint in miniature.
  useLayoutEffect(() => {
    hold.current?.();
    hold.current = null;
  }, [bench.state, bench.path]);

  // The bar over every page is 102 px on a laptop and 56 on a phone, where the
  // site's own --header-h says 63 for both. The dial and the band both hang off
  // the real one, measured here, or they end up behind it.
  const [tops, setTops] = useState<{ header: number; dial: number } | null>(null);
  useEffect(() => {
    const measure = () => {
      const bar = document.querySelector("header.app-header");
      const strip = document.querySelector("[data-bench-dial]");
      if (bar === null || strip === null) {
        return;
      }
      setTops({
        header: Math.round(bar.getBoundingClientRect().height),
        dial: Math.round(strip.getBoundingClientRect().height),
      });
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  const nearest = () => {
    const seen = (node: HTMLElement | null) => {
      if (node === null) {
        return -1;
      }
      const rect = node.getBoundingClientRect();
      return Math.max(0, Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0));
    };
    return seen(turn.current) >= seen(band.current) ? turn.current : band.current;
  };

  const show = (state: BenchState) => {
    hold.current = holdStill(nearest());
    bench.show(state);
  };

  const choose = (path: Path) => {
    hold.current = holdStill(nearest());
    bench.choose(path);
  };

  return (
    <Surface>
      <div
        style={
          tops === null
            ? undefined
            : ({
                "--bench-header": `${tops.header}px`,
                "--bench-top": `${tops.header + tops.dial}px`,
              } as CSSProperties)
        }
      >
        <StateDial
          path={bench.path}
          state={bench.state}
          running={bench.running}
          onPath={choose}
          onState={show}
          onPlay={bench.press}
        />

        <div className="px-5 pb-32 pt-12 sm:px-8 lg:px-14">
          <header className="mx-auto w-full max-w-[100rem]">
            <Reveal>
              <p className="flex items-center gap-3 font-mono text-[11px] uppercase tracking-[0.24em] text-accent">
                <span className="motif h-[9px] w-[9px]" />
                Studio bench
              </p>
            </Reveal>

            <Reveal delay={0.08}>
              <h1 className="mt-7 max-w-[15ch] font-display text-[clamp(3rem,10vw,9rem)] font-semibold uppercase leading-[0.85] tracking-[-0.055em]">
                The press answers itself
              </h1>
            </Reveal>

            <div className="mt-10 grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,0.85fr)] lg:gap-16">
              <Reveal delay={0.16} className="min-w-0">
                <p className="max-w-[58ch] text-base leading-relaxed text-text-muted">
                  On the studio as it stands, the progress and the receipt appear in a column beside the form, which on a
                  laptop is below it and out of sight. Press Register and the screen looks as though nothing happened.
                  Both drawings below fix that the same way and differ only in where the answer lands: in the card that
                  was pressed, or in a band pinned above it.
                </p>
                <p className="mt-5 max-w-[58ch] text-sm leading-relaxed text-text-faint">
                  Press the button in either drawing and the whole run plays out at the speeds a real one takes. The dial
                  above jumps straight to any of the ten states. Nothing on this page is read from Monad or from the
                  verify service: every state is a fixture, so all ten are reachable, and the hashes are made up.
                </p>
              </Reveal>

              <Reveal delay={0.24} className="min-w-0">
                <ul className="grid gap-px border border-line bg-line">
                  <li className="bg-bg px-5 py-4">
                    <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-accent">The rule</p>
                    <p className="mt-2 max-w-[40ch] text-sm leading-relaxed text-text-muted">
                      The effect of a press appears where the press was.
                    </p>
                  </li>
                  <li className="bg-bg px-5 py-4">
                    <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-accent">Both drawings</p>
                    <p className="mt-2 max-w-[40ch] text-sm leading-relaxed text-text-muted">
                      Put the new face under the thumb in the same frame it changes in, so the page never has to be
                      scrolled to find out what the press did.
                    </p>
                  </li>
                  <li className="bg-bg px-5 py-4">
                    <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-accent">And then</p>
                    <p className="mt-2 max-w-[40ch] text-sm leading-relaxed text-text-muted">
                      Your pictures sits directly under the panel, newest first, with the one just made lit.
                    </p>
                  </li>
                </ul>
              </Reveal>
            </div>
          </header>

          <div className="mx-auto mt-24 flex w-full max-w-[100rem] flex-col gap-28 lg:mt-32 lg:gap-40">
            <Act
              number="A"
              title="The card turns over"
              caption="One card, three faces. The form is the front; the run and the receipt are the same card, turned. Nothing outside it moves, and the two buttons at the end sit inside it: open the passport, or make another."
              hold={turn}
            >
              <div className="mt-12 grid gap-10 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)] lg:gap-16">
                <div className="min-w-0">
                  <TurnCard bench={bench} />
                  <Pictures state={bench.state} />
                </div>
                <Note
                  lines={[
                    "The whole studio is one box, so there is no second column to miss and nothing to scroll for.",
                    "The card reserves its own height, so the receipt's buttons land in one place and stay there.",
                    "Make another turns it back to a clean form without leaving the card.",
                  ]}
                />
              </div>
            </Act>

            <Act
              number="B"
              title="The form folds into a band"
              caption="The press folds the form away and leaves a slim band pinned to the top of the panel: what is happening, how long it has taken, and a thin rule for how far along it is. The answer grows underneath it in the same column."
              hold={band}
            >
              <div className="mt-12 grid gap-10 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)] lg:gap-16">
                <div className="min-w-0">
                  <StatusBand bench={bench} />
                  <Pictures state={bench.state} />
                </div>
                <Note
                  lines={[
                    "The band stays on screen while the page is scrolled, so the run is never out of sight.",
                    "Once the passport is written the band keeps one line and the way to it.",
                    "Make another unfolds the form again under the band, which stays as the last thing made.",
                  ]}
                />
              </div>
            </Act>
          </div>
        </div>
      </div>
    </Surface>
  );
}

function Act({
  number,
  title,
  caption,
  hold,
  children,
}: {
  number: string;
  title: string;
  caption: string;
  /** The section to hold still while the dial changes what is in it. */
  hold: RefObject<HTMLElement | null>;
  children: ReactNode;
}) {
  return (
    <section ref={hold}>
      <Reveal>
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:gap-16">
          <div className="flex min-w-0 items-start gap-6">
            <span className="font-mono text-[11px] tracking-[0.2em] text-accent">{number}</span>
            <h2 className="max-w-[13ch] font-display text-[clamp(2rem,5vw,4.2rem)] font-semibold uppercase leading-[0.9] tracking-[-0.045em]">
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

function Note({ lines }: { lines: string[] }) {
  return (
    <Reveal delay={0.1} className="min-w-0">
      <ul className="flex flex-col gap-px border border-line bg-line lg:sticky lg:top-[calc(var(--header-h)+6rem)]">
        {lines.map((line) => (
          <li key={line} className="bg-bg px-5 py-4 text-sm leading-relaxed text-text-muted">
            {line}
          </li>
        ))}
      </ul>
    </Reveal>
  );
}
