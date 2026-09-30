"use client";

import { motion, type Variants } from "framer-motion";
import type { GuideMark } from "./steps";

/**
 * One small drawing per step, in the app's own language: squares, hairlines and
 * the kolam knot. Hand-drawn SVG rather than an icon pack, so the guide looks like
 * the rest of the site and costs no licence and no credit line.
 *
 * Each drawing holds still until its card is hovered or focused. The card sets
 * the variant, these inherit it, which is why the svg itself is a motion
 * element: a plain one would break the chain.
 */

const EASE = [0.16, 1, 0.3, 1] as const;

function sweep(reduced: boolean): Variants {
  return {
    rest: { y: 0, opacity: 0.35 },
    hover: reduced
      ? { y: 0, opacity: 1 }
      : { y: [0, 22, 0], opacity: 1, transition: { duration: 2.1, repeat: Infinity, ease: "easeInOut" } },
  };
}

function seal(reduced: boolean): Variants {
  return {
    rest: { scale: 0.92, opacity: 0.5, rotate: 0 },
    hover: { scale: 1, opacity: 1, rotate: reduced ? 0 : -8, transition: { duration: 0.45, ease: EASE } },
  };
}

function stroke(reduced: boolean): Variants {
  return {
    // Whole and quiet at rest: a drawing that is not there until somebody
    // hovers it reads as a missing drawing on a card nobody has touched yet.
    rest: { pathLength: 1, opacity: 0.45 },
    hover: reduced
      ? { pathLength: 1, opacity: 1 }
      : { pathLength: [0, 1], opacity: 1, transition: { duration: 0.6, ease: EASE } },
  };
}

function front(reduced: boolean): Variants {
  return {
    rest: { x: 0, y: 0 },
    hover: reduced ? { x: 0, y: 0 } : { x: 5, y: -5, transition: { duration: 0.45, ease: EASE } },
  };
}

function back(reduced: boolean): Variants {
  return {
    rest: { x: 0, y: 0, opacity: 0.55 },
    hover: reduced ? { opacity: 0.7 } : { x: -3, y: 3, opacity: 0.7, transition: { duration: 0.45, ease: EASE } },
  };
}

// The site's mark, the same line the .motif rule in globals.css masks with. It
// is repeated here because these drawings animate it inside one svg, where a
// masked element cannot go.
const KOLAM = "M22.7 12C22.7 11.49 22.64 10.84 22.48 10.48C22.32 10.11 22.11 9.81 21.74 9.81C21.37 9.82 20.9 10.06 20.28 10.51C19.66 10.95 18.87 11.71 18.03 12.49C17.19 13.28 16.17 14.32 15.24 15.24C14.32 16.17 13.28 17.19 12.49 18.03C11.71 18.87 10.95 19.66 10.51 20.28C10.06 20.9 9.82 21.37 9.81 21.74C9.81 22.11 10.11 22.32 10.48 22.48C10.84 22.64 11.49 22.7 12 22.7C12.51 22.7 13.16 22.64 13.52 22.48C13.89 22.32 14.19 22.11 14.19 21.74C14.18 21.37 13.94 20.9 13.49 20.28C13.05 19.66 12.29 18.87 11.51 18.03C10.72 17.19 9.68 16.17 8.76 15.24C7.83 14.32 6.81 13.28 5.97 12.49C5.13 11.71 4.34 10.95 3.72 10.51C3.1 10.06 2.63 9.82 2.26 9.81C1.89 9.81 1.68 10.11 1.52 10.48C1.36 10.84 1.3 11.49 1.3 12C1.3 12.51 1.36 13.16 1.52 13.52C1.68 13.89 1.89 14.19 2.26 14.19C2.63 14.18 3.1 13.94 3.72 13.49C4.34 13.05 5.13 12.29 5.97 11.51C6.81 10.72 7.83 9.68 8.76 8.76C9.68 7.83 10.72 6.81 11.51 5.97C12.29 5.13 13.05 4.34 13.49 3.72C13.94 3.1 14.18 2.63 14.19 2.26C14.19 1.89 13.89 1.68 13.52 1.52C13.16 1.36 12.51 1.3 12 1.3C11.49 1.3 10.84 1.36 10.48 1.52C10.11 1.68 9.81 1.89 9.81 2.26C9.82 2.63 10.06 3.1 10.51 3.72C10.95 4.34 11.71 5.13 12.49 5.97C13.28 6.81 14.32 7.83 15.24 8.76C16.17 9.68 17.19 10.72 18.03 11.51C18.87 12.29 19.66 13.05 20.28 13.49C20.9 13.94 21.37 14.18 21.74 14.19C22.11 14.19 22.32 13.89 22.48 13.52C22.64 13.16 22.7 12.51 22.7 12Z";

/**
 * The knot standing in a square box: its line spans 21.4 of its 24 units, so it
 * is scaled to that span, and drawn heavier at the size a phone shows it.
 */
function Kolam({ x, y, side, heavy }: { x: number; y: number; side: number; heavy: string }) {
  const scale = side / 21.4;
  return (
    <g transform={`translate(${x + side / 2 - 12 * scale} ${y + side / 2 - 12 * scale}) scale(${scale})`}>
      <path d={KOLAM} stroke="var(--accent)" strokeLinejoin="round" className={heavy} />
      <circle cx="12" cy="12" r="2.4" fill="var(--accent)" />
    </g>
  );
}

/** The four corner brackets every drawing sits inside: the frame of a plate. */
function Brackets() {
  return (
    <g stroke="currentColor" strokeWidth="1" opacity="0.35" fill="none">
      <path d="M2 10V2h8M46 2h8v8M54 46v8h-8M10 54H2v-8" />
    </g>
  );
}

export function GuideMarkDrawing({ mark, reduced }: { mark: GuideMark; reduced: boolean }) {
  return (
    <motion.svg
      viewBox="0 0 56 56"
      aria-hidden
      className="h-10 w-10 text-text-faint sm:h-14 sm:w-14"
      fill="none"
      initial={false}
    >
      <Brackets />

      {mark === "check" && (
        <>
          {/* The picture, and the fingerprint read off it. */}
          <rect x="12" y="12" width="32" height="32" stroke="currentColor" strokeWidth="1" opacity="0.5" />
          <g fill="var(--accent)" opacity="0.5">
            {[17, 24, 31, 38].map((x) =>
              [17, 24, 31, 38].map((y) => <rect key={`${x}-${y}`} x={x} y={y} width="3" height="3" />),
            )}
          </g>
          {/* The read itself: one line moving down the picture. */}
          <motion.rect
            x="12"
            y="16"
            width="32"
            height="1.5"
            fill="var(--accent)"
            variants={sweep(reduced)}
          />
        </>
      )}

      {mark === "make" && (
        <>
          <rect x="9" y="14" width="30" height="30" stroke="currentColor" strokeWidth="1" opacity="0.5" />
          {/* Two signatures, drawn one after the other. */}
          <motion.path
            d="M14 36c4-6 7-9 10-9s3 6 6 6 4-3 6-6"
            stroke="var(--accent)"
            strokeWidth="1.5"
            strokeLinecap="round"
            variants={stroke(reduced)}
          />
          {/* The seal the registry stamps on it. */}
          <motion.g variants={seal(reduced)} style={{ originX: "38px", originY: "18px" }}>
            <Kolam x={30} y={10} side={17} heavy="[stroke-width:2.3] sm:[stroke-width:1.95]" />
          </motion.g>
        </>
      )}

      {mark === "find" && (
        <>
          <motion.rect
            x="10"
            y="16"
            width="26"
            height="26"
            stroke="currentColor"
            strokeWidth="1"
            variants={back(reduced)}
          />
          <motion.rect
            x="15"
            y="12"
            width="26"
            height="26"
            stroke="currentColor"
            strokeWidth="1"
            opacity="0.6"
            variants={back(reduced)}
          />
          <motion.g variants={front(reduced)}>
            <rect x="20" y="18" width="26" height="26" stroke="var(--accent)" strokeWidth="1.5" />
            <Kolam x={24} y={22} side={6} heavy="[stroke-width:2.3]" />
          </motion.g>
        </>
      )}
    </motion.svg>
  );
}
