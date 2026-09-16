"use client";

import { motion } from "framer-motion";
import type { ReactNode } from "react";
import { useIsReducedMotion } from "@/components/motion/useIsReducedMotion";

/**
 * Everything on the bench arrives rather than appearing: it rises a little and
 * fades in the first time it is scrolled to, once only.
 *
 * A visitor who has asked their system for less motion gets the same page with
 * the movement taken out, not a page with nothing on it.
 */
export function Reveal({
  children,
  delay = 0,
  className = "",
}: {
  children: ReactNode;
  delay?: number;
  className?: string;
}) {
  const reduced = useIsReducedMotion();

  return (
    <motion.div
      className={className}
      initial={reduced ? { opacity: 0 } : { opacity: 0, y: 28 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, amount: 0.15 }}
      transition={reduced ? { duration: 0.2 } : { duration: 0.75, delay, ease: [0.16, 1, 0.3, 1] }}
    >
      {children}
    </motion.div>
  );
}
