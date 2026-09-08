"use client";

import { motion } from "framer-motion";
import type { ReactNode } from "react";
import { useIsReducedMotion } from "@/components/motion/useIsReducedMotion";

interface RevealProps {
  children: ReactNode;
  className?: string;
  /** Seconds. Stagger a group by giving each child a slightly larger delay. */
  delay?: number;
  /** How far the block travels on its way in, in pixels. */
  distance?: number;
  /** Play as soon as the page loads instead of waiting for the block to be scrolled to. */
  onLoad?: boolean;
}

const EASE = [0.16, 1, 0.3, 1] as const;

/**
 * Fade and rise, once, either on load or the first time the block is scrolled
 * into view.
 *
 * Anyone who has asked their system for less motion gets the finished state
 * immediately rather than a shorter animation, because a fast fade is still a
 * fade.
 */
export function Reveal({ children, className, delay = 0, distance = 24, onLoad = false }: RevealProps) {
  const reduced = useIsReducedMotion();

  const shown = { opacity: 1, y: 0 };
  const hidden = { opacity: 0, y: distance };

  return (
    <motion.div
      className={className}
      initial={hidden}
      {...(onLoad || reduced
        ? { animate: shown }
        : { whileInView: shown, viewport: { once: true, amount: 0.25 } })}
      transition={reduced ? { duration: 0.001 } : { duration: 0.9, delay, ease: EASE }}
    >
      {children}
    </motion.div>
  );
}
