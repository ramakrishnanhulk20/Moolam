"use client";

import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useTranslations } from "next-intl";
import { formatEther, type Hex } from "viem";
import { MONAD_EXPLORER, shortHex } from "@/lib/chain/client";
import { useRouter } from "@/lib/i18n/routing";
import { REASON_MAX, REASON_MIN } from "@/lib/disputes/evidence";
import {
  FLAG_STEPS,
  isFlagBusy,
  isFlagDone,
  isFlagUnconfirmed,
  type FlagFailure,
  type FlagStep,
  type StepState,
} from "@/lib/disputes/flag";
import { useFlagPassport, type FlagPassport } from "@/lib/disputes/useFlagPassport";
import { refreshPassport } from "@/lib/passport/refresh";
import { WarningMark } from "@/components/WarningMark";

/**
 * The challenge panel itself, in a file of its own so that nothing on a passport page reaches the
 * wallet SDK until this component is asked for. DisputePanel.tsx holds the gate and pulls this in.
 */
export function Challenge({
  passportId,
  owner,
  disputeOpen,
}: {
  passportId: Hex;
  owner: Hex | null;
  disputeOpen: boolean;
}) {
  const router = useRouter();
  // The page around this panel is held for a minute, so what is held about this
  // passport is dropped before it is asked to read itself again. Otherwise the
  // challenger would be shown the record exactly as it was before their flag.
  const flag = useFlagPassport({
    passportId,
    owner,
    onLanded: async () => {
      await refreshPassport(passportId);
      router.refresh();
    },
  });

  if (disputeOpen || !flag.ready || !flag.authenticated || flag.isOwner) {
    return null;
  }

  return <Panel flag={flag} />;
}

function Panel({ flag }: { flag: FlagPassport }) {
  const t = useTranslations("passport.dispute.flag");
  const calm = useReducedMotion() === true;
  const { state } = flag;

  return (
    <section data-dispute-panel className="mt-12 border-t border-line pt-6">
      <button
        type="button"
        onClick={state.open ? flag.actions.close : flag.actions.open}
        aria-expanded={state.open}
        className="group flex items-center gap-3 font-mono text-[11px] uppercase tracking-[0.24em] text-text-faint transition-colors duration-200 hover:text-failed"
      >
        <span
          aria-hidden
          className={`h-[9px] w-[9px] border border-current transition-transform duration-300 ${
            state.open ? "rotate-45 bg-failed" : "group-hover:rotate-45"
          }`}
        />
        <span className="underline decoration-line underline-offset-[6px] transition-colors duration-200 group-hover:decoration-failed">
          {state.open ? t("close") : t("link")}
        </span>
      </button>

      <AnimatePresence initial={false}>
        {state.open ? (
          <motion.div
            key="open"
            initial={calm ? false : { opacity: 0, height: 0 }}
            animate={calm ? undefined : { opacity: 1, height: "auto" }}
            exit={calm ? undefined : { opacity: 0, height: 0 }}
            transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
            className="overflow-hidden"
          >
            <div className="mt-7 border-s-2 border-failed bg-failed/5 p-6 sm:p-8">
              {isFlagDone(state) ? <Recorded flag={flag} /> : <Form flag={flag} />}
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </section>
  );
}

function Form({ flag }: { flag: FlagPassport }) {
  const t = useTranslations("passport.dispute.flag");
  const { state } = flag;
  const busy = isFlagBusy(state);
  const unconfirmed = isFlagUnconfirmed(state);
  const bond = flag.bond === null ? null : formatEther(flag.bond);
  const left = REASON_MAX - state.reason.trim().length;

  return (
    <div>
      <h3 className="max-w-[22ch] font-display text-[clamp(1.4rem,2.6vw,2rem)] font-semibold uppercase leading-[1.02] tracking-[-0.03em]">
        {t("heading")}
      </h3>
      <p className="mt-5 max-w-[54ch] text-sm leading-relaxed text-text-muted">
        {bond === null ? t("whatUnknown") : t("what", { bond })}
      </p>

      <dl className="mt-7 grid gap-x-8 gap-y-5 border-t border-line pt-5 sm:grid-cols-2">
        <div className="min-w-0">
          <dt className="font-mono text-[10px] uppercase tracking-[0.2em] text-text-faint">{t("bondLabel")}</dt>
          <dd className="mt-1.5 font-mono text-sm tabular-nums">
            {bond === null ? t("reading") : t("mon", { amount: bond })}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="font-mono text-[10px] uppercase tracking-[0.2em] text-text-faint">{t("balanceLabel")}</dt>
          <dd
            className={`mt-1.5 font-mono text-sm tabular-nums ${
              flag.check !== null && !flag.check.enough ? "text-failed" : ""
            }`}
          >
            {flag.balance === null ? t("reading") : t("mon", { amount: formatEther(flag.balance) })}
          </dd>
        </div>
      </dl>

      <p className="mt-5 max-w-[54ch] border-s-2 border-line ps-4 font-mono text-[11px] leading-relaxed text-text-faint">
        {t("fee")}
      </p>

      <label className="mt-7 block">
        <span className="flex flex-wrap items-baseline justify-between gap-2 font-mono text-[10px] uppercase tracking-[0.2em] text-text-faint">
          {t("reasonLabel")}
          <span className="tabular-nums">{t("reasonLeft", { left })}</span>
        </span>
        <textarea
          value={state.reason}
          maxLength={REASON_MAX}
          rows={4}
          disabled={busy}
          onChange={(event) => flag.actions.setReason(event.target.value)}
          placeholder={t("reasonPlaceholder")}
          className="mt-2 w-full resize-none border border-line bg-bg px-4 py-3 text-base leading-relaxed text-text outline-none transition-colors duration-200 placeholder:text-text-faint focus:border-failed"
        />
      </label>
      <p className="mt-2 max-w-[54ch] text-xs leading-relaxed text-text-faint">
        {t("reasonHint", { min: REASON_MIN, max: REASON_MAX })}
      </p>

      <button
        type="button"
        onClick={() => void flag.actions.submit()}
        // A flag that is out and unconfirmed keeps this locked. The recheck under
        // the message is the only way on, because the bond can only be lost once.
        disabled={busy || unconfirmed || flag.bond === null || state.reason.trim().length < REASON_MIN}
        className="mt-7 w-full rounded-[8px] bg-failed px-6 py-3.5 text-xs font-semibold uppercase tracking-[0.16em] text-bg transition-transform duration-200 hover:-translate-y-0.5 disabled:translate-y-0 disabled:opacity-50 sm:w-auto"
      >
        {bond === null ? t("submitUnknown") : t("submit", { bond })}
      </button>

      <ol className="mt-8 space-y-px border-t border-line pt-1">
        {FLAG_STEPS.map((step, index) => (
          <StepRow key={step} step={step} index={index} status={state.steps[step]} confirming={state.confirming} />
        ))}
      </ol>

      {state.failure === null ? null : (
        <div className="mt-6">
          <FailureLine failure={state.failure} flag={flag} />
        </div>
      )}
    </div>
  );
}

/** The receipt: the challenge is on the record, and where to read the transaction. */
function Recorded({ flag }: { flag: FlagPassport }) {
  const t = useTranslations("passport.dispute.flag");
  const { state } = flag;
  // A receipt link is only ever offered for a hash the chain has shown. A hash
  // from a send that has not been confirmed is not a receipt.
  const hash = isFlagDone(state) ? state.hash : undefined;

  return (
    <div>
      <p data-challenge-recorded className="flex items-center gap-3 font-mono text-[11px] uppercase tracking-[0.24em] text-verified">
        <span aria-hidden className="h-2 w-2 bg-verified" />
        {t("done.label")}
      </p>
      <h3 className="mt-5 max-w-[22ch] font-display text-[clamp(1.4rem,2.6vw,2rem)] font-semibold uppercase leading-[1.02] tracking-[-0.03em]">
        {t("done.heading")}
      </h3>
      <p className="mt-5 max-w-[54ch] text-sm leading-relaxed text-text-muted">{t("done.body")}</p>

      <dl className="mt-6 grid gap-x-8 gap-y-5 border-t border-line pt-5 sm:grid-cols-2">
        <div className="min-w-0">
          <dt className="font-mono text-[10px] uppercase tracking-[0.2em] text-text-faint">{t("done.block")}</dt>
          <dd className="mt-1.5 font-mono text-sm tabular-nums">
            {state.block === null ? t("done.blockPending") : state.block.toString()}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="font-mono text-[10px] uppercase tracking-[0.2em] text-text-faint">{t("done.bondHeld")}</dt>
          <dd className="mt-1.5 text-sm text-text-muted">{t("done.bondHeldBody")}</dd>
        </div>
      </dl>

      {hash === undefined ? null : (
        <a
          href={`${MONAD_EXPLORER}/tx/${hash}`}
          target="_blank"
          rel="noreferrer"
          className="mt-7 inline-block rounded-[8px] border border-line px-5 py-3 text-xs uppercase tracking-[0.16em] text-text-muted transition-colors duration-200 hover:border-failed hover:text-failed"
        >
          {t("done.openTx", { hash: shortHex(hash) })}
        </a>
      )}
    </div>
  );
}

export const NUMBER_TONE: Record<StepState, string> = {
  waiting: "text-text-faint",
  running: "text-pending",
  done: "text-verified",
  failed: "text-failed",
  // A send that is out and unshown is not a failure, so it never takes the alarm ink.
  unconfirmed: "text-text-muted",
};

export const MARKER_TONE: Record<StepState, string> = {
  waiting: "bg-line-strong",
  running: "motion-safe:animate-pulse bg-pending",
  done: "bg-verified",
  failed: "border border-failed bg-transparent",
  unconfirmed: "motion-safe:animate-pulse border border-text-muted bg-transparent",
};

const LABEL_TONE: Record<StepState, string> = {
  waiting: "text-text-faint",
  running: "text-text",
  done: "text-text-muted",
  failed: "text-text",
  unconfirmed: "text-text-muted",
};

function StepRow({
  step,
  index,
  status,
  confirming,
}: {
  step: FlagStep;
  index: number;
  status: StepState;
  confirming: boolean;
}) {
  const t = useTranslations("passport.dispute.flag");
  const label =
    step === "send" && status === "running" && confirming
      ? t("steps.send.watching")
      : // Only the send is ever left unconfirmed, and it has a line of its own:
        // it went out, which a failed send did not.
        t(`steps.${step}.${status}`);

  return (
    <li data-step={step} data-tone={status} className="flex items-start gap-4 py-3.5">
      <span className={`mt-0.5 font-mono text-[11px] tabular-nums ${NUMBER_TONE[status]}`}>
        {String(index + 1).padStart(2, "0")}
      </span>
      <span aria-hidden className={`mt-1.5 h-2 w-2 shrink-0 ${MARKER_TONE[status]}`} />
      <span className="min-w-0">
        <AnimatePresence mode="wait" initial={false}>
          <motion.span
            key={label}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.25 }}
            className={`block text-sm leading-relaxed ${LABEL_TONE[status]}`}
          >
            {label}
          </motion.span>
        </AnimatePresence>
      </span>
    </li>
  );
}

/** One failure: the sentence, the chain's own words under it, and the single thing worth doing next. */
function FailureLine({ failure, flag }: { failure: FlagFailure; flag: FlagPassport }) {
  const t = useTranslations("passport.dispute.flag");
  const handlers: Record<string, (() => void) | undefined> = {
    again: () => void flag.actions.submit(),
    recheck: () => void flag.actions.recheck(),
    signIn: flag.actions.signIn,
  };
  const action = failure.next === undefined ? undefined : handlers[failure.next];

  // A send that is still out is not a send that failed, so it keeps the muted ink
  // and the status role rather than the alarm.
  const pending = failure.key === "confirmPending";
  const key = t.has(`failure.${failure.key}`) ? failure.key : "unknown";

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
      role={pending ? "status" : "alert"}
      data-tone={pending ? "pending" : "failed"}
      className={`border-s-2 py-3 ps-4 ${pending ? "border-text-muted bg-text-muted/5" : "border-failed bg-failed/10"}`}
    >
      <p className={`flex max-w-[54ch] items-start gap-2.5 text-sm leading-relaxed ${pending ? "text-text-muted" : "text-failed"}`}>
        {pending ? null : <WarningMark className="mt-[3px]" />}
        {t(`failure.${key}`, {
          short: failure.shortfall === undefined ? "0" : formatEther(failure.shortfall),
          min: REASON_MIN,
          max: REASON_MAX,
        })}
      </p>
      {failure.reason === undefined ? null : (
        <p className="mt-2 max-w-[54ch] break-words font-mono text-[11px] leading-relaxed text-text-faint">
          {failure.reason}
        </p>
      )}
      {failure.address === undefined ? null : (
        <a
          href={`${MONAD_EXPLORER}/address/${failure.address}`}
          target="_blank"
          rel="noreferrer"
          className="mt-4 block font-mono text-[11px] text-text-faint underline decoration-line underline-offset-4 transition-colors duration-200 hover:text-failed"
        >
          {t("actions.openAddress", { wallet: shortHex(failure.address) })}
        </a>
      )}
      {action === undefined ? null : (
        <button
          type="button"
          onClick={action}
          className="mt-4 rounded-[8px] border border-line px-4 py-2 text-[11px] uppercase tracking-[0.18em] text-text-muted transition-colors duration-200 hover:border-failed hover:text-failed"
        >
          {t(`actions.${failure.next}`)}
        </button>
      )}
    </motion.div>
  );
}
