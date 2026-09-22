"use client";

import { AnimatePresence, motion } from "framer-motion";
import { useTranslations } from "next-intl";
import { useEffect, useState, type ReactNode } from "react";
import { plainStatement } from "@/lib/chain/consent";
import { MONAD_EXPLORER, shortHex } from "@/lib/chain/client";
import { ConsentField } from "@/components/studio/ConsentField";
import { SealedChoice, SealedDoneBand, sketchOf } from "@/components/studio/SealedFile";
import { useIsReducedMotion } from "@/components/motion/useIsReducedMotion";
import { Link } from "@/lib/i18n/routing";
import type { ConsentDraft } from "@/lib/consent/call";
import { EXAMPLE_PROMPTS } from "@/lib/studio/generate";
import type { RegisterState, Step, StepState } from "@/lib/studio/flow";
import {
  BENCH_PASSPORT_ID,
  PICTURE,
  PROMPT,
  TITLE,
  TOOK,
  stepsOf,
  type BenchState,
  type Path,
} from "./fixtures";

/**
 * The pieces both drawings are made of: the form face, the honest step lines,
 * and the receipt body. Each drawing decides where they go and how they arrive.
 * Nothing here knows which drawing it is in, so a difference between the two is
 * a difference of shape and never of content.
 */

/**
 * A running clock, to one decimal, started when the step it belongs to did.
 *
 * The first paint reads zero rather than the browser's clock, because the
 * server has no idea when this step began and a number that disagreed with its
 * own markup would be thrown away on hydration.
 */
export function Elapsed({ since, fixed }: { since: number; fixed?: number }) {
  const [ticked, setTicked] = useState(0);

  useEffect(() => {
    if (fixed !== undefined) {
      return;
    }
    const timer = window.setInterval(() => setTicked(Date.now()), 100);
    return () => window.clearInterval(timer);
  }, [fixed, since]);

  const ms = fixed ?? (ticked === 0 ? 0 : Math.max(0, ticked - since));
  return <span className="tabular-nums">{(ms / 1000).toFixed(1)}s</span>;
}

/** What a row is painted as, which is not always what the reducer stored. */
type Tone = Exclude<StepState, "unconfirmed"> | "pending";

const MARKER: Record<Tone, string> = {
  waiting: "bg-line-strong",
  running: "animate-pulse bg-accent",
  done: "bg-verified",
  failed: "bg-failed",
  pending: "border border-text-muted bg-transparent",
};

const INK: Record<Tone, string> = {
  waiting: "text-text-faint",
  running: "text-text",
  done: "text-verified",
  failed: "text-text",
  pending: "text-text-muted",
};

/** The studio's own words for one step, in the namespace the path uses. */
function useStepWords(path: Path): (step: Step, status: StepState, model: string) => string {
  const upload = useTranslations("studio.register.steps");
  const agent = useTranslations("studio.generate.steps");
  const words = path === "generate" ? agent : upload;

  return (step, status, model) => {
    if (status === "unconfirmed") {
      return words("send.pending");
    }
    return words(`${step}.${status}`, { model });
  };
}

/**
 * One line per step, in the studio's honest labels, with what each one took.
 *
 * The elapsed column is a fixed width in tabular figures: a clock that pushed
 * its own row sideways every tenth of a second would be the second thing on
 * this bench that moves under the reader.
 */
export function StepLines({
  path,
  state,
  since,
}: {
  path: Path;
  state: RegisterState;
  since: number;
}) {
  const words = useStepWords(path);
  const model = state.generated?.model ?? "";
  const watching = useTranslations(path === "generate" ? "studio.generate.steps" : "studio.register.steps");

  return (
    <ol className="space-y-px">
      {stepsOf(path).map((step, index) => {
        const status = state.steps[step];
        const tone: Tone = status === "unconfirmed" ? "pending" : status;
        const label =
          step === "send" && status === "running" && state.confirming
            ? watching("send.watching")
            : words(step, status, model);

        return (
          <li key={step} data-step={step} data-tone={tone} className="flex items-start gap-4 py-2.5">
            <span className="mt-0.5 w-6 shrink-0 font-mono text-[11px] tabular-nums text-text-faint">
              {String(index + 1).padStart(2, "0")}
            </span>
            <span aria-hidden className={`mt-[7px] h-2 w-2 shrink-0 ${MARKER[tone]}`} />
            <span className={`min-w-0 flex-1 text-sm leading-relaxed ${INK[tone]}`}>{label}</span>
            <span className="mt-0.5 w-[3.6rem] shrink-0 text-end font-mono text-[11px] text-text-faint">
              {status === "running" ? (
                <Elapsed since={since} />
              ) : status === "done" ? (
                <Elapsed since={since} fixed={TOOK[step] ?? 0} />
              ) : (
                ""
              )}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/** The one thing that went wrong, in the studio's own sentence, where the run was. */
export function FailureLine({ state, benchState }: { state: RegisterState; benchState: BenchState }) {
  const t = useTranslations("studio.failure");
  const failure = state.failure;

  if (failure === null) {
    return null;
  }

  return (
    <p
      className={`mt-5 max-w-[52ch] text-sm leading-relaxed ${
        benchState === "unconfirmed" ? "text-text-muted" : "text-failed"
      }`}
    >
      {t(failure.key, { reason: failure.reason ?? "" })}
    </p>
  );
}

/**
 * The form, as long as the real one: a picture or a prompt, a title, the AI use
 * plates, the keep-it switch, and the press.
 *
 * Everything on it is live, because a drawing of a form nobody can type into
 * tells Ram nothing about how the press feels at the bottom of it.
 */
export function FormFace({
  path,
  busy,
  onPress,
}: {
  path: Path;
  busy: boolean;
  /** Handed the press button's own place on screen, so the answer can land there. */
  onPress: (at: number) => void;
}) {
  const t = useTranslations("studio");
  const agent = useTranslations("studio.generate");
  const [title, setTitle] = useState(TITLE);
  const [prompt, setPrompt] = useState(PROMPT);
  const [draft, setDraft] = useState<ConsentDraft>({
    consent: { aiTraining: "notAllowed", aiGenerativeTraining: "notAllowed", aiInference: "notAllowed", dataMining: "notAllowed" },
    constraintInfo: "",
  });
  const [sealed, setSealed] = useState(false);

  return (
    <div>
      <p className="flex items-center gap-3 font-mono text-[11px] uppercase tracking-[0.24em] text-accent">
        <span className="motif h-[9px] w-[9px]" />
        {path === "generate" ? agent("kicker") : t("register.kicker")}
      </p>
      <h3 className="mt-5 max-w-[20ch] font-display text-[clamp(1.7rem,3.2vw,2.5rem)] font-semibold uppercase leading-[0.95] tracking-[-0.025em]">
        {path === "generate" ? agent("heading") : t("register.heading")}
      </h3>
      <p className="mt-4 max-w-[52ch] text-sm leading-relaxed text-text-muted">
        {path === "generate" ? agent("body") : t("register.body")}
      </p>

      {path === "generate" ? (
        <>
          <div className="grain relative mt-7 flex min-h-[12rem] flex-col justify-end border border-line-strong bg-bg-sunken p-7">
            <p className="max-w-[28ch] font-display text-[clamp(1.1rem,2.2vw,1.6rem)] leading-[1.15] tracking-[-0.02em]">
              {agent("plateWaiting")}
            </p>
          </div>

          <label className="mt-7 block">
            <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-text-faint">{agent("prompt")}</span>
            <textarea
              value={prompt}
              rows={3}
              disabled={busy}
              onChange={(event) => setPrompt(event.target.value)}
              className="mt-2 w-full resize-y border border-line bg-bg px-4 py-3 text-base leading-relaxed text-text outline-none transition-colors duration-200 focus:border-accent disabled:opacity-60"
            />
          </label>

          <p className="mt-6 font-mono text-[10px] uppercase tracking-[0.2em] text-text-faint">
            {agent("examplesLabel")}
          </p>
          <div className="mt-3 flex flex-col gap-2">
            {EXAMPLE_PROMPTS.map((example) => (
              <button
                key={example}
                type="button"
                disabled={busy}
                onClick={() => setPrompt(agent(`examples.${example}`))}
                className="group border border-line bg-bg px-4 py-3 text-start text-sm leading-relaxed text-text-muted transition-colors duration-200 hover:border-accent hover:text-text disabled:opacity-60"
              >
                <span className="me-3 font-mono text-[10px] text-text-faint transition-colors duration-200 group-hover:text-accent">
                  {"//"}
                </span>
                {agent(`examples.${example}`)}
              </button>
            ))}
          </div>
        </>
      ) : (
        <div className="grain relative mt-7 overflow-hidden border border-dashed border-line-strong">
          {/* The creator's own upload, shown from the file before anything is sent. */}
          <img src={PICTURE} alt="" width={1600} height={1200} className="h-[13rem] w-full object-cover sm:h-[17rem]" />
          <div className="scrim pointer-events-none absolute inset-0" />
          <div className="absolute inset-x-0 bottom-0 flex flex-wrap items-end justify-between gap-3 p-5">
            <p className="max-w-[26ch] break-all font-mono text-[11px] text-text">
              harbour-first-light.jpg <span className="text-text-faint">2.1 MB</span>
            </p>
            <span className="rounded-[8px] border border-line-strong bg-bg/70 px-4 py-2 font-mono text-[10px] uppercase tracking-[0.18em] text-text backdrop-blur">
              {t("register.replace")}
            </span>
          </div>
        </div>
      )}

      <label className="mt-7 block">
        <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-text-faint">{t("register.title")}</span>
        <input
          type="text"
          value={title}
          disabled={busy}
          onChange={(event) => setTitle(event.target.value)}
          className="mt-2 w-full border border-line bg-bg px-4 py-3 text-base text-text outline-none transition-colors duration-200 focus:border-accent disabled:opacity-60"
        />
      </label>

      <ConsentField draft={draft} onChange={setDraft} disabled={busy} />

      <SealedChoice
        on={sealed}
        onChange={setSealed}
        bits={null}
        generated={path === "generate"}
        includePrompt={false}
        onIncludePrompt={() => undefined}
        disabled={busy}
      />

      <button
        type="button"
        disabled={busy}
        onClick={(event) => onPress(event.currentTarget.getBoundingClientRect().top)}
        className="mt-8 w-full rounded-[8px] bg-accent px-7 py-4 text-sm font-semibold uppercase tracking-[0.14em] text-accent-ink transition-transform duration-200 hover:-translate-y-0.5 disabled:translate-y-0 disabled:opacity-50 sm:w-auto"
      >
        {path === "generate" ? agent("submit") : t("register.submit")}
      </button>
    </div>
  );
}

/**
 * Everything the run produced, in the order it happened: the picture or the
 * plate, what it is called on chain, the two confirmations, and the file for a
 * sealed one. The buttons are the drawing's own, because where they sit is the
 * thing being compared.
 */
export function ReceiptBody({ path, state }: { path: Path; state: RegisterState }) {
  const t = useTranslations("studio");
  const agent = useTranslations("studio.generate");
  const prepared = state.prepared;
  const sealed = prepared !== null && prepared.sealed === true;

  return (
    <div>
      {sealed ? (
        <SealedDoneBand
          file={state.sealed.file}
          bits={sketchOf(prepared.passport.blockhash256)}
          title={state.title}
          registeredAt={state.registeredAt}
          saved={state.sealed.saved}
          onSaved={() => undefined}
        />
      ) : (
        <div className="relative overflow-hidden">
          {/* The pinned copy, read back the way a verifier fetches it. */}
          <img
            src={PICTURE}
            alt=""
            width={1600}
            height={1200}
            className="h-[12rem] w-full object-cover sm:h-[16rem]"
          />
          <div className="scrim pointer-events-none absolute inset-0" />
          <p className="absolute bottom-4 start-5 font-mono text-[11px] uppercase tracking-[0.24em] text-verified">
            {path === "generate" ? agent("doneLabel") : t("register.doneLabel")}
          </p>
        </div>
      )}

      <div className="mt-7">
        <h3 className="max-w-[18ch] font-display text-[clamp(1.6rem,3.2vw,2.4rem)] font-semibold uppercase leading-[0.95] tracking-[-0.03em]">
          {path === "generate" ? agent("doneHeading") : t("register.doneHeading")}
        </h3>
        <p className="mt-3 max-w-[50ch] text-sm leading-relaxed text-text-muted">
          {path === "generate" ? agent("doneBody") : t("register.doneBody")}
        </p>

        <dl className="mt-7 grid gap-x-8 gap-y-5 border-t border-line pt-6 sm:grid-cols-2">
          <Fact label={t("register.passportId")} value={shortHex(BENCH_PASSPORT_ID, 10, 8)} mono />
          <Fact label={t("register.when")} value="22 Sep 2026, 09:41" />
          {path === "generate" ? (
            <Fact label={agent("modelRow")} value={state.generated?.model ?? ""} mono />
          ) : null}
          <Fact label={t("register.fee")} value={t("register.feeSponsored")} />
        </dl>

        <Confirmations state={state} />
      </div>
    </div>
  );
}

/**
 * The two writes this run made, side by side: the passport, and the statement
 * about AI use.
 *
 * They are two transactions and they are shown as two, because a statement that
 * did not land takes nothing away from a passport that did, and a creator who
 * reads one number for both would never know which half failed.
 */
function Confirmations({ state }: { state: RegisterState }) {
  const t = useTranslations("studio");
  const said = useTranslations("studio.consent.receipt");
  const words = useTranslations("passport.consent.summary");
  const statement = state.statement;
  const failed = statement.state === "failed";

  return (
    <div className="mt-7 grid gap-px border border-line bg-line sm:grid-cols-2">
      <div className="bg-bg-raised p-5">
        <p className="flex items-center gap-2.5 font-mono text-[10px] uppercase tracking-[0.2em] text-verified">
          <span aria-hidden className="motif h-[8px] w-[8px]" />
          {t("receipt.written")}
        </p>
        <p className="mt-3 font-display text-[clamp(1.8rem,4vw,2.6rem)] font-semibold leading-[0.9] tracking-[-0.05em] tabular-nums">
          1,842
          <span className="ms-2 align-top font-mono text-[0.8rem] tracking-[0.06em] text-accent">
            {t("receipt.msUnit")}
          </span>
        </p>
        <p className="mt-2 font-mono text-[11px] text-text-faint">
          {t("receipt.blockValue", { block: "103,059,393" })}
        </p>
        <a
          href={`${MONAD_EXPLORER}/tx/${state.txHash ?? ""}`}
          target="_blank"
          rel="noreferrer"
          className="mt-3 block break-all font-mono text-[11px] text-text-muted underline decoration-line underline-offset-4 transition-colors duration-200 hover:text-accent"
        >
          {shortHex(state.txHash ?? "0x", 8, 6)}
        </a>
      </div>

      <div className="bg-bg-raised p-5">
        <p
          className={`flex items-center gap-2.5 font-mono text-[10px] uppercase tracking-[0.2em] ${
            failed ? "text-failed" : "text-verified"
          }`}
        >
          <span aria-hidden className={`h-[8px] w-[8px] ${failed ? "bg-failed" : "motif"}`} />
          {said("label")}
        </p>

        {failed ? (
          <>
            <p className="mt-3 max-w-[26ch] font-display text-[1.15rem] font-semibold leading-[1.1] tracking-[-0.02em] text-failed">
              {said("failed")}
            </p>
            <p className="mt-2 max-w-[34ch] text-xs leading-relaxed text-text-faint">{said("later")}</p>
            <span className="mt-4 inline-block rounded-[8px] border border-line px-4 py-2 font-mono text-[10px] uppercase tracking-[0.18em] text-text-muted transition-colors duration-200 hover:border-accent hover:text-accent">
              {said("again")}
            </span>
          </>
        ) : (
          <>
            <p className="mt-3 max-w-[24ch] font-display text-[1.25rem] font-semibold leading-[1.05] tracking-[-0.02em]">
              {words(plainStatement(statement.sent?.consent ?? { aiTraining: "unspecified", aiGenerativeTraining: "unspecified", aiInference: "unspecified", dataMining: "unspecified" }))}
            </p>
            <p className="mt-2 font-mono text-[11px] text-text-faint">
              {said("statedIn", { ms: "1,306" })}
            </p>
            <a
              href={`${MONAD_EXPLORER}/tx/${statement.hash ?? ""}`}
              target="_blank"
              rel="noreferrer"
              className="mt-3 block break-all font-mono text-[11px] text-text-muted underline decoration-line underline-offset-4 transition-colors duration-200 hover:text-accent"
            >
              {shortHex(statement.hash ?? "0x", 8, 6)}
            </a>
          </>
        )}
      </div>
    </div>
  );
}

function Fact({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="font-mono text-[10px] uppercase tracking-[0.2em] text-text-faint">{label}</dt>
      <dd className={`mt-1.5 break-all text-sm ${mono ? "font-mono" : ""}`}>{value}</dd>
    </div>
  );
}

/** The passport this run made, and a clean form for the next picture. */
export function ReceiptButtons({
  onAnother,
  stacked = false,
}: {
  onAnother: (at: number) => void;
  stacked?: boolean;
}) {
  const t = useTranslations("studio");

  return (
    <div className={`flex flex-wrap items-center gap-3 ${stacked ? "" : "mt-8"}`}>
      <Link
        href={`/passport/${BENCH_PASSPORT_ID}`}
        className="rounded-[8px] bg-accent px-6 py-3.5 text-xs font-semibold uppercase tracking-[0.16em] text-accent-ink transition-transform duration-200 hover:-translate-y-0.5"
      >
        {t("register.openPassport")}
      </Link>
      <button
        type="button"
        onClick={(event) => onAnother(event.currentTarget.getBoundingClientRect().top)}
        className="rounded-[8px] border border-line px-5 py-3.5 text-xs uppercase tracking-[0.16em] text-text-muted transition-colors duration-200 hover:border-accent hover:text-accent"
      >
        Make another
      </button>
    </div>
  );
}

/** One face of a drawing, arriving where the last one was. */
export function Face({ name, children }: { name: string; children: ReactNode }) {
  const reduced = useIsReducedMotion();

  return (
    <AnimatePresence mode="popLayout" initial={false}>
      <motion.div
        key={name}
        initial={reduced ? { opacity: 0 } : { opacity: 0, y: 14 }}
        animate={{ opacity: 1, y: 0 }}
        transition={reduced ? { duration: 0.15 } : { duration: 0.45, ease: [0.16, 1, 0.3, 1] }}
      >
        {children}
      </motion.div>
    </AnimatePresence>
  );
}
