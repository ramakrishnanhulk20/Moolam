"use client";

import { motion, type Variants } from "framer-motion";
import type { GuideMark } from "./steps";

/**
 * One small drawing per step, in the app's own language: squares, hairlines and
 * the seal. Hand-drawn SVG rather than an icon pack, so the guide looks like
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
            <rect x="30" y="10" width="17" height="17" fill="var(--accent)" />
            <rect x="34" y="14" width="9" height="9" stroke="var(--accent-ink)" strokeWidth="1" />
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
            <rect x="24" y="22" width="6" height="6" fill="var(--accent)" />
          </motion.g>
        </>
      )}
    </motion.svg>
  );
}
