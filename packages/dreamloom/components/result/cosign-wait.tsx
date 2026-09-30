"use client";

import { motion } from "framer-motion";
import { LiveDot, OutArrow, QUIET_BUTTON, useSecondsSince } from "./bits";

/**
 * While the visitor signs on Moolam. The page reads the picture again every few seconds and at once
 * when Moolam's page says the passport landed, so it moves on by itself. Moolam's window stays one
 * press away: the press focuses it when it is open and opens it again when it is not.
 */
export function CosignWait({
  signed,
  canReopen,
  checkedAt,
  title,
  onReopen,
}: {
  signed: boolean;
  canReopen: boolean;
  checkedAt: number | null;
  title: string | undefined;
  onReopen: () => void;
}) {
  const sinceCheck = useSecondsSince(checkedAt);

  return (
    <motion.div
      initial={{ opacity: 0, y: 24 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
      className="rounded-[2rem] bg-card/95 p-5 shadow-[0_30px_70px_-40px_rgba(23,18,43,0.45)] ring-1 ring-ink/5 sm:p-8"
    >
      <div role="status" aria-live="polite">
        <p className="flex items-start gap-3 font-display text-2xl leading-tight font-extrabold tracking-[-0.02em] text-ink sm:text-3xl">
          <span className="mt-[0.45em] inline-flex sm:mt-[0.4em]">
            <LiveDot />
          </span>
          Waiting for you to sign on Moolam
        </p>
        <p className="mt-3 max-w-[36rem] text-base text-ink-soft">
          {signed
            ? "Dreamloom has signed its part, as the tool that drew it. Now sign with your passkey on Moolam's page, and the passport is written on Monad."
            : "On Moolam's page, sign in, check the picture and its terms, then sign with your passkey. Moolam pays the network fee."}
        </p>
      </div>

      {canReopen && (
        <button type="button" onClick={onReopen} className={`group ${QUIET_BUTTON} mt-6 w-full sm:w-auto`}>
          Reopen the Moolam window
          <OutArrow />
        </button>
      )}

      <ol className="mt-7 grid gap-2 text-sm sm:grid-cols-3">
        <WaitStep done label="Prepared on Moolam" />
        <WaitStep done={signed} label="Signed by Dreamloom" />
        <WaitStep done={false} label="Signed by you, then written on Monad" />
      </ol>

      <p className="mt-6 flex flex-wrap gap-x-4 gap-y-1 text-sm text-ink-soft">
        {title !== undefined && (
          <span className="min-w-0 break-words">
            Title: <span className="font-semibold text-ink">{title}</span>
          </span>
        )}
        <span className="tabular-nums">
          This page checks every few seconds{checkedAt !== null ? `, last ${sinceCheck} s ago` : ""}.
        </span>
      </p>
    </motion.div>
  );
}

function WaitStep({ done, label }: { done: boolean; label: string }) {
  return (
    <li
      className={`flex items-center gap-2 rounded-xl px-3 py-2.5 font-semibold ${done ? "bg-mist text-violet-deep" : "bg-ink/[0.04] text-ink-soft"}`}
    >
      <span
        aria-hidden
        className={`inline-flex size-5 shrink-0 items-center justify-center rounded-full text-[0.7rem] ${done ? "bg-violet text-white" : "border-2 border-ink/20"}`}
      >
        {done ? "✓" : ""}
      </span>
      {label}
      <span className="sr-only">{done ? ", done" : ", not yet"}</span>
    </li>
  );
}
