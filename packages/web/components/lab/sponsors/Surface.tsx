"use client";

import { motion } from "framer-motion";
import { useState, type ReactNode } from "react";

type Ground = "dark" | "light";

/**
 * The ground the whole bench is drawn on.
 *
 * The site's own palette lives on the dark and light classes, so putting one of
 * them on this wrapper paints every panel inside it in that theme whichever way
 * the site's own toggle happens to be set while Ram is looking. The switch is
 * sticky, so the ground can be changed from anywhere down the page.
 */
export function Surface({ children }: { children: ReactNode }) {
  const [ground, setGround] = useState<Ground>("dark");

  return (
    <div className={`${ground} min-h-screen bg-bg text-text`}>
      <div className="pointer-events-none sticky top-0 z-50 flex justify-end px-5 pt-5 sm:px-8 lg:px-14">
        <div className="pointer-events-auto flex items-center gap-1 rounded-[8px] border border-line bg-bg/80 p-1 backdrop-blur-md">
          {(["dark", "light"] as const).map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => setGround(option)}
              className={`relative rounded-[6px] px-4 py-2 font-mono text-[10px] uppercase tracking-[0.2em] transition-colors duration-200 ${
                ground === option ? "text-bg" : "text-text-faint hover:text-accent"
              }`}
            >
              {ground === option ? (
                <motion.span
                  layoutId="sponsor-bench-ground"
                  className="absolute inset-0 rounded-[6px] bg-accent"
                  transition={{ type: "spring", stiffness: 420, damping: 34 }}
                />
              ) : null}
              <span className="relative">{option === "dark" ? "Dark ground" : "Light ground"}</span>
            </button>
          ))}
        </div>
      </div>

      {children}
    </div>
  );
}
