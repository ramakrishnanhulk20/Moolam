"use client";

import { motion } from "framer-motion";
import { useIsReducedMotion } from "@/components/motion/useIsReducedMotion";
import { SKETCH_SIDE } from "./bits";

/**
 * The two ways the same 256 bits are drawn.
 *
 * "grid" is the registry's own language: the bits as bits, the way the passport
 * page already draws the 64 bit fingerprint. "relief" is
 * the same cells out of focus, which is what the measurement actually is: a
 * picture resolved down to sixteen squares of light and dark. Neither adds a
 * thing the chain does not hold.
 */
export type SketchDrawing = "grid" | "relief";

/** How hard the relief is blurred at each size, in pixels. */
const BLUR: Record<SketchSize, number> = { poster: 15, plate: 7, small: 4 };

/** The gap between cells in the grid drawing, as a share of the sketch's width. */
const GAP: Record<SketchSize, string> = { poster: "1.1%", plate: "1.4%", small: "2%" };

export type SketchSize = "poster" | "plate" | "small";

/**
 * A picture's block hash, drawn.
 *
 * For a sealed passport this is the only trace of the picture anyone outside
 * the creator ever sees, so it is drawn as a designed thing rather than as a
 * fallback for a missing image.
 *
 * `still` takes every moving part out, for a place that cannot run motion: the
 * social card, and a print.
 */
export function SealedSketch({
  bits,
  drawing = "grid",
  size = "plate",
  still = false,
  className = "",
}: {
  /** 256 bits, highest first, from sketchBits. */
  bits: boolean[];
  drawing?: SketchDrawing;
  size?: SketchSize;
  still?: boolean;
  className?: string;
}) {
  const reduced = useIsReducedMotion();
  const quiet = still || reduced;
  const relief = drawing === "relief";

  const rows = Array.from({ length: SKETCH_SIDE }, (_, row) => bits.slice(row * SKETCH_SIDE, (row + 1) * SKETCH_SIDE));

  return (
    <div className={`relative aspect-square overflow-hidden ${className}`} aria-hidden>
      <div
        className="grid h-full w-full"
        style={{
          gridTemplateRows: `repeat(${SKETCH_SIDE}, minmax(0, 1fr))`,
          gap: relief ? "0" : GAP[size],
          // The relief is the same cells seen through a lens that cannot
          // resolve them. It is grown a little first so the blur has something
          // to eat at the edges instead of fading the sketch's own border.
          filter: relief ? `blur(${BLUR[size]}px)` : undefined,
          transform: relief ? "scale(1.06)" : undefined,
        }}
      >
        {rows.map((row, at) => (
          <motion.div
            key={at}
            className="grid"
            style={{ gridTemplateColumns: `repeat(${SKETCH_SIDE}, minmax(0, 1fr))`, gap: relief ? "0" : GAP[size] }}
            initial={quiet ? false : { opacity: 0, x: -8 }}
            whileInView={{ opacity: 1, x: 0 }}
            viewport={{ once: true, amount: 0.3 }}
            transition={{ duration: 0.5, delay: at * 0.028, ease: [0.16, 1, 0.3, 1] }}
          >
            {row.map((bit, column) => (
              <span
                key={column}
                className={
                  bit
                    ? "bg-text"
                    : relief
                      ? "bg-transparent"
                      : "bg-text/[0.06]"
                }
              />
            ))}
          </motion.div>
        ))}
      </div>

      {/* One pass of light across the sketch, the way a scanner reads a plate.
          The same move the fingerprint grid on a passport page makes, so the
          two read as one family. */}
      {quiet ? null : (
        <motion.span
          className="pointer-events-none absolute inset-y-0 w-1/4 bg-gradient-to-r from-transparent via-text/20 to-transparent"
          initial={{ x: "-25%", opacity: 0 }}
          whileInView={{ x: ["-25%", "400%"], opacity: [0, 1, 0] }}
          viewport={{ once: true, amount: 0.3 }}
          transition={{ duration: 1.8, delay: 0.55, ease: "easeInOut" }}
        />
      )}
    </div>
  );
}
