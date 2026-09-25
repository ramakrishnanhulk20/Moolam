"use client";

import { motion } from "framer-motion";
import { useIsReducedMotion } from "@/components/motion/useIsReducedMotion";

/**
 * A fingerprint as the 64 bits it is: eight rows of eight, highest bit first.
 *
 * The bits are handed in already read off the chain. The second grid marks
 * every cell that disagrees with the first, so "0 of 64 bits apart" is
 * something a reader can see rather than a claim they have to take.
 *
 * Shared: the passport page draws it under the second opinion, and any other
 * screen that draws the pair reads this same component.
 */
export function BitGrid({
  bits,
  against,
  label,
  tone,
}: {
  bits: boolean[];
  /** The other reading, when this grid is the one being compared. */
  against?: boolean[];
  label: string;
  tone: "original" | "recomputed";
}) {
  const reduced = useIsReducedMotion();

  return (
    <figure className="min-w-0">
      <figcaption className="font-mono text-[10px] uppercase tracking-[0.2em] text-text-faint">{label}</figcaption>
      <div className="relative mt-3 w-full max-w-[13rem]">
        <div className="grid aspect-square grid-cols-8 gap-[3px]">
          {bits.map((bit, at) => {
            const apart = against !== undefined && against[at] !== bit;
            return (
              <motion.span
                key={at}
                initial={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.4 }}
                whileInView={{ opacity: 1, scale: 1 }}
                viewport={{ once: true, amount: 0.4 }}
                transition={
                  reduced
                    ? { duration: 0.2 }
                    : { duration: 0.45, delay: at * 0.006, ease: [0.16, 1, 0.3, 1] }
                }
                className={
                  apart
                    ? "bg-failed"
                    : bit
                      ? tone === "recomputed"
                        ? "bg-verified"
                        : "bg-text"
                      : "border border-line"
                }
              />
            );
          })}
        </div>

        {/* One pass of light across the grid, the way a scanner reads a plate.
            It runs once, on arrival, and not at all for anyone who asked for
            less motion. */}
        {reduced ? null : (
          <motion.span
            aria-hidden
            className="pointer-events-none absolute inset-y-0 w-16 bg-gradient-to-r from-transparent via-text/25 to-transparent"
            initial={{ x: "-4rem", opacity: 0 }}
            whileInView={{ x: ["-4rem", "13rem"], opacity: [0, 1, 0] }}
            viewport={{ once: true, amount: 0.4 }}
            transition={{ duration: 1.5, delay: 0.5, ease: "easeInOut" }}
          />
        )}
      </div>
    </figure>
  );
}
