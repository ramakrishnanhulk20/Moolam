import type { ReactNode } from "react";
import { MONAD_EXPLORER } from "@/lib/chain/client";
import { Reveal } from "./Reveal";

/**
 * The bench's own furniture: the frame each act sits in, the two panes, and the
 * small pieces both panes share. English on purpose, the same as the other lab
 * benches: nothing links here and the page ships nowhere.
 */

/** Whole numbers with separators, in one place so every figure on the bench reads the same. */
export function count(value: number | bigint): string {
  return value.toLocaleString("en-US");
}

const WHEN = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "medium", timeZone: "UTC" });

/** A block's second, written out. UTC, because the block carries no zone and the reader deserves one. */
export function when(seconds: bigint): string {
  return `${WHEN.format(new Date(Number(seconds) * 1000))} UTC`;
}

/**
 * An amount in MON at four decimals, which is where the eye stops on a gas
 * figure. Rounded rather than cut, so the shown figure is the nearest one and
 * never quietly under the real cost. The exact string is printed beside it
 * everywhere this is used.
 */
export function mon(amount: string): string {
  return Number(amount).toFixed(4);
}

/** A gas price in gwei, which is the unit anyone reading a receipt thinks in. */
export function gwei(price: bigint): string {
  const value = Number(price) / 1e9;
  return value >= 10 ? count(Math.round(value)) : value.toFixed(2);
}

export function txLink(hash: string): string {
  return `${MONAD_EXPLORER}/tx/${hash}`;
}

export function addressLink(address: string): string {
  return `${MONAD_EXPLORER}/address/${address}`;
}

/**
 * One act: the number, the sponsor, what the panel is for, and the two panes
 * under it.
 *
 * The panes overlap on a wide screen, the quiet one set back and half a step
 * behind, so the pair reads as one moment in two takes rather than as a
 * feature comparison table.
 */
export function Act({
  index,
  sponsor,
  heading,
  standfirst,
  quiet,
  visible,
}: {
  index: string;
  sponsor: string;
  heading: string;
  standfirst: string;
  quiet: ReactNode;
  visible: ReactNode;
}) {
  return (
    <section className="relative">
      <Reveal>
        <div className="flex flex-col gap-4 border-t border-line pt-6 lg:flex-row lg:items-start lg:gap-10">
          <p className="font-mono text-[11px] uppercase tracking-[0.3em] text-accent">{index}</p>
          <div className="lg:max-w-[46ch]">
            <p className="font-mono text-[11px] uppercase tracking-[0.3em] text-text-faint">{sponsor}</p>
            <h2 className="mt-4 font-display text-[clamp(2rem,5vw,4rem)] font-semibold uppercase leading-[0.9] tracking-[-0.045em]">
              {heading}
            </h2>
          </div>
          <p className="max-w-[54ch] text-sm leading-relaxed text-text-muted lg:ms-auto lg:mt-2">{standfirst}</p>
        </div>
      </Reveal>

      {/* The quiet take is narrower and set back; the visible one is wider and
          steps over it. On a phone they stack, quiet first, in reading order. */}
      <div className="mt-10 grid gap-8 lg:mt-14 lg:grid-cols-[minmax(0,0.78fr)_minmax(0,1.22fr)] lg:items-start lg:gap-0">
        <Reveal className="lg:pt-16">
          <Pane tone="quiet" label="As it reads today">
            {quiet}
          </Pane>
        </Reveal>
        <Reveal delay={0.12} className="lg:-ms-10 lg:pt-0">
          <Pane tone="visible" label="If the sponsor showed">
            {visible}
          </Pane>
        </Reveal>
      </div>
    </section>
  );
}

/**
 * One take. The quiet pane is drawn back with a thin rule and muted type; the
 * visible one carries the accent edge, the raised ground and the shadow that
 * lifts it over its neighbour.
 */
export function Pane({
  tone,
  label,
  children,
}: {
  tone: "quiet" | "visible";
  label: string;
  children: ReactNode;
}) {
  const quiet = tone === "quiet";

  return (
    <figure
      className={`relative h-full ${
        quiet
          ? "border border-line bg-bg-raised/60 opacity-80 transition-opacity duration-300 hover:opacity-100"
          : "grain z-10 border border-line border-s-2 border-s-accent bg-bg-raised shadow-[0_40px_90px_-40px_rgb(0_0_0_/_0.55)]"
      }`}
    >
      <figcaption
        className={`flex items-center gap-3 border-b border-line px-5 py-3 font-mono text-[10px] uppercase tracking-[0.24em] sm:px-7 ${
          quiet ? "text-text-faint" : "text-accent"
        }`}
      >
        {quiet ? <span aria-hidden className="h-[7px] w-[7px] border border-current" /> : <span className="motif h-[9px] w-[9px]" />}
        {label}
      </figcaption>
      <div className="px-5 py-7 sm:px-7 sm:py-9">{children}</div>
    </figure>
  );
}

/** A mono label over its value, the shape every fact on the site is written in. */
export function Field({
  label,
  value,
  href,
  wrap = false,
}: {
  label: string;
  value: string;
  href?: string;
  wrap?: boolean;
}) {
  return (
    <div className="min-w-0">
      <dt className="font-mono text-[10px] uppercase tracking-[0.2em] text-text-faint">{label}</dt>
      <dd className={`mt-1.5 font-mono text-sm tabular-nums ${wrap ? "break-words" : "break-all"}`}>
        {href === undefined ? (
          value
        ) : (
          <a
            href={href}
            target="_blank"
            rel="noreferrer"
            className="underline decoration-line underline-offset-4 transition-colors duration-200 hover:text-accent"
          >
            {value}
          </a>
        )}
      </dd>
    </div>
  );
}

/**
 * What stands in a panel's place when its source would not answer.
 *
 * Every figure on this bench is read live, so a source that is down costs the
 * panel its numbers. The endpoint's own words go on the page rather than a
 * shrug, because the difference between "nothing matched" and "nobody
 * answered" is the whole point of reading live.
 */
export function Missing({ why }: { why: string }) {
  return (
    <div className="border-s-2 border-failed ps-5">
      <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-failed">No number to show</p>
      <p className="mt-3 max-w-[52ch] text-sm leading-relaxed text-text-muted">{why}</p>
    </div>
  );
}

/** The line under a visible pane that says what the figure above it is and is not. */
export function Footnote({ children }: { children: ReactNode }) {
  return <p className="mt-7 max-w-[56ch] border-t border-line pt-5 text-xs leading-relaxed text-text-faint">{children}</p>;
}
