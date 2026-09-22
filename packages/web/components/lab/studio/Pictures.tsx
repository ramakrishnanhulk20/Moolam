"use client";

import { motion } from "framer-motion";
import { shortHex } from "@/lib/chain/client";
import { Link } from "@/lib/i18n/routing";
import { useIsReducedMotion } from "@/components/motion/useIsReducedMotion";
import { PICTURES_MADE, type BenchState } from "./fixtures";

/**
 * The strip of everything this account has made, moved up to sit directly under
 * the panel.
 *
 * It used to be a long way down the page under a heading nobody scrolled to,
 * which is how a creator ends up hunting for a picture they made a minute ago.
 * The newest is first, and the one the run just made is lit for as long as the
 * receipt is on screen.
 */
export function Pictures({ state }: { state: BenchState }) {
  const reduced = useIsReducedMotion();
  const fresh = state === "donePublic" || state === "doneSealed" || state === "statementFailed";

  return (
    <section className="mt-10">
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
        <h3 className="font-display text-[clamp(1.1rem,2vw,1.5rem)] font-semibold uppercase tracking-[-0.02em]">
          Your pictures
        </h3>
        <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-text-faint">Newest first</p>
      </div>

      <ul className="-mx-5 mt-5 flex snap-x snap-mandatory gap-px overflow-x-auto px-5 pb-2 sm:mx-0 sm:grid sm:grid-cols-2 sm:overflow-visible sm:px-0 sm:pb-0 lg:grid-cols-4">
        {PICTURES_MADE.map((picture, index) => {
          const lit = fresh && index === 0;

          return (
            <motion.li
              key={picture.id}
              animate={
                reduced
                  ? {}
                  : { scale: lit ? 1 : 0.995, opacity: lit || !fresh ? 1 : 0.72 }
              }
              transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
              className={`relative w-[68vw] shrink-0 snap-start border bg-bg-raised sm:w-auto ${
                lit ? "border-accent" : "border-line"
              }`}
            >
              <Link href={`/passport/${picture.id}`} className="group block">
                <div className="grain relative aspect-[4/3] overflow-hidden bg-bg-sunken">
                  {picture.image === null ? (
                    <span className="absolute inset-0 flex items-center justify-center px-4 text-center font-mono text-[10px] uppercase tracking-[0.2em] text-text-faint">
                      Sealed, no picture published
                    </span>
                  ) : (
                    // A picture the site already ships, standing in for the pinned thumbnail.
                    <img
                      src={picture.image}
                      alt=""
                      loading="lazy"
                      className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-[1.03]"
                    />
                  )}
                  <div className="scrim pointer-events-none absolute inset-0" />
                  {lit ? (
                    <span className="absolute start-3 top-3 rounded-[6px] bg-accent px-2.5 py-1 font-mono text-[9px] uppercase tracking-[0.18em] text-accent-ink">
                      Just made
                    </span>
                  ) : null}
                </div>

                <div className="p-4">
                  <p className="truncate text-sm text-text transition-colors duration-200 group-hover:text-accent">
                    {picture.title}
                  </p>
                  <p className="mt-2 font-mono text-[10px] text-text-faint">{shortHex(picture.id, 8, 6)}</p>
                  <p className="mt-1 font-mono text-[10px] text-text-faint">
                    {picture.kind} <span className="mx-1">/</span>
                    {picture.when}
                  </p>
                </div>
              </Link>
            </motion.li>
          );
        })}
      </ul>
    </section>
  );
}
