"use client";

import { AnimatePresence, motion } from "framer-motion";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import { useId, useRef, useState, type ReactNode } from "react";
import type { Hex } from "viem";
import { shortHex } from "@/lib/chain/client";
import { useIsReducedMotion } from "@/components/motion/useIsReducedMotion";
import {
  GENERATE_STEPS,
  isBusy,
  isRegistered,
  passportId,
  type RegisterState,
  type Step,
  type StepState,
} from "@/lib/studio/flow";
import { EXAMPLE_PROMPTS, PROMPT_MAX, PROMPT_MIN, atLimit } from "@/lib/studio/generate";
import { draftProblem, type ConsentDraft } from "@/components/consent/draft";
import { ConsentField } from "./ConsentField";
import { DoneActions, FailureNote } from "./afterPress";
import { SealedChoice, SealedDoneBand, SealedDrawing, SealedFileCard, sketchOf } from "./SealedFile";
import { StatusBand } from "./StatusBand";
import { SwornLine } from "./SwornLine";
import { hasStarted, pressRefusal, useFoldFocus } from "./press";
import { TitleNeeded, titleBorder } from "./TitleNeeded";
import {
  ACROSS,
  AT_LEFT,
  AT_RIGHT,
  UNDER_RIGHT,
  WIDE_CARD_HEADING,
  WIDE_COLUMNS,
  WIDE_FACE,
  WIDE_PICTURE,
  WIDE_STAGE,
  WideColumn,
  useWide,
  wideOnly,
} from "./layout";
import { useHeadingLeading } from "./leading";

/**
 * The agent half of the studio: a prompt, a picture drawn by an agent with its
 * own identity on chain, and two signatures over one passport.
 *
 * The two signatures are the point of the screen, so they are the largest thing
 * on it once the answer lands. Nothing here is decoration: every hex shown is a
 * value that was actually signed or pinned.
 */
export function GeneratePanel({
  state,
  wallet,
  receipt,
  pressing = false,
  onPrompt,
  onTitle,
  onConsent,
  onSealed,
  onIncludePrompt,
  onSaved,
  onGenerate,
  onReset,
  onUnsponsored,
  onBind,
  onRecheck,
  onSignIn,
  balance,
}: {
  state: RegisterState;
  /** Only for the fallback link, when a sponsored send landed without handing back a hash. */
  wallet?: Hex;
  /** The stub, which is part of this one box and sits under whatever face is showing. */
  receipt?: ReactNode;
  /** True from the moment the button is pressed until the run has actually started. */
  pressing?: boolean;
  onPrompt: (prompt: string) => void;
  onTitle: (title: string) => void;
  onConsent: (draft: ConsentDraft) => void;
  /** Register this drawing without publishing it, and whether a private copy is kept for a re-check. */
  onSealed: (on: boolean, privateRecheck?: boolean) => void;
  /** Whether the prompt joins the sealed record. Only asked once the switch is on. */
  onIncludePrompt: (include: boolean) => void;
  /** The creator has written the one copy of a sealed drawing to their own disk. */
  onSaved: () => void;
  onGenerate: () => void;
  onReset: () => void;
  onUnsponsored: () => void;
  onBind: () => void;
  onRecheck?: () => void;
  /** Opens the sign in again, for a session that expired during the run. */
  onSignIn?: () => void;
  /** The account's own MON, read once a sponsored send was refused. */
  balance?: bigint | null;
}) {
  const t = useTranslations("studio.generate");
  const leading = useHeadingLeading("leading-[0.95]", "leading-[1.15]");
  const titleInput = useRef<HTMLInputElement>(null);
  const needId = useId();
  const [titleAsked, setTitleAsked] = useState(false);
  const titleWanted = state.title.trim().length === 0 && (titleAsked || state.failure?.key === "titleMissing");
  const busy = isBusy(state);
  const done = isRegistered(state);
  const spent = atLimit(state.quota);
  const characters = state.prompt.trim().length;
  const wide = useWide();

  const folded = hasStarted(state);
  const panel = useRef<HTMLDivElement>(null);
  useFoldFocus(panel, folded);

  // An empty title is answered on the field, and the press is never taken.
  function pressGenerate() {
    if (pressRefusal(state) === "titleMissing") {
      setTitleAsked(true);
      titleInput.current?.focus();
      return;
    }
    onGenerate();
  }

  const sealedChoice = (
    <SealedChoice
      on={state.sealed.on}
      onChange={(on) => onSealed(on)}
      bits={sketchOf(state.generated?.passport.blockhash256)}
      generated
      includePrompt={state.sealed.includePrompt}
      onIncludePrompt={onIncludePrompt}
      privateRecheck={state.sealed.privateRecheck === true}
      onPrivateRecheck={(keep) => onSealed(true, keep)}
      disabled={busy}
    />
  );

  // On a laptop the plate keeps the left column through the run and the done
  // screen, so the drawing lands where the eye already is, and the band lands
  // in the right column, where the button was pressed.
  if ((done || folded) && wide) {
    return (
      <div ref={panel} data-studio-panel="generate" data-face={done ? "receipt" : "run"} data-studio-layout="wide" className={WIDE_FACE}>
        <div data-studio-column="picture" className={`hidden lg:block ${AT_LEFT} ${WIDE_STAGE}`}>
          {done ? <Generated state={state} onSaved={onSaved} media="only" /> : <Plate state={state} wide />}
        </div>
        <div data-studio-column="details" className={AT_RIGHT}>
          <div className="sticky top-[var(--studio-top,var(--header-h))] z-30">
            <StatusBand state={state} />
          </div>
          {done ? (
            <Generated state={state} onSaved={onSaved} media="not-at-lg" />
          ) : (
            <Run
              state={state}
              onGenerate={onGenerate}
              onBind={onBind}
              onUnsponsored={onUnsponsored}
              onRecheck={onRecheck}
              onSaved={onSaved}
              onSignIn={onSignIn}
              balance={balance}
              plateAtLg={false}
            />
          )}
        </div>
        {/* Before the receipt in the markup so a phone, which reads it top to
            bottom, has the ways on straight under the done card and not under
            nine stamps. On a laptop the grid places both. */}
        {done ? (
          <div className={UNDER_RIGHT}>
            <DoneActions state={state} wallet={wallet} onReset={onReset} />
          </div>
        ) : null}
        <div className={ACROSS}>{receipt}</div>
      </div>
    );
  }

  if (done || folded) {
    return (
      <div ref={panel} data-studio-panel="generate" data-face={done ? "receipt" : "run"}>
        <div className="sticky top-[var(--studio-top,var(--header-h))] z-30">
          <StatusBand state={state} />
        </div>
        {done ? (
          <Generated state={state} onSaved={onSaved} />
        ) : (
          <Run
            state={state}
            onGenerate={onGenerate}
            onBind={onBind}
            onUnsponsored={onUnsponsored}
            onRecheck={onRecheck}
            onSaved={onSaved}
            onSignIn={onSignIn}
            balance={balance}
          />
        )}
        {done ? <DoneActions state={state} wallet={wallet} onReset={onReset} /> : null}
        {receipt}
      </div>
    );
  }

  return (
    <div ref={panel} data-studio-panel="generate" data-face="form" data-studio-layout={wide ? "wide" : undefined}>
    <motion.section
      initial={{ opacity: 0, y: 24 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
      className={`border border-line bg-bg-raised p-6 sm:p-9${wideOnly(wide, `${WIDE_COLUMNS} lg:p-7 xl:p-8`)}`}
    >
      {/* On a laptop the prompt and the title are lifted above the plate, so
          everything to type is in the first screen with the plate's top in view.
          A phone keeps today's order. */}
      <WideColumn wide={wide} name="picture" className={`${WIDE_STAGE} lg:flex lg:flex-col`}>
      <p className="flex items-center gap-3 font-mono text-[11px] uppercase tracking-[0.24em] text-accent">
        <span className="motif h-[9px] w-[9px]" />
        {t("kicker")}
      </p>
      <h2
        className={`mt-5 max-w-[20ch] font-display text-[clamp(1.7rem,3.4vw,2.7rem)] font-semibold uppercase tracking-[-0.02em] ${leading}${wideOnly(
          wide,
          WIDE_CARD_HEADING,
        )}`}
      >
        {t("heading")}
      </h2>
      <p className={`mt-4 max-w-[56ch] text-base leading-relaxed text-text-muted${wideOnly(wide, "lg:mt-2")}`}>{t("body")}</p>

      <Plate state={state} wide={wide} />

      <label className={`mt-8 block${wideOnly(wide, "lg:order-1 lg:mt-6")}`}>
        <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-text-faint">{t("prompt")}</span>
        <textarea
          value={state.prompt}
          maxLength={PROMPT_MAX}
          rows={3}
          disabled={busy}
          onChange={(event) => onPrompt(event.target.value)}
          placeholder={t("promptPlaceholder")}
          className="mt-2 w-full resize-y border border-line bg-bg px-4 py-3 text-base leading-relaxed text-text outline-none transition-colors duration-200 placeholder:text-text-faint focus:border-accent"
        />
      </label>
      <div className={`mt-2 flex flex-wrap items-baseline justify-between gap-3${wideOnly(wide, "lg:order-1")}`}>
        <p className="max-w-[52ch] text-base leading-relaxed text-text-faint">{t("promptHint")}</p>
        <p
          className={`font-mono text-[11px] tabular-nums ${
            characters >= PROMPT_MIN ? "text-text-muted" : "text-text-faint"
          }`}
        >
          {t("counter", { count: characters, max: PROMPT_MAX })}
        </p>
      </div>

      <p className={`mt-7 font-mono text-[10px] uppercase tracking-[0.2em] text-text-faint${wideOnly(wide, "lg:order-5")}`}>
        {t("examplesLabel")}
      </p>
      <div className={`mt-3 flex flex-col gap-2${wideOnly(wide, "lg:order-5")}`}>
        {EXAMPLE_PROMPTS.map((example) => (
          <button
            key={example}
            type="button"
            disabled={busy}
            onClick={() => onPrompt(t(`examples.${example}`))}
            className="group border border-line bg-bg px-4 py-3 text-start text-sm leading-relaxed text-text-muted transition-colors duration-200 hover:border-accent hover:text-text disabled:opacity-60"
          >
            <span className="me-3 font-mono text-[10px] text-text-faint transition-colors duration-200 group-hover:text-accent">
              {"//"}
            </span>
            {t(`examples.${example}`)}
          </button>
        ))}
      </div>

      {/* On a laptop the name sits under the prompt, above the plate, so what to
          type and what to call it are both in the first screen; whether it is
          published sits under the plate, and the right column is the AI-use
          choice and the press. */}
      <label className={`mt-8 block${wideOnly(wide, "lg:order-2 lg:mt-5")}`}>
        <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-text-faint">{t("title")}</span>
        <input
          ref={titleInput}
          type="text"
          value={state.title}
          maxLength={120}
          disabled={busy}
          aria-invalid={titleWanted ? true : undefined}
          aria-describedby={titleWanted ? needId : undefined}
          onChange={(event) => {
            if (event.target.value.trim().length > 0) {
              setTitleAsked(false);
            }
            onTitle(event.target.value);
          }}
          placeholder={t("titlePlaceholder")}
          className={`mt-2 w-full border bg-bg px-4 py-3 text-base text-text outline-none transition-colors duration-200 placeholder:text-text-faint ${titleBorder(titleWanted)}`}
        />
      </label>
      {titleWanted ? <TitleNeeded id={needId} className={wideOnly(wide, "lg:order-2")} /> : null}
      <p data-title-hint className={`mt-2 max-w-[60ch] text-base leading-relaxed text-text-faint${wideOnly(wide, "lg:order-2")}`}>{t("titleHint")}</p>
      {wide ? <div className="hidden lg:order-4 lg:block">{sealedChoice}</div> : null}
      </WideColumn>

      <WideColumn wide={wide} name="details">
      <ConsentField draft={state.consent} onChange={onConsent} disabled={busy} />

      {wide ? <div className="lg:hidden">{sealedChoice}</div> : sealedChoice}

      {/* The agent's picture goes from this press to the passkey with no stop,
          so the sentence the creator signs under sits straight above it. */}
      <SwornLine className={`mt-8${wideOnly(wide, "lg:mt-6")}`} />

      {/* The press is answered here before anything else moves: the label turns
          into the first line of the run and the button goes quiet. The room for
          two lines is held from the start, because a button that grows under the
          thumb moves the whole page with it. On a laptop the button takes the
          column's width, as the upload press does, and the quota sentence
          wraps under it rather than squeezing its label onto three lines. */}
      <div className={`mt-8 flex flex-wrap items-center gap-5${wideOnly(wide, "lg:mt-6")}`}>
        <button
          type="button"
          onClick={pressGenerate}
          disabled={pressing || busy || spent || characters < PROMPT_MIN || draftProblem(state.consent) !== null}
          data-press
          className={`flex min-h-[4.5rem] w-full items-center justify-center rounded-[8px] bg-accent px-7 py-4 text-center text-sm font-semibold text-accent-ink transition-transform duration-200 hover:-translate-y-0.5 disabled:translate-y-0 disabled:opacity-60 sm:inline-flex sm:min-h-0 sm:w-auto ${
            pressing ? "normal-case" : "uppercase tracking-[0.14em]"
          }${wideOnly(wide, "lg:flex lg:w-full")}`}
        >
          {pressing ? t("steps.draw.running") : t("submit")}
        </button>
        <Quota state={state} />
      </div>

      {/* A failure on this face is a check the press itself made (no title yet,
          the passkey not read yet), so its line sits under the button that was
          pressed rather than under the seals and the steps that never started. */}
      {state.failure === null || titleWanted ? null : (
        <div className="mt-6" data-press-failure>
          <FailureNote
            failure={state.failure}
            passportId={passportId(state)}
            onAgain={pressGenerate}
            onGenerateAgain={pressGenerate}
            onBind={onBind}
            onUnsponsored={onUnsponsored}
            onRecheck={onRecheck}
            onSignIn={onSignIn}
            balance={balance}
          />
        </div>
      )}

      <Signatures state={state} />

      {/* What the press is about to do, in the same five lines the run itself
          uses. A creator should be able to read the whole of it before they
          start, which is the one thing a folded run cannot show them. */}
      <ol className="mt-9 space-y-px border-t border-line pt-1">
        {GENERATE_STEPS.map((step, index) => (
          <StepRow key={step} step={step} index={index} state={state} />
        ))}
      </ol>
      </WideColumn>
    </motion.section>
    {receipt}
    </div>
  );
}

/**
 * What the box holds while the agent is at work: the plate the picture lands on,
 * the two seals, the five steps, the one copy of a sealed drawing, and whatever
 * went wrong.
 *
 * The plate and the seals stay through the run because they are the answer
 * arriving: a minute of five step labels and nothing else is the wait this
 * screen was built to make readable.
 *
 * Below lg that answer is a screen tall, so when the run fails the note and its
 * one button are lifted over the plate to sit straight under the red band. On a
 * laptop the plate has the left column and the note keeps its place.
 */
function Run({
  state,
  onGenerate,
  onBind,
  onUnsponsored,
  onRecheck,
  onSaved,
  onSignIn,
  balance,
  plateAtLg = true,
}: {
  state: RegisterState;
  onGenerate: () => void;
  onBind: () => void;
  onUnsponsored: () => void;
  onRecheck?: () => void;
  onSaved: () => void;
  onSignIn?: () => void;
  balance?: bigint | null;
  /** False under the wide layout, where the plate has the left column to itself from lg. */
  plateAtLg?: boolean;
}) {
  return (
    <motion.section
      initial={{ opacity: 0, y: 18 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.55, delay: 0.08, ease: [0.16, 1, 0.3, 1] }}
      className={`border border-line bg-bg-raised p-6 sm:p-9${wideOnly(!plateAtLg, "max-lg:flex max-lg:flex-col")}`}
    >
      {plateAtLg ? (
        <Plate state={state} />
      ) : (
        <div className="lg:hidden">
          <Plate state={state} />
        </div>
      )}

      <ol className={`mt-8 space-y-px${wideOnly(!plateAtLg, "lg:mt-0")}`}>
        {GENERATE_STEPS.map((step, index) => (
          <StepRow key={step} step={step} index={index} state={state} />
        ))}
      </ol>

      {state.sealed.file === null ? null : (
        <SealedFileCard
          file={state.sealed.file}
          bits={sketchOf(state.generated?.passport.blockhash256)}
          title={state.title}
          saved={state.sealed.saved}
          onSaved={onSaved}
          privateCopy={state.prepared?.privateRecheck === true}
        />
      )}

      <Signatures state={state} />

      {state.failure === null ? null : (
        <div data-run-failure className={`mt-7${wideOnly(!plateAtLg, "max-lg:order-first max-lg:mt-0")}`}>
          <FailureNote
            failure={state.failure}
            passportId={passportId(state)}
            onAgain={onGenerate}
            onGenerateAgain={onGenerate}
            onBind={onBind}
            onUnsponsored={onUnsponsored}
            onRecheck={onRecheck}
            onSignIn={onSignIn}
            balance={balance}
          />
        </div>
      )}

      <div className="mt-7">
        <Quota state={state} />
      </div>
    </motion.section>
  );
}

/** Today's count, and when the next picture opens up. Both come from the service's own answer. */
function Quota({ state }: { state: RegisterState }) {
  const t = useTranslations("studio.generate");
  const locale = useLocale();

  if (state.quota === null) {
    return null;
  }

  const resets = localTime(state.quota.resetsAt, locale);

  return (
    <p className="text-base leading-relaxed text-text-faint">
      <span className="font-mono text-[11px] tabular-nums text-text-muted">
        {t("quota", { used: state.quota.used, limit: state.quota.limit })}
      </span>
      <span className="ms-2">{atLimit(state.quota) ? t("quotaSpent", { time: resets }) : t("quotaResets", { time: resets })}</span>
    </p>
  );
}

/**
 * Where the picture lands. Empty it is a lit plate waiting for one, and while
 * the agent draws, a light sweeps across it under an honest label, because a
 * minute of nothing looks like a hang.
 */
function Plate({ state, wide = false }: { state: RegisterState; wide?: boolean }) {
  const t = useTranslations("studio.generate");
  const reduced = useIsReducedMotion();
  const drawing = state.steps.draw === "running";
  const drawn = state.generated;
  const image = drawn?.image ?? null;
  // A kept drawing has no pinned picture to read back, so the plate holds its
  // fingerprint instead of an empty frame.
  const sealed = drawn?.sealed === true ? sketchOf(drawn.passport.blockhash256) : null;

  return (
    <div
      className={`grain relative mt-8 min-h-[14rem] overflow-hidden border border-line-strong bg-bg-sunken${wideOnly(
        wide,
        `lg:order-3 lg:mt-6 lg:flex lg:flex-col lg:[&>*]:flex-1 ${WIDE_PICTURE}`,
      )}`}
    >
      <AnimatePresence mode="wait" initial={false}>
        {drawn?.sealed === true ? (
          <motion.div
            key="sealed"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
          >
            <SealedDrawing bits={sealed} label={t("plateLabel")} model={t("model", { model: drawn.model })} />
          </motion.div>
        ) : image === null ? (
          <motion.div
            key={drawing ? "drawing" : "empty"}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.3 }}
            className={`relative flex min-h-[14rem] flex-col justify-end gap-3 p-8 sm:p-10${wideOnly(wide, "lg:h-full")}`}
          >
            {drawing && !reduced ? (
              <motion.span
                aria-hidden
                initial={{ x: "-60%" }}
                animate={{ x: "160%" }}
                transition={{ duration: 2.6, repeat: Infinity, ease: "linear" }}
                className="pointer-events-none absolute inset-y-0 w-1/2 bg-gradient-to-r from-transparent via-accent-soft to-transparent"
              />
            ) : null}
            <p className="relative max-w-[30ch] font-display text-[clamp(1.2rem,2.4vw,1.8rem)] leading-[1.15] tracking-[-0.02em]">
              {drawing ? t("plateDrawing") : t("plateWaiting")}
            </p>
            {drawing ? (
              <p className="relative flex items-center gap-3 font-mono text-[11px] uppercase tracking-[0.18em] text-accent">
                <span className="motif h-2 w-2 animate-pulse bg-accent" />
                {t("steps.draw.running")}
              </p>
            ) : null}
          </motion.div>
        ) : (
          <motion.div
            key="image"
            initial={{ opacity: 0, scale: 1.04 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.9, ease: [0.16, 1, 0.3, 1] }}
            className={`relative${wideOnly(wide, "lg:h-full")}`}
          >
            {/* The pinned copy, read back through the gateway: what a verifier will fetch. */}
            <img
              src={image.gatewayUrl}
              alt=""
              className={`max-h-[26rem] w-full object-cover${wideOnly(wide, "lg:h-full lg:max-h-none")}`}
            />
            <div className="scrim pointer-events-none absolute inset-0" />
            <div className="absolute inset-x-0 bottom-0 flex flex-wrap items-end justify-between gap-3 p-5">
              <p className="font-mono text-[11px] uppercase tracking-[0.24em] text-accent">{t("plateLabel")}</p>
              <p className="font-mono text-[11px] text-text-faint">
                {t("model", { model: state.generated?.model ?? "" })}
              </p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/**
 * The two seals. The agent's fills in when its answer lands, the creator's when
 * the passkey has signed, and the line between them only closes once both are
 * there, which is exactly what the registry asks for.
 */
function Signatures({ state }: { state: RegisterState }) {
  const t = useTranslations("studio.generate.signatures");
  const generated = state.generated;
  const agentSigned = state.steps.agentSign === "done" && generated !== null;
  const youSigned = state.steps.sign === "done" && state.digest !== null;

  return (
    <div className="mt-10 border-t border-line pt-7">
      <p className="font-display text-[clamp(1.1rem,2vw,1.5rem)] uppercase tracking-[-0.01em]">{t("heading")}</p>
      <p className="mt-2 max-w-[54ch] text-base leading-relaxed text-text-faint">{t("body")}</p>

      <div className="relative mt-6 grid gap-4 sm:grid-cols-2">
        <span
          aria-hidden
          className={`pointer-events-none absolute start-1/2 top-1/2 hidden h-px w-10 -translate-x-1/2 -translate-y-1/2 transition-colors duration-500 sm:block ${
            agentSigned && youSigned ? "bg-accent" : "bg-line-strong"
          }`}
        />

        <Seal
          filled={agentSigned}
          label={t("agent")}
          waiting={t("agentWaiting")}
          value={generated?.generatorSig ?? ""}
          detail={t("agentDetail")}
          lines={
            generated === null
              ? []
              : [t("agentId", { id: generated.agent.id }), t("agentWallet", { wallet: shortHex(generated.agent.wallet) })]
          }
        />
        <Seal
          filled={youSigned}
          label={t("you")}
          waiting={t("youWaiting")}
          value={state.digest ?? ""}
          detail={t("youDetail")}
          lines={[]}
        />
      </div>
    </div>
  );
}

function Seal({
  filled,
  label,
  waiting,
  value,
  detail,
  lines,
}: {
  filled: boolean;
  label: string;
  waiting: string;
  value: string;
  detail: string;
  lines: string[];
}) {
  return (
    <motion.div
      animate={filled ? { borderColor: "var(--accent)" } : {}}
      transition={{ duration: 0.5 }}
      data-signed={filled}
      className={`relative overflow-hidden border p-5 transition-colors duration-500 ${
        filled ? "border-accent bg-accent-soft" : "border-dashed border-line-strong bg-bg"
      }`}
    >
      <p
        className={`flex items-center gap-2.5 font-mono text-[10px] uppercase tracking-[0.22em] ${
          filled ? "text-accent" : "text-text-faint"
        }`}
      >
        <span aria-hidden className={`h-[9px] w-[9px] ${filled ? "motif" : "border border-text-faint"}`} />
        {label}
      </p>

      <AnimatePresence mode="wait" initial={false}>
        {filled ? (
          <motion.div
            key="signed"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.45, ease: [0.16, 1, 0.3, 1] }}
          >
            <p className="mt-3 break-all font-mono text-[11px] leading-relaxed text-text">{shortHex(value, 14, 12)}</p>
            {lines.map((line) => (
              <p key={line} className="mt-1 font-mono text-[10px] text-text-muted">
                {line}
              </p>
            ))}
            <p className="mt-3 max-w-[34ch] text-base leading-relaxed text-text-faint">{detail}</p>
          </motion.div>
        ) : (
          <motion.p
            key="waiting"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="mt-3 max-w-[34ch] text-base leading-relaxed text-text-faint"
          >
            {waiting}
          </motion.p>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

type Tone = Exclude<StepState, "unconfirmed"> | "pending";

const NUMBER_TONE: Record<Tone, string> = {
  waiting: "text-text-faint",
  running: "text-accent",
  done: "text-accent",
  failed: "text-failed",
  pending: "text-text-muted",
};

const MARKER_TONE: Record<Tone, string> = {
  waiting: "bg-line-strong",
  running: "animate-pulse bg-accent",
  done: "bg-verified",
  failed: "bg-failed",
  pending: "border border-text-muted bg-transparent",
};

const LABEL_TONE: Record<Tone, string> = {
  waiting: "text-text-faint",
  running: "text-text",
  done: "text-verified",
  failed: "text-text",
  pending: "text-text-muted",
};

function StepRow({ step, index, state }: { step: Step; index: number; state: RegisterState }) {
  const t = useTranslations("studio.generate");
  const status = state.steps[step];

  // A send that ran out of patience is not a send that failed. The transaction
  // was accepted and may still land, so the row waits in the muted ink with a
  // hollow marker. The red is kept for the sends that really did not make it.
  const tone: Tone = status === "unconfirmed" ? "pending" : status;

  const label =
    step === "send" && status === "running" && state.confirming
      ? t("steps.send.watching")
      : tone === "pending"
        ? t("steps.send.pending")
        : // The model is only named once the service has said which one drew.
          t(`steps.${step}.${status}`, { model: state.generated?.model ?? "" });

  return (
    <li data-step={step} data-tone={tone} className="flex items-start gap-5 py-4">
      <span className={`mt-1 font-mono text-[11px] tabular-nums ${NUMBER_TONE[tone]}`}>
        {String(index + 1).padStart(2, "0")}
      </span>
      <span aria-hidden className={`motif mt-2 h-2 w-2 shrink-0 ${MARKER_TONE[tone]}`} />
      <span className="min-w-0">
        <AnimatePresence mode="wait" initial={false}>
          <motion.span
            key={label}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.25 }}
            className={`block text-base leading-relaxed ${LABEL_TONE[tone]}`}
          >
            {label}
          </motion.span>
        </AnimatePresence>
      </span>
    </li>
  );
}

/** The same stub the upload path ends on, with the agent named on it. */
/** Drawn twice under the wide layout on a laptop, the way the upload path's done screen is. */
function Generated({
  state,
  onSaved,
  media,
}: {
  state: RegisterState;
  onSaved: () => void;
  media?: "only" | "not-at-lg";
}) {
  const t = useTranslations("studio.generate");
  const shared = useTranslations("studio");
  const kinds = useTranslations("kind");
  const leading = useHeadingLeading("leading-[0.95]", "leading-[1.15]");
  const format = useFormatter();
  const id = passportId(state);
  const generated = state.generated;

  const picture =
    generated !== null && generated.sealed === true ? (
      <SealedDoneBand
        file={state.sealed.file}
        bits={sketchOf(generated.passport.blockhash256)}
        title={state.title}
        registeredAt={state.registeredAt}
        saved={state.sealed.saved}
        onSaved={onSaved}
        privateCopy={state.prepared?.privateRecheck === true}
      />
    ) : generated === null ? null : (
      <div className="relative">
        {/* The pinned copy, read back through the gateway: what a verifier will fetch. */}
        <img
          src={generated.image.gatewayUrl}
          alt=""
          className={`max-h-[24rem] w-full object-cover${wideOnly(media === "only", `lg:max-h-none ${WIDE_PICTURE}`)}`}
        />
        <div className="scrim pointer-events-none absolute inset-0" />
        <p className="absolute bottom-5 start-6 font-mono text-[11px] uppercase tracking-[0.24em] text-verified">
          {t("doneLabel")}
        </p>
      </div>
    );

  if (media === "only") {
    return (
      <motion.div
        initial={{ opacity: 0, scale: 1.02 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.9, ease: [0.16, 1, 0.3, 1] }}
        className="grain relative overflow-hidden border border-line bg-bg-raised"
      >
        {picture}
      </motion.div>
    );
  }

  return (
    <motion.section
      initial={{ opacity: 0, y: 24 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
      className="grain relative overflow-hidden border border-line bg-bg-raised"
    >
      {media === "not-at-lg" ? <div className="lg:hidden">{picture}</div> : picture}

      <div className="p-6 sm:p-9">
        <h2
          className={`max-w-[20ch] font-display text-[clamp(1.8rem,3.6vw,2.9rem)] font-semibold uppercase tracking-[-0.02em] ${leading}`}
        >
          {t("doneHeading")}
        </h2>
        <p className="mt-4 max-w-[54ch] text-base leading-relaxed text-text-muted">{t("doneBody")}</p>

        <dl className="mt-8 grid gap-x-8 gap-y-5 border-t border-line pt-6 sm:grid-cols-2">
          <Row label={t("kind")} value={kinds("0")} />
          <Row label={t("agentRow")} value={generated === null ? "" : t("signatures.agentId", { id: generated.agent.id })} />
          <Row label={t("modelRow")} value={generated?.model ?? ""} mono />
          <Row label={t("title")} value={state.title} />
          {generated !== null && generated.sealed === true && !state.sealed.includePrompt ? null : (
            <Row label={t("prompt")} value={state.prompt} />
          )}
          <Row label={shared("register.passportId")} value={id ?? ""} mono />
        </dl>

        <p className="mt-6 font-mono text-[11px] text-text-faint">
          {state.registeredAt === null
            ? ""
            : format.dateTime(new Date(state.registeredAt), "moment")}
        </p>
      </div>
    </motion.section>
  );
}

function Row({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="font-mono text-[10px] uppercase tracking-[0.2em] text-text-faint">{label}</dt>
      <dd className={`mt-1.5 break-all text-sm ${mono ? "font-mono" : ""}`}>{value}</dd>
    </div>
  );
}

/**
 * The quota's reset time in the reader's own clock, not the site's UTC.
 *
 * Everything dated on this site is a chain fact and is shown in UTC so the
 * server and the browser agree. This one is neither: it is a promise about the
 * reader's day, and it only ever renders after an answer has come back in the
 * browser, so there is no server markup for it to disagree with. It names
 * the zone like every other time here, so the two clocks never look alike.
 */
function localTime(unixSeconds: number, locale: string): string {
  return new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(
    new Date(unixSeconds * 1000),
  );
}
