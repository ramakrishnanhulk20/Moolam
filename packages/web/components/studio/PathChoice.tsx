"use client";

import { motion } from "framer-motion";
import { useLocale, useTranslations } from "next-intl";
import { useId, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { useIsReducedMotion } from "@/components/motion/useIsReducedMotion";
import type { Mode } from "@/lib/studio/flow";
import { useWide } from "./layout";
import { useRadioGroup } from "./useRadioGroup";

const PATHS: readonly Mode[] = ["upload", "generate"];
const EASE = [0.16, 1, 0.3, 1] as const;

/**
 * The fork at the top of the studio: bring a picture, or have the agent make
 * one. Both end at the same registry write, so they sit side by side rather
 * than one hiding behind a menu.
 */
export function PathChoice({
  mode,
  busy,
  running = false,
  onMode,
}: {
  mode: Mode;
  /** A run that is under way owns the screen: switching sides mid flight would throw it away. */
  busy: boolean;
  /** The form has folded into the run: the phone's fork steps aside, the laptop's switch stays, quiet. */
  running?: boolean;
  onMode: (mode: Mode) => void;
}) {
  const wide = useWide();
  const slot = useSwitchSlot(wide);

  const choice = (
    <motion.div
      initial={{ opacity: 0, y: 18 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.6, ease: EASE }}
    >
      <PathSwitch mode={mode} busy={busy} onMode={onMode} seat="column" />
    </motion.div>
  );

  if (!wide) {
    return choice;
  }

  // With no opening to sit in, the full fork is drawn at every width.
  if (slot === null) {
    return running ? null : choice;
  }

  // The width picks one: the full fork on a phone, and on a laptop the compact
  // switch in the place the opening leaves beside the page's name. The slot is
  // read in the first render, so neither is ever seen moving in.
  return (
    <>
      {running ? null : <div className="lg:hidden">{choice}</div>}
      {createPortal(<CompactSwitch mode={mode} busy={busy} onMode={onMode} />, slot)}
    </>
  );
}

/**
 * The empty place the studio's opening keeps beside its title for the switch.
 * It is only shown on a laptop once the sign-in card has gone, so the switch
 * drawn into it needs no breakpoint of its own.
 *
 * The opening is drawn on the server before this screen exists and never moves,
 * so there is nothing to subscribe to: the store is read, not watched. A server
 * render has no document and gets the full fork.
 */
function useSwitchSlot(wide: boolean): HTMLElement | null {
  return useSyncExternalStore(
    unwatched,
    () => (wide ? document.querySelector<HTMLElement>("[data-studio-switch-slot]") : null),
    () => null,
  );
}

function unwatched(): () => void {
  return () => undefined;
}

/**
 * The same switch in the opening's right-hand place on a laptop, a size down:
 * each name on one line at 1280 and up, so the switch ends level with the
 * title block and Register keeps its place in the first screen at 900 px.
 */
export function CompactSwitch({ mode, busy, onMode }: { mode: Mode; busy: boolean; onMode: (mode: Mode) => void }) {
  return (
    <motion.div
      data-path-compact
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, ease: EASE }}
    >
      <PathSwitch mode={mode} busy={busy} onMode={onMode} seat="slot" />
    </motion.div>
  );
}

/** Sizes for the two seats: the studio's own column, and the opening's slot beside the title. */
const SEAT = {
  column: {
    frame: "mt-4 auto-rows-fr sm:grid-cols-2",
    half: "min-h-[3.75rem] px-4 py-3 sm:min-h-[5rem] sm:px-6",
    name: "text-[1.05rem] sm:text-[clamp(0.95rem,1.8vw,1.55rem)]",
    note: "mt-4",
  },
  slot: {
    frame: "mt-3 grid-cols-2",
    half: "min-h-[4rem] px-5 py-2.5",
    name: "text-[clamp(0.95rem,1.3vw,1.2rem)]",
    note: "mt-2.5",
  },
} as const;

/**
 * The switch Ram picked from the lab (02B): one wide frame in two halves, the
 * path names in the display face, and a pink block that slides to the chosen
 * half so the eye follows the choice across rather than seeing one side switch
 * off and the other on.
 *
 * The block is drawn inside the chosen half and framer's shared layout moves
 * it, so it lands flush on either half whether the halves sit side by side or,
 * on a phone, one above the other, and whatever height a long name gives them.
 * A phone stacks them because side by side a path name would need three lines.
 *
 * Both sentences are laid in one grid cell and only the chosen one shows, so
 * the cell is always as tall as the longer one and the form under it never
 * jumps when the choice changes. Each half is described by its sentence, so a
 * screen reader hears it with the name.
 *
 * The frame clips its corners, so a half draws its focus ring inside its own
 * edge, marked important because the site's one focus rule sits outside
 * Tailwind's layers. On the pink block the ring takes the ink colour, since a
 * pink ring on pink is no ring at all.
 */
export function PathSwitch({
  mode,
  busy,
  onMode,
  seat,
}: {
  mode: Mode;
  busy: boolean;
  onMode: (mode: Mode) => void;
  seat: keyof typeof SEAT;
}) {
  const t = useTranslations("studio.choice");
  const reduced = useIsReducedMotion();
  // Tamil letters carry marks above and below the line, which the display
  // face's tight Latin leading would clip.
  const leading = useLocale() === "ta" ? "leading-[1.2]" : "leading-[0.95]";
  const id = useId();
  const { group, item } = useRadioGroup(PATHS, mode, onMode, busy);
  const size = SEAT[seat];

  return (
    <div data-path-switch={seat}>
      <p id={`${id}-name`} className="flex items-center gap-3 font-mono text-[10px] uppercase tracking-[0.28em] text-text-faint">
        <span className="h-px w-6 bg-line-strong" />
        {t("kicker")}
      </p>

      <div
        {...group}
        aria-labelledby={`${id}-name`}
        className={`relative grid overflow-hidden rounded-[8px] border border-line-strong bg-bg-sunken p-1.5 transition-opacity duration-200 ${size.frame}${
          busy ? " opacity-60" : ""
        }`}
      >
        {PATHS.map((path, at) => {
          const chosen = path === mode;
          return (
            <button
              key={path}
              type="button"
              disabled={busy}
              aria-describedby={`${id}-${path}`}
              {...item(path)}
              className={`group relative flex min-w-0 flex-col justify-center rounded-[6px] text-start transition-colors duration-200 focus-visible:-outline-offset-4! disabled:cursor-not-allowed ${size.half} ${
                chosen ? "text-accent-ink focus-visible:outline-accent-ink!" : "text-text-muted enabled:hover:bg-accent-soft enabled:hover:text-text"
              }`}
            >
              {chosen ? (
                <motion.span
                  aria-hidden
                  data-switch-block
                  layoutId={`studio-path-block-${seat}`}
                  transition={reduced ? { duration: 0 } : { type: "spring", stiffness: 420, damping: 36 }}
                  style={{ borderRadius: 6 }}
                  className="absolute inset-0 bg-accent shadow-[inset_0_1px_0_rgb(255_255_255/0.25),0_10px_24px_-12px_var(--accent)] transition-[filter] duration-200 group-enabled:group-hover:brightness-110"
                />
              ) : null}
              <span
                className={`relative font-mono text-[10px] tabular-nums tracking-[0.2em] transition-colors duration-200 ${
                  chosen ? "text-accent-ink/70" : "text-text-faint group-enabled:group-hover:text-accent"
                }`}
              >
                0{at + 1}
              </span>
              <span className={`relative mt-1 font-display font-semibold uppercase tracking-[-0.02em] ${size.name} ${leading}`}>
                {t(`${path}.label`)}
              </span>
            </button>
          );
        })}
      </div>

      <div className={`grid ${size.note}`}>
        {PATHS.map((path) => {
          const chosen = path === mode;
          return (
            <motion.p
              key={path}
              id={`${id}-${path}`}
              data-switch-note={path}
              aria-hidden={!chosen}
              initial={false}
              animate={chosen ? { opacity: 1, y: 0 } : { opacity: 0, y: -8 }}
              transition={
                reduced ? { duration: 0 } : chosen ? { duration: 0.35, delay: 0.12, ease: EASE } : { duration: 0.2, ease: EASE }
              }
              className={`flex items-start gap-3 text-base leading-relaxed text-text [grid-area:1/1]${chosen ? "" : " pointer-events-none"}${
                path === "generate" ? " sm:justify-end sm:text-end" : ""
              }`}
            >
              <span aria-hidden className="motif mt-[0.55em] h-[7px] w-[7px] shrink-0" />
              <span className="max-w-[60ch]">{t(`${path}.note`)}</span>
            </motion.p>
          );
        })}
      </div>
    </div>
  );
}
