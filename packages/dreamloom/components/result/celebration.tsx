"use client";

import { motion, useReducedMotion } from "framer-motion";

const COLOURS = ["#5a3bff", "#ff6a1f", "#ffd63a", "#3f22e0", "#ff6a1f", "#ffd63a"];

/** Loose threads flung off the loom, spaced evenly round the circle with a fixed wobble so every render matches. */
const THREADS = Array.from({ length: 30 }, (_, index) => {
  const angle = (index / 30) * Math.PI * 2 + (index % 3) * 0.17;
  const reach = 170 + ((index * 37) % 5) * 45;
  return {
    x: Math.cos(angle) * reach,
    y: Math.sin(angle) * reach,
    rotate: ((index * 53) % 180) - 90,
    colour: COLOURS[index % COLOURS.length],
    long: index % 3 !== 0,
    delay: (index % 5) * 0.03,
  };
});

/**
 * A short burst of coloured threads when a passport lands on this visit, in Dreamloom's own
 * colours. It plays once, sits behind nothing a visitor can press, and is skipped entirely for a
 * visitor who asked for less motion.
 */
export function Celebration() {
  const still = useReducedMotion() ?? false;
  if (still) return null;
  return (
    <div aria-hidden className="pointer-events-none absolute top-1/2 left-1/2 z-20 size-0">
      {THREADS.map((thread, index) => (
        <motion.span
          key={index}
          initial={{ x: 0, y: 0, opacity: 0, scale: 0.4, rotate: 0 }}
          animate={{ x: thread.x, y: thread.y, opacity: [0, 1, 1, 0], scale: 1, rotate: thread.rotate }}
          transition={{
            duration: 1.9,
            ease: [0.16, 1, 0.3, 1],
            delay: 0.35 + thread.delay,
            opacity: { duration: 1.9, times: [0, 0.08, 0.7, 1], delay: 0.35 + thread.delay },
          }}
          className={`absolute block rounded-full shadow-[0_0_0_2px_rgba(255,255,255,0.85)] ${thread.long ? "h-3 w-9" : "size-3.5"}`}
          style={{ backgroundColor: thread.colour }}
        />
      ))}
    </div>
  );
}
