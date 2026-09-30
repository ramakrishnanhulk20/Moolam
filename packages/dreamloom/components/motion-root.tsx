"use client";

import { MotionConfig } from "framer-motion";
import type { ReactNode } from "react";

/** With "user", a visitor who asked for less motion gets fades only: no rises, tilts or springs. */
export function MotionRoot({ children }: { children: ReactNode }) {
  return <MotionConfig reducedMotion="user">{children}</MotionConfig>;
}
