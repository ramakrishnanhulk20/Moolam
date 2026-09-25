"use client";

import { motion } from "framer-motion";
import { useTranslations } from "next-intl";
import type { Mode } from "@/lib/studio/flow";
import { WIDE_SWITCH_SEAT, useWide, wideOnly } from "./layout";

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
  // Under the wide layout the fork is one slim row on a laptop, label and note
  // side by side, so the first screen goes to the picture and the form.
  const wide = useWide();

  const choice = (
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
              }${wideOnly(wide, "lg:flex lg:items-baseline lg:gap-x-6 lg:py-4")}`}
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
              <span className={`mt-2 block max-w-[34ch] text-xs leading-relaxed text-text-faint${wideOnly(wide, "lg:mt-0 lg:truncate")}`}>
                {t(`${entry}.note`)}
              </span>
            </button>
          );
        })}
      </div>
    </motion.div>
  );

  if (!wide) {
    return choice;
  }

  // Both are drawn from the first render and the width picks one, so nothing
  // moves in after load: the full fork on a phone, and on a laptop a compact
  // switch seated on the opening's row, beside the page's name.
  return (
    <>
      <div className="lg:hidden">{choice}</div>
      <Segmented mode={mode} busy={busy} onMode={onMode} />
    </>
  );
}

/** The same fork, same words, a size down: two segments side by side on the opening's row. */
function Segmented({ mode, busy, onMode }: { mode: Mode; busy: boolean; onMode: (mode: Mode) => void }) {
  const t = useTranslations("studio.choice");
  const modes: Mode[] = ["upload", "generate"];

  return (
    <motion.div
      data-path-compact
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
      className={`hidden lg:block ${WIDE_SWITCH_SEAT}`}
    >
      <p className="flex items-center gap-3 font-mono text-[10px] uppercase tracking-[0.28em] text-text-faint">
        <span className="h-px w-6 bg-line-strong" />
        {t("kicker")}
      </p>
      <div className="mt-3 grid grid-cols-2 gap-px overflow-hidden rounded-[8px] border border-line bg-line">
        {modes.map((entry) => {
          const active = mode === entry;
          return (
            <button
              key={entry}
              type="button"
              disabled={busy}
              aria-pressed={active}
              onClick={() => onMode(entry)}
              className={`group relative min-w-0 px-4 py-2.5 text-start transition-colors duration-200 disabled:cursor-not-allowed disabled:opacity-60 ${
                active ? "bg-bg-raised" : "bg-bg hover:bg-bg-raised"
              }`}
            >
              {active ? (
                <motion.span
                  layoutId="studio-path-edge-compact"
                  transition={{ type: "spring", stiffness: 340, damping: 30 }}
                  className="absolute inset-x-0 top-0 h-[2px] bg-accent"
                />
              ) : null}
              <span className="flex items-center gap-2.5">
                <span
                  aria-hidden
                  className={`h-[7px] w-[7px] shrink-0 transition-colors duration-200 ${
                    active ? "motif" : "border border-text-faint group-hover:border-accent"
                  }`}
                />
                <span
                  className={`truncate font-display text-[0.9rem] uppercase tracking-[-0.01em] transition-colors duration-200 ${
                    active ? "text-text" : "text-text-muted group-hover:text-text"
                  }`}
                >
                  {t(`${entry}.label`)}
                </span>
              </span>
              <span className="mt-1 block text-[11px] leading-snug text-text-faint">{t(`${entry}.note`)}</span>
            </button>
          );
        })}
      </div>
    </motion.div>
  );
}
