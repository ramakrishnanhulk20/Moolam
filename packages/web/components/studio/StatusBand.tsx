"use client";

import { motion } from "framer-motion";
import { useTranslations } from "next-intl";
import {
  GENERATE_STEPS,
  STEPS,
  isRegistered,
  type RegisterState,
  type Step,
} from "@/lib/studio/flow";

/**
 * The one line the form folds into, pinned to the top of the box.
 *
 * It answers the question a creator has while a run is out and their eye is
 * somewhere else on the screen: what is this, and where has it got to. The
 * picture's name and what it was made from are on the left, whether it is being
 * published in the middle, and the studio's own word for the step it is on at
 * the end. It is the same line the row under it reads, so the band never says
 * anything the run does not.
 */
export function StatusBand({ state }: { state: RegisterState }) {
  const t = useTranslations("studio");
  const steps = useTranslations(state.mode === "generate" ? "studio.generate.steps" : "studio.register.steps");
  const agent = useTranslations("studio.generate");

  const failed = failedStep(state) !== null;
  const done = isRegistered(state);
  const sealed = state.prepared?.sealed ?? state.sealed.on;
  const title = state.title.trim();
  const model = state.generated?.model ?? "";

  const made =
    state.mode === "generate"
      ? model === ""
        ? ""
        : agent("model", { model })
      : state.file === null
        ? ""
        : `${state.file.name} ${megabytes(state.file)}`;

  return (
    <div
      data-studio-band
      data-tone={failed ? "failed" : done ? "done" : "running"}
      className="relative overflow-hidden border border-line bg-bg/90 backdrop-blur-md"
    >
      <div className="flex h-[3.4rem] items-center gap-3 px-4 sm:h-[3.8rem] sm:gap-4 sm:px-6">
        <span
          aria-hidden
          className={`h-[9px] w-[9px] shrink-0 ${
            failed ? "bg-failed" : done ? "motif" : "animate-pulse bg-accent"
          }`}
        />

        <p className="hidden min-w-0 flex-1 items-baseline gap-3 sm:flex">
          <span className="truncate text-sm text-text">{title === "" ? t("sealed.plate.untitled") : title}</span>
          {made === "" ? null : (
            <span className="hidden shrink-0 truncate font-mono text-[11px] text-text-faint md:inline">{made}</span>
          )}
        </p>

        <span className="hidden shrink-0 border border-line px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.16em] text-text-muted sm:inline">
          {t(sealed ? "sealed.plate.sealed" : "sealed.plate.public")}
        </span>

        <span
          className={`min-w-0 flex-1 truncate text-sm sm:flex-none sm:text-end ${
            failed ? "text-failed" : done ? "text-verified" : "text-text"
          }`}
        >
          {word(state, steps, model)}
        </span>
      </div>

      <motion.span
        aria-hidden
        className={`absolute bottom-0 start-0 h-[2px] ${failed ? "bg-failed" : "bg-accent"}`}
        initial={{ width: "0%" }}
        animate={{ width: `${ruleWidth(state)}%` }}
        transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
      />
    </div>
  );
}

type Say = (key: string, values?: Record<string, string>) => string;

function stepsOf(state: RegisterState): readonly Step[] {
  return state.mode === "generate" ? GENERATE_STEPS : STEPS;
}

function failedStep(state: RegisterState): Step | null {
  return stepsOf(state).find((step) => state.steps[step] === "failed") ?? null;
}

/** The studio's own sentence for where this run is, taken from the rows' own labels. */
function word(state: RegisterState, steps: Say, model: string): string {
  const running = stepsOf(state).find((step) => state.steps[step] === "running");
  if (running !== undefined) {
    return running === "send" && state.confirming
      ? steps("send.watching")
      : steps(`${running}.running`, { model });
  }

  if (stepsOf(state).some((step) => state.steps[step] === "unconfirmed")) {
    return steps("send.pending");
  }

  const failed = failedStep(state);
  if (failed !== null) {
    return steps(`${failed}.failed`, { model });
  }

  if (isRegistered(state)) {
    return steps("send.done");
  }

  return steps(`${stepsOf(state)[0]}.waiting`, { model });
}

/** How far the thin rule has travelled: one part per step, and the running one half filled. */
function ruleWidth(state: RegisterState): number {
  const steps = stepsOf(state);
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

function megabytes(file: File): string {
  return `${(file.size / 1_000_000).toFixed(1)} MB`;
}
