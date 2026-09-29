"use client";

import { motion } from "framer-motion";
import { useIsReducedMotion } from "@/components/motion/useIsReducedMotion";
import { ShareLink } from "@/components/passport/ShareLink";
import { SealedSketch, type SketchDrawing } from "./Sketch";

/**
 * The words a sealed plate says. They are props rather than message keys so the
 * one component can be the passport page's poster, Explore's plate and the
 * studio's sealed band, each handing it the language its reader asked for.
 */
export interface SealedPlateWords {
  /** The label, drawn in the mono style the app uses for a kicker. */
  sealed: string;
  /** "Registered 14 Sep 2026. The picture is not published." */
  line: string;
  /** What a passport that pinned no name is called. */
  untitled: string;
}

/** The Copy link words, the same three the public poster hands its credit line. */
export interface SealedShareWords {
  copy: string;
  copied: string;
  copyFailed: string;
}

/**
 * The poster's height. On a phone it is a little shorter than a picture's
 * poster, because the passport page hangs the facts strip under the plate
 * rather than on it, and at 375 by 812 the strip's last line has to end clear
 * of the tab bar. From 640 px up it matches the picture's poster exactly.
 */
export const POSTER_HEIGHT = "h-[57vh] min-h-[26rem] sm:h-[min(78vh,46rem)]";

/**
 * A passport whose picture was never published, drawn as the thing it is.
 *
 * What is on it is the block hash, which is public, and the title, the date and
 * the word sealed. Nothing here is a placeholder for an image that failed to
 * load: a sealed passport has no image to fail, and invariant 7 of the threat
 * model is that it never reads as a fault.
 *
 * Two sizes. "poster" is the header a passport page opens with, in the same
 * type as the poster that carries a real picture and, from 640 px up, the same
 * height. "plate" is the
 * four by five tile Explore lays out in its sheet.
 *
 * `share` gives the poster the same Copy link the public poster carries, under
 * the date line where the public one sits in its credit line. A sealed passport
 * is shared as often as a public one, and its page is the whole of what there is
 * to send.
 */
export function SealedPlate({
  bits,
  title,
  words,
  drawing = "grid",
  size = "plate",
  shortId,
  as = "h2",
  share,
}: {
  /** 256 bits from sketchBits, read off the chain. */
  bits: boolean[];
  title: string | null;
  words: SealedPlateWords;
  drawing?: SketchDrawing;
  size?: "poster" | "plate";
  /** The shortened passport id, drawn on the poster beside the label. */
  shortId?: string;
  /** The heading level, because a passport page opens on this and a sheet does not. */
  as?: "h1" | "h2" | "h3";
  /** Only the poster draws it. */
  share?: SealedShareWords;
}) {
  const reduced = useIsReducedMotion();
  const Heading = as;
  const named = title === null || title.trim().length === 0 ? words.untitled : title;

  const enter = {
    initial: reduced ? { opacity: 0 } : { opacity: 0, y: 18 },
    whileInView: { opacity: 1, y: 0 },
    viewport: { once: true, amount: 0.25 } as const,
  };

  if (size === "poster") {
    return (
      <div className={`group grain relative w-full overflow-hidden border-b border-line bg-bg-sunken ${POSTER_HEIGHT}`}>
        {/* The one light in the frame sits behind the sketch, off centre, so the
            plate has a direction to it rather than a subject in the middle. */}
        <span
          aria-hidden
          className="pointer-events-none absolute end-[4%] top-[-12%] h-[86%] w-[86%] rounded-full bg-accent-soft blur-[90px] sm:w-[52%]"
        />

        <motion.div
          {...enter}
          transition={reduced ? { duration: 0.3 } : { duration: 0.9, ease: [0.16, 1, 0.3, 1] }}
          className="absolute end-[6%] top-[9%] h-[44%] max-h-[26rem] sm:end-[9%] sm:top-[10%] sm:h-[70%]"
        >
          <SealedSketch bits={bits} drawing={drawing} size="poster" className="h-full" />
        </motion.div>

        <div className="scrim pointer-events-none absolute inset-0" />
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 h-32"
          style={{ background: "linear-gradient(to bottom, var(--scrim-from) 0%, var(--scrim-to) 100%)" }}
        />

        <div className="absolute inset-x-0 top-0 flex flex-wrap items-center gap-x-5 gap-y-2 px-5 py-6 sm:px-8">
          <p className="flex items-center gap-3 font-mono text-[11px] uppercase tracking-[0.28em] text-accent">
            <span className="motif h-[10px] w-[10px]" />
            {words.sealed}
          </p>
          {shortId === undefined ? null : (
            <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-text-faint">{shortId}</p>
          )}
        </div>

        <div className="absolute inset-x-0 bottom-0 px-5 pb-8 sm:px-8 sm:pb-12">
          <div className="mx-auto w-full max-w-[1400px]">
            <Heading className="rise max-w-[14ch] font-display text-[clamp(2.2rem,7vw,5.5rem)] font-semibold uppercase leading-[0.9] tracking-[-0.04em]">
              {named}
            </Heading>
            <p
              className="rise mt-5 max-w-[48ch] font-mono text-[11px] leading-relaxed tracking-[0.04em] text-text-muted sm:text-xs"
              style={{ animationDelay: "120ms" }}
            >
              {words.line}
            </p>
            {share === undefined ? null : (
              <div
                data-sealed-share
                className="rise mt-3 flex flex-wrap items-center gap-y-2 font-mono text-[11px] uppercase tracking-[0.2em] text-text-muted sm:mt-4"
                style={{ animationDelay: "160ms" }}
              >
                <ShareLink words={share} />
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <motion.div
      {...enter}
      transition={reduced ? { duration: 0.3 } : { duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
      className="group relative flex aspect-[4/5] min-w-0 flex-col justify-between overflow-hidden bg-bg-sunken"
    >
      <span
        aria-hidden
        className="pointer-events-none absolute end-[-18%] top-[-22%] h-[70%] w-[70%] rounded-full bg-accent-soft blur-[48px]"
      />

      {/* The sketch takes the top half and the words the bottom, rather than the
          words sitting on the cells: a title over a high contrast grid is not
          readable at the size a phone draws this. */}
      <div className="absolute inset-x-0 top-[9%] flex h-[52%] justify-center">
        <SealedSketch
          bits={bits}
          drawing={drawing}
          size="plate"
          className="h-full transition-transform duration-[900ms] ease-[cubic-bezier(0.16,1,0.3,1)] group-hover:scale-[1.05]"
        />
      </div>

      <span className="grain pointer-events-none absolute inset-0" />
      <span className="scrim pointer-events-none absolute inset-0" />
      {/* A second pass of the poster gradient over the lower half. One is enough
          under a photograph; a title over a hard grid of lit cells needs the
          ground to come back before it is readable. */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-x-0 bottom-0 h-[62%]"
        style={{ background: "linear-gradient(to top, var(--scrim-from) 38%, var(--scrim-to) 100%)" }}
      />
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0 border border-transparent transition-colors duration-500 group-hover:border-accent/60"
      />

      <span className="pointer-events-none relative flex items-center gap-2 p-3 font-mono text-[9px] uppercase tracking-[0.2em] text-accent">
        <span className="motif h-[7px] w-[7px] opacity-70 transition-opacity duration-500 group-hover:opacity-100" />
        {words.sealed}
      </span>

      <span className="pointer-events-none relative block p-3 pt-8 sm:p-4">
        <span className="line-clamp-2 block font-display text-[0.95rem] font-semibold leading-tight tracking-[-0.02em] text-text transition-colors duration-300 group-hover:text-accent sm:text-[1.05rem]">
          {named}
        </span>
        <span className="mt-1.5 line-clamp-3 block font-mono text-[10px] leading-snug text-text-muted sm:text-[11px]">
          {words.line}
        </span>
        <span
          aria-hidden
          className="mt-3 block h-px w-0 bg-accent transition-[width] duration-500 ease-[cubic-bezier(0.16,1,0.3,1)] group-hover:w-full"
        />
      </span>
    </motion.div>
  );
}
