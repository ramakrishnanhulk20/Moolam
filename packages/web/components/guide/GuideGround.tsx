"use client";

import { AnimatePresence, motion } from "framer-motion";
import { useCallback, useEffect, useRef, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { useIsReducedMotion } from "@/components/motion/useIsReducedMotion";
import { lockPage, tabTarget } from "./focus";

export type GuideStage = "window" | "frame";
export type GuideClose = "skip" | "ground" | "escape" | "done" | "go";

/**
 * The ground both drawings of the guide are laid on: the dim over the page, the
 * ways out, and the rules that make it safe to interrupt somebody.
 *
 * While it is open the page under it does not scroll and does not move, Escape
 * closes it, and a keyboard cannot walk out of it into the page it is covering.
 * The stage decides where it lives: "window" is the real thing, fixed over
 * everything, and "frame" is the bench, where it sits inside a mock window so
 * the page around it can still be read.
 */
export function GuideGround({
  open,
  onClose,
  label,
  stage = "window",
  ground = "blur",
  closeOnGround = true,
  children,
}: {
  open: boolean;
  onClose: (reason: GuideClose) => void;
  label: string;
  stage?: GuideStage;
  /** "blur" dims and softens the page. "clear" leaves it sharp, for the walk's spotlight. */
  ground?: "blur" | "clear";
  closeOnGround?: boolean;
  children: ReactNode;
}) {
  const reduced = useIsReducedMotion();
  const panel = useRef<HTMLDivElement>(null);

  const onKey = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose("escape");
        return;
      }
      if (event.key !== "Tab" || panel.current === null) {
        return;
      }
      const target = tabTarget(panel.current, document.activeElement, event.shiftKey);
      if (target !== null) {
        event.preventDefault();
        target.focus();
      }
    },
    [onClose],
  );

  return (
    // The guide carries the dark palette whatever the page under it is set to,
    // for the same reason the film does: it is laid on a scrim, and the light
    // theme's ink on that scrim is black on black. The one class swaps every
    // colour token for everything inside it.
    <AnimatePresence>
      {open ? (
        <div
          className={`dark ${stage === "window" ? "fixed z-[70]" : "absolute z-30"} inset-0`}
          onKeyDown={onKey}
          data-guide-open
        >
          <Hold panel={panel} stage={stage} />
          <motion.div
            aria-hidden
            onClick={closeOnGround ? () => onClose("ground") : undefined}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: reduced ? 0.15 : 0.45, ease: [0.16, 1, 0.3, 1] }}
            className={
              ground === "blur"
                ? "absolute inset-0 bg-[radial-gradient(120%_90%_at_18%_88%,rgb(0_0_0/0.48),rgb(0_0_0/0.8))] backdrop-blur-[5px]"
                : "absolute inset-0"
            }
          />

          {/* The panel takes no clicks of its own, so a press on the ground
              around the cards still reaches the ground. Each piece inside asks
              for its own. */}
          <div
            ref={panel}
            role="dialog"
            aria-modal="true"
            aria-label={label}
            tabIndex={-1}
            className="pointer-events-none absolute inset-0 outline-none"
          >
            {children}
          </div>
        </div>
      ) : null}
    </AnimatePresence>
  );
}

/**
 * Takes the page and the keyboard while the guide is up, and gives both back
 * once it has finished leaving.
 *
 * It is a child of the branch AnimatePresence holds open on purpose. Released
 * the moment the guide is asked to close, the scrollbar would come back while
 * the cards were still fading, and a fixed overlay measured against a window
 * that just narrowed moves every card in it by five pixels: a shift of 0.00215
 * where there should be none. Unmounting after the exit costs nothing and
 * measures zero.
 */
function Hold({ panel, stage }: { panel: RefObject<HTMLDivElement | null>; stage: GuideStage }) {
  useEffect(() => {
    const cameFrom = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panel.current?.focus({ preventScroll: true });
    const release = stage === "window" ? lockPage() : null;

    return () => {
      release?.();
      cameFrom?.focus({ preventScroll: true });
    };
  }, [panel, stage]);

  return null;
}
