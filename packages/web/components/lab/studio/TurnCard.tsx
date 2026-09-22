"use client";

import { AnimatePresence, motion } from "framer-motion";
import { useTranslations } from "next-intl";
import { useRef } from "react";
import { useIsReducedMotion } from "@/components/motion/useIsReducedMotion";
import { usePressed, type Bench } from "./bench";
import { fixtureState, type BenchState } from "./fixtures";
import { FailureLine, FormFace, ReceiptBody, ReceiptButtons, StepLines } from "./parts";

/**
 * Drawing A: the card turns over.
 *
 * One card holds the whole studio. The form is its front; the run and the
 * receipt are the same card, turned. Nothing outside it moves and nothing under
 * it is where the answer goes, so the creator's eye never has to leave the
 * thing they pressed.
 */
export function TurnCard({ bench }: { bench: Bench }) {
  const t = useTranslations("studio");
  const card = useRef<HTMLDivElement>(null);
  const reduced = useIsReducedMotion();
  const state = fixtureState(bench.path, bench.state);
  const face = faceOf(bench.state);

  // The press is answered on the button first, then the card turns and the page
  // puts the card's top under the sticky strip, so the run is read without a
  // scroll whatever the window.
  const { pressing, press, again } = usePressed(card, bench);

  const turn = reduced
    ? { initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 } }
    : {
        initial: { opacity: 0, rotateY: 22, x: 26 },
        animate: { opacity: 1, rotateY: 0, x: 0 },
        exit: { opacity: 0, rotateY: -22, x: -26 },
      };

  return (
    <div
      ref={card}
      data-drawing="turn"
      data-face={face}
      className="grain relative overflow-hidden border border-line bg-bg-raised [perspective:1400px]"
    >
      <span
        aria-hidden
        className="pointer-events-none absolute -top-[30%] end-[-10%] h-[60%] w-[55%] rounded-full bg-accent-soft blur-[90px]"
      />

      <div className="relative p-6 sm:p-9">
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.div
            key={face}
            initial={turn.initial}
            animate={turn.animate}
            exit={turn.exit}
            transition={reduced ? { duration: 0.15 } : { duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
            className="origin-center [transform-style:preserve-3d]"
          >
            {face === "form" ? (
              <FormFace path={bench.path} busy={pressing} onPress={press} />
            ) : face === "run" ? (
              <div className="min-h-[19rem]">
                <p className="flex items-center gap-3 font-mono text-[11px] uppercase tracking-[0.24em] text-accent">
                  <span className="motif h-[9px] w-[9px]" />
                  {t("receipt.heading")}
                </p>
                {/* The name is a label here, not a headline: the rows under it
                    are what the creator is waiting on, and a display-size title
                    pushed the first of them off a phone screen. */}
                <h3 className="mt-3 truncate font-display text-lg font-semibold uppercase leading-[1.15] tracking-[-0.02em] sm:text-xl">
                  {state.title}
                </h3>

                <div className="mt-5 border-t border-line pt-3">
                  <StepLines path={bench.path} state={state} since={bench.since} />
                </div>

                <FailureLine state={state} benchState={bench.state} />

                {bench.state === "failed" ? (
                  <button
                    type="button"
                    disabled={pressing}
                    onClick={press}
                    className="mt-6 rounded-[8px] border border-line px-5 py-3 text-xs uppercase tracking-[0.16em] text-text-muted transition-colors duration-200 hover:border-accent hover:text-accent"
                  >
                    {t("actions.again")}
                  </button>
                ) : bench.state === "unconfirmed" ? (
                  <button
                    type="button"
                    className="mt-6 rounded-[8px] border border-line px-5 py-3 text-xs uppercase tracking-[0.16em] text-text-muted transition-colors duration-200 hover:border-accent hover:text-accent"
                  >
                    {t("consent.receipt.recheck")}
                  </button>
                ) : null}
              </div>
            ) : (
              <div className="min-h-[19rem]">
                <ReceiptBody path={bench.path} state={state} />
                <ReceiptButtons onAnother={again} />
              </div>
            )}
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}

/** Which of the card's three faces a state belongs to. */
function faceOf(state: BenchState): "form" | "run" | "receipt" {
  if (state === "idle") {
    return "form";
  }
  return state === "donePublic" || state === "doneSealed" || state === "statementFailed" ? "receipt" : "run";
}
