"use client";

import { motion } from "framer-motion";
import { useTranslations } from "next-intl";
import type { Mode } from "@/lib/studio/flow";

/**
 * The fork at the top of the studio: bring a picture, or have the agent make
 * one. Both end at the same registry write, so they sit side by side rather
 * than one hiding behind a menu.
 */
export function PathChoice({
  mode,
  busy,
  onMode,
}: {
  mode: Mode;
  /** A run that is under way owns the screen: switching sides mid flight would throw it away. */
  busy: boolean;
  onMode: (mode: Mode) => void;
}) {
  const t = useTranslations("studio.choice");
  const modes: Mode[] = ["upload", "generate"];

  return (
    <motion.div
      initial={{ opacity: 0, y: 18 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
    >
      <p className="flex items-center gap-3 font-mono text-[10px] uppercase tracking-[0.28em] text-text-faint">
        <span className="h-px w-6 bg-line-strong" />
        {t("kicker")}
      </p>

      <div className="mt-4 grid gap-px border border-line bg-line sm:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
        {modes.map((entry) => {
          const active = mode === entry;
          return (
            <button
              key={entry}
              type="button"
              disabled={busy}
              aria-pressed={active}
              onClick={() => onMode(entry)}
              className={`group relative overflow-hidden px-6 py-5 text-start transition-colors duration-200 disabled:cursor-not-allowed disabled:opacity-60 sm:px-8 sm:py-6 ${
                active ? "bg-bg-raised" : "bg-bg hover:bg-bg-raised"
              }`}
            >
              {active ? (
                <motion.span
                  layoutId="studio-path-edge"
                  transition={{ type: "spring", stiffness: 340, damping: 30 }}
                  className="absolute inset-x-0 top-0 h-[2px] bg-accent"
                />
              ) : null}

              <span className="flex items-center gap-3">
                <span
                  aria-hidden
                  className={`h-[9px] w-[9px] transition-colors duration-200 ${
                    active ? "motif" : "border border-text-faint group-hover:border-accent"
                  }`}
                />
                <span
                  className={`font-display text-[clamp(1.05rem,1.9vw,1.4rem)] uppercase tracking-[-0.01em] transition-colors duration-200 ${
                    active ? "text-text" : "text-text-muted group-hover:text-text"
                  }`}
                >
                  {t(`${entry}.label`)}
                </span>
              </span>
              <span className="mt-2 block max-w-[34ch] text-xs leading-relaxed text-text-faint">
                {t(`${entry}.note`)}
              </span>
            </button>
          );
        })}
      </div>
    </motion.div>
  );
}
