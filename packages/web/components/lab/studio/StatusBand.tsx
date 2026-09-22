"use client";

import { AnimatePresence, motion } from "framer-motion";
import { useTranslations } from "next-intl";
import { useRef } from "react";
import { useIsReducedMotion } from "@/components/motion/useIsReducedMotion";
import { Link } from "@/lib/i18n/routing";
import type { RegisterState } from "@/lib/studio/flow";
import { usePressed, type Bench } from "./bench";
import { BENCH_PASSPORT_ID, fixtureState, stepsOf, type BenchState, type Path } from "./fixtures";
import { Elapsed, FailureLine, FormFace, ReceiptBody, StepLines } from "./parts";

/**
 * Drawing B: the form folds into a status band.
 *
 * The press folds the form away and leaves a slim band in its place, pinned to
 * the top of the panel, and the answer grows underneath it in the same column.
 * The band never leaves: while the run is out it is the run, and once the
 * passport is on chain it is one line with the way to it.
 */
export function StatusBand({ bench }: { bench: Bench }) {
  const panel = useRef<HTMLDivElement>(null);
  const reduced = useIsReducedMotion();
  const state = fixtureState(bench.path, bench.state);
  const folded = bench.state !== "idle";

  // Same rule as the other drawing: the button answers first, then the form
  // folds and the page puts the panel's top under the sticky strip, which is
  // where the band pins itself and where the run grows from.
  const { pressing, press, again } = usePressed(panel, bench);

  return (
    <div ref={panel} data-drawing="band" data-face={folded ? "folded" : "form"} className="relative">
      <AnimatePresence initial={false}>
        {folded ? (
          <motion.div
            key="band"
            initial={reduced ? { opacity: 0 } : { opacity: 0, y: -14 }}
            animate={{ opacity: 1, y: 0 }}
            transition={reduced ? { duration: 0.15 } : { duration: 0.45, ease: [0.16, 1, 0.3, 1] }}
            className="sticky top-[var(--bench-top,var(--header-h))] z-30"
          >
            <Band bench={bench} state={state} onAnother={again} />
          </motion.div>
        ) : null}
      </AnimatePresence>

      <div className="relative border border-line bg-bg-raised">
        <AnimatePresence mode="popLayout" initial={false}>
          {!folded ? (
            <motion.div
              key="form"
              initial={reduced ? { opacity: 0 } : { opacity: 0, y: 14 }}
              animate={{ opacity: 1, y: 0 }}
              exit={reduced ? { opacity: 0 } : { opacity: 0, scaleY: 0.4, filter: "blur(6px)" }}
              style={{ originY: 0 }}
              transition={reduced ? { duration: 0.15 } : { duration: 0.45, ease: [0.16, 1, 0.3, 1] }}
              className="p-6 sm:p-9"
            >
              <FormFace path={bench.path} busy={pressing} onPress={press} />
            </motion.div>
          ) : (
            <motion.div
              key="run"
              initial={reduced ? { opacity: 0 } : { opacity: 0, y: 18 }}
              animate={{ opacity: 1, y: 0 }}
              transition={reduced ? { duration: 0.15 } : { duration: 0.55, delay: 0.08, ease: [0.16, 1, 0.3, 1] }}
              className="p-6 sm:p-9"
            >
              <Under bench={bench} state={state} pressing={pressing} onPress={press} onAnother={again} />
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

/**
 * The band itself: what is being done, how long it has taken, and how far along
 * it is. Once the passport is written it keeps one line and holds the way to it.
 */
function Band({
  bench,
  state,
  onAnother,
}: {
  bench: Bench;
  state: RegisterState;
  onAnother: () => void;
}) {
  const t = useTranslations("studio");
  const done = isDone(bench.state);
  const rule = ruleWidth(bench.path, state);

  return (
    <div className="relative overflow-hidden border border-line bg-bg/90 backdrop-blur-md">
      <div className="flex h-[3.4rem] items-center gap-4 px-4 sm:h-[3.8rem] sm:px-6">
        <span
          aria-hidden
          className={`h-[9px] w-[9px] shrink-0 ${
            bench.state === "failed" ? "bg-failed" : done ? "motif" : "animate-pulse bg-accent"
          }`}
        />
        <p className="min-w-0 flex-1 truncate text-sm text-text">
          <span className="hidden text-text-faint sm:inline">{state.title}</span>
          <span className="hidden text-text-faint sm:inline"> / </span>
          {bandLine(bench.state, bench.path, state, t)}
        </p>

        {done ? (
          <Link
            href={`/passport/${BENCH_PASSPORT_ID}`}
            className="shrink-0 rounded-[8px] bg-accent px-3 py-2 font-mono text-[10px] uppercase tracking-[0.16em] text-accent-ink transition-transform duration-200 hover:-translate-y-0.5 sm:px-4"
          >
            {/* The band is one line on a phone, and the whole label would eat
                the sentence beside it. The short word is English here because
                the bench adds no message keys; a shipped band needs one. */}
            <span className="sm:hidden">Open</span>
            <span className="hidden sm:inline">{t("register.openPassport")}</span>
          </Link>
        ) : (
          <span className="shrink-0 font-mono text-[11px] text-text-faint">
            <Elapsed since={bench.since} />
          </span>
        )}

        {done ? (
          <button
            type="button"
            data-again
            onClick={onAnother}
            className="hidden shrink-0 rounded-[8px] border border-line px-4 py-2 font-mono text-[10px] uppercase tracking-[0.16em] text-text-muted transition-colors duration-200 hover:border-accent hover:text-accent sm:block"
          >
            Make another
          </button>
        ) : null}
      </div>

      <motion.span
        aria-hidden
        className={`absolute bottom-0 start-0 h-[2px] ${bench.state === "failed" ? "bg-failed" : "bg-accent"}`}
        initial={{ width: "0%" }}
        animate={{ width: `${rule}%` }}
        transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
      />
    </div>
  );
}

/** What grows under the band: the run while it is out, the receipt once it lands. */
function Under({
  bench,
  state,
  pressing,
  onPress,
  onAnother,
}: {
  bench: Bench;
  state: RegisterState;
  pressing: boolean;
  onPress: () => void;
  onAnother: () => void;
}) {
  const t = useTranslations("studio");

  if (isDone(bench.state)) {
    return (
      <>
        <ReceiptBody path={bench.path} state={state} />
        <button
          type="button"
          data-again
          onClick={onAnother}
          className="mt-8 rounded-[8px] border border-line px-5 py-3.5 text-xs uppercase tracking-[0.16em] text-text-muted transition-colors duration-200 hover:border-accent hover:text-accent sm:hidden"
        >
          Make another
        </button>
      </>
    );
  }

  return (
    <div className="min-h-[17rem]">
      <StepLines path={bench.path} state={state} since={bench.since} />
      <FailureLine state={state} benchState={bench.state} />
      {bench.state === "failed" ? (
        <button
          type="button"
          disabled={pressing}
          onClick={onPress}
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
  );
}

function isDone(state: BenchState): boolean {
  return state === "donePublic" || state === "doneSealed" || state === "statementFailed";
}

/** The one sentence the band carries, taken from the same labels the rows use. */
function bandLine(
  benchState: BenchState,
  path: Path,
  state: RegisterState,
  t: (key: string, values?: Record<string, string>) => string,
): string {
  const namespace = path === "generate" ? "generate.steps" : "register.steps";
  if (isDone(benchState)) {
    return t(`${namespace}.send.done`);
  }
  if (benchState === "unconfirmed") {
    return t(`${namespace}.send.pending`);
  }
  if (benchState === "failed") {
    return t(`${namespace}.${path === "generate" ? "draw" : "prepare"}.failed`);
  }
  const running = stepsOf(path).find((step) => state.steps[step] === "running");
  if (running === undefined) {
    return t(`${namespace}.send.done`);
  }
  if (running === "send" && state.confirming) {
    return t(`${namespace}.send.watching`);
  }
  return t(`${namespace}.${running}.running`, { model: state.generated?.model ?? "" });
}

/** How far the thin rule has travelled: one part per step, and the running one half filled. */
function ruleWidth(path: Path, state: RegisterState): number {
  const steps = stepsOf(path);
  const each = 100 / steps.length;
  let width = 0;
  for (const step of steps) {
    const status = state.steps[step];
    if (status === "done") {
      width += each;
    } else if (status === "running" || status === "unconfirmed") {
      width += each * 0.5;
    }
  }
  return Math.round(width);
}
