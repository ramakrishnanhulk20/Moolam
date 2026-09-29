"use client";

import { MotionConfig } from "framer-motion";
import type { ReactNode } from "react";

/**
 * Every Framer animation inside follows the reader's reduced motion setting.
 *
 * The stylesheet's reduced motion rule only reaches CSS animation. The answers,
 * step labels and failure lines on a passport slide in through Framer, so
 * without this a reader who asked for less motion still watched them move.
 * It draws no markup of its own, so the page's layout is untouched.
 */
export function MotionScope({ children }: { children: ReactNode }) {
  return <MotionConfig reducedMotion="user">{children}</MotionConfig>;
}
