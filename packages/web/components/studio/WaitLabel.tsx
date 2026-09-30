"use client";

import { motion } from "framer-motion";

/**
 * An honest label for a wait, with a beat next to it so a slow step still looks
 * alive. Every wait in the studio uses this, so nothing ever sits on screen
 * without saying what it is waiting for.
 */
export function WaitLabel({ text }: { text: string }) {
  return (
    <motion.p
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      className="flex items-center gap-3 font-mono text-[12px] uppercase tracking-[0.16em] text-accent"
    >
      <span className="motif h-2 w-2 animate-pulse bg-accent" />
      {text}
    </motion.p>
  );
}
