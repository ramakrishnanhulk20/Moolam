"use client";

import { AnimatePresence, motion } from "framer-motion";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import type { Hex } from "viem";
import { MONAD_EXPLORER, gatewayUrl, shortHex } from "@/lib/chain/client";
import { useIsReducedMotion } from "@/components/motion/useIsReducedMotion";
import { Link } from "@/lib/i18n/routing";
import {
  GENERATE_STEPS,
  isBusy,
  isRegistered,
  isStating,
  passportId,
  type RegisterState,
  type Step,
  type StepState,
} from "@/lib/studio/flow";
import { EXAMPLE_PROMPTS, PROMPT_MAX, PROMPT_MIN, atLimit } from "@/lib/studio/generate";
import { draftProblem, type ConsentDraft } from "@/components/consent/draft";
import { ConsentField } from "./ConsentField";
import { FailureNote } from "./FailureNote";
import { SealedChoice, SealedDoneBand, SealedDrawing, SealedFileCard, sketchOf } from "./SealedFile";
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
}: {
  state: RegisterState;
  /** Only for the fallback link, when a sponsored send landed without handing back a hash. */
  wallet?: Hex;
  onPrompt: (prompt: string) => void;
  onTitle: (title: string) => void;
  onConsent: (draft: ConsentDraft) => void;
  /** Register this drawing without publishing it. */
  onSealed: (on: boolean) => void;
  /** Whether the prompt joins the sealed record. Only asked once the switch is on. */
  onIncludePrompt: (include: boolean) => void;
  /** The creator has written the one copy of a sealed drawing to their own disk. */
  onSaved: () => void;
  onGenerate: () => void;
  onReset: () => void;
  onUnsponsored: () => void;
  onBind: () => void;
  onRecheck?: () => void;
}) {
  const t = useTranslations("studio.generate");
  const leading = useHeadingLeading("leading-[0.95]", "leading-[1.15]");
  const busy = isBusy(state);
  const done = isRegistered(state);
  const spent = atLimit(state.quota);
  const characters = state.prompt.trim().length;

  if (done) {
    return <Generated state={state} wallet={wallet} onReset={onReset} onSaved={onSaved} />;
  }

  return (
    <motion.section
      initial={{ opacity: 0, y: 24 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
      className="border border-line bg-bg-raised p-6 sm:p-9"
    >
      <p className="flex items-center gap-3 font-mono text-[11px] uppercase tracking-[0.24em] text-accent">
        <span className="motif h-[9px] w-[9px]" />
        {t("kicker")}
      </p>
      <h2
        className={`mt-5 max-w-[20ch] font-display text-[clamp(1.7rem,3.4vw,2.7rem)] font-semibold uppercase tracking-[-0.02em] ${leading}`}
      >
        {t("heading")}
      </h2>
      <p className="mt-4 max-w-[56ch] text-sm leading-relaxed text-text-muted">{t("body")}</p>

      <Plate state={state} />

      <label className="mt-8 block">
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
      <div className="mt-2 flex flex-wrap items-baseline justify-between gap-3">
        <p className="max-w-[52ch] text-xs leading-relaxed text-text-faint">{t("promptHint")}</p>
        <p
          className={`font-mono text-[11px] tabular-nums ${
            characters >= PROMPT_MIN ? "text-text-muted" : "text-text-faint"
          }`}
        >
          {t("counter", { count: characters, max: PROMPT_MAX })}
        </p>
      </div>

      <p className="mt-7 font-mono text-[10px] uppercase tracking-[0.2em] text-text-faint">{t("examplesLabel")}</p>
      <div className="mt-3 flex flex-col gap-2">
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

      <label className="mt-8 block">
        <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-text-faint">{t("title")}</span>
        <input
          type="text"
          value={state.title}
          maxLength={120}
          disabled={busy}
          onChange={(event) => onTitle(event.target.value)}
          placeholder={t("titlePlaceholder")}
          className="mt-2 w-full border border-line bg-bg px-4 py-3 text-base text-text outline-none transition-colors duration-200 placeholder:text-text-faint focus:border-accent"
        />
      </label>
      <p className="mt-2 text-xs text-text-faint">{t("titleHint")}</p>

      <ConsentField draft={state.consent} onChange={onConsent} disabled={busy} />

      <SealedChoice
        on={state.sealed.on}
        onChange={onSealed}
        bits={sketchOf(state.generated?.passport.blockhash256)}
        generated
        includePrompt={state.sealed.includePrompt}
        onIncludePrompt={onIncludePrompt}
        disabled={busy}
      />

      <div className="mt-8 flex flex-wrap items-center gap-5">
        <button
          type="button"
          onClick={onGenerate}
          disabled={busy || spent || characters < PROMPT_MIN || draftProblem(state.consent) !== null}
          className="w-full rounded-[8px] bg-accent px-7 py-4 text-sm font-semibold uppercase tracking-[0.14em] text-accent-ink transition-transform duration-200 hover:-translate-y-0.5 disabled:translate-y-0 disabled:opacity-50 sm:w-auto"
        >
          {t("submit")}
        </button>
        <Quota state={state} />
      </div>

      {state.sealed.file === null ? null : (
        <SealedFileCard
          file={state.sealed.file}
          bits={sketchOf(state.generated?.passport.blockhash256)}
          title={state.title}
          saved={state.sealed.saved}
          onSaved={onSaved}
        />
      )}

      <Signatures state={state} />

      <ol className="mt-9 space-y-px border-t border-line pt-1">
        {GENERATE_STEPS.map((step, index) => (
          <StepRow key={step} step={step} index={index} state={state} />
        ))}
      </ol>

      {state.failure === null ? null : (
        <div className="mt-7">
          <FailureNote
            failure={state.failure}
            passportId={passportId(state)}
            onAgain={onGenerate}
            onGenerateAgain={onGenerate}
            onBind={onBind}
            onUnsponsored={onUnsponsored}
            onRecheck={onRecheck}
          />
        </div>
      )}
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
    <p className="text-xs leading-relaxed text-text-faint">
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
function Plate({ state }: { state: RegisterState }) {
  const t = useTranslations("studio.generate");
  const reduced = useIsReducedMotion();
  const drawing = state.steps.draw === "running";
  const drawn = state.generated;
  const image = drawn?.image ?? null;
  // A kept drawing has no pinned picture to read back, so the plate holds its
  // fingerprint instead of an empty frame.
  const sealed = drawn?.sealed === true ? sketchOf(drawn.passport.blockhash256) : null;

  return (
    <div className="grain relative mt-8 min-h-[14rem] overflow-hidden border border-line-strong bg-bg-sunken">
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
            className="relative flex min-h-[14rem] flex-col justify-end gap-3 p-8 sm:p-10"
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
                <span className="inline-block h-2 w-2 animate-pulse bg-accent" />
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
            className="relative"
          >
            {/* The pinned copy, read back through the gateway: what a verifier will fetch. */}
            <img src={image.gatewayUrl} alt="" className="max-h-[26rem] w-full object-cover" />
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
      <p className="mt-2 max-w-[48ch] text-xs leading-relaxed text-text-faint">{t("body")}</p>

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
            <p className="mt-3 max-w-[34ch] text-xs leading-relaxed text-text-faint">{detail}</p>
          </motion.div>
        ) : (
          <motion.p
            key="waiting"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="mt-3 max-w-[32ch] text-xs leading-relaxed text-text-faint"
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
      <span className={`mt-0.5 font-mono text-[11px] tabular-nums ${NUMBER_TONE[tone]}`}>
        {String(index + 1).padStart(2, "0")}
      </span>
      <span aria-hidden className={`mt-1.5 h-2 w-2 shrink-0 ${MARKER_TONE[tone]}`} />
      <span className="min-w-0">
        <AnimatePresence mode="wait" initial={false}>
          <motion.span
            key={label}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.25 }}
            className={`block text-sm leading-relaxed ${LABEL_TONE[tone]}`}
          >
            {label}
          </motion.span>
        </AnimatePresence>
      </span>
    </li>
  );
}

/** The same stub the upload path ends on, with the agent named on it. */
function Generated({
  state,
  wallet,
  onReset,
  onSaved,
}: {
  state: RegisterState;
  wallet?: Hex;
  onReset: () => void;
  onSaved: () => void;
}) {
  const t = useTranslations("studio.generate");
  const shared = useTranslations("studio");
  const kinds = useTranslations("kind");
  const leading = useHeadingLeading("leading-[0.95]", "leading-[1.15]");
  const format = useFormatter();
  const id = passportId(state);
  const generated = state.generated;
  // A statement is out from the same wallet, so nothing here starts a new run.
  const stating = isStating(state);

  return (
    <motion.section
      initial={{ opacity: 0, y: 24 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
      className="grain relative overflow-hidden border border-line bg-bg-raised"
    >
      {generated !== null && generated.sealed === true ? (
        <SealedDoneBand
          file={state.sealed.file}
          bits={sketchOf(generated.passport.blockhash256)}
          title={state.title}
          registeredAt={state.registeredAt}
          saved={state.sealed.saved}
          onSaved={onSaved}
        />
      ) : generated === null ? null : (
        <div className="relative">
          {/* The pinned copy, read back through the gateway: what a verifier will fetch. */}
          <img src={generated.image.gatewayUrl} alt="" className="max-h-[24rem] w-full object-cover" />
          <div className="scrim pointer-events-none absolute inset-0" />
          <p className="absolute bottom-5 start-6 font-mono text-[11px] uppercase tracking-[0.24em] text-verified">
            {t("doneLabel")}
          </p>
        </div>
      )}

      <div className="p-6 sm:p-9">
        <h2
          className={`max-w-[20ch] font-display text-[clamp(1.8rem,3.6vw,2.9rem)] font-semibold uppercase tracking-[-0.02em] ${leading}`}
        >
          {t("doneHeading")}
        </h2>
        <p className="mt-4 max-w-[54ch] text-sm leading-relaxed text-text-muted">{t("doneBody")}</p>

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

        <div className="mt-8 flex flex-wrap items-center gap-3">
          {id === null ? null : (
            <Link
              href={`/passport/${id}`}
              className="rounded-[8px] bg-accent px-6 py-3.5 text-xs font-semibold uppercase tracking-[0.16em] text-accent-ink transition-transform duration-200 hover:-translate-y-0.5"
            >
              {shared("register.openPassport")}
            </Link>
          )}
          {generated === null ? null : (
            <Link
              href={`/agent/${generated.agent.id}`}
              className="rounded-[8px] border border-line px-5 py-3.5 text-xs uppercase tracking-[0.16em] text-text-muted transition-colors duration-200 hover:border-accent hover:text-accent"
            >
              {t("openAgent")}
            </Link>
          )}
          {state.txHash !== null ? (
            <a
              href={`${MONAD_EXPLORER}/tx/${state.txHash}`}
              target="_blank"
              rel="noreferrer"
              className="rounded-[8px] border border-line px-5 py-3.5 text-xs uppercase tracking-[0.16em] text-text-muted transition-colors duration-200 hover:border-accent hover:text-accent"
            >
              {shared("register.openTx", { hash: shortHex(state.txHash) })}
            </a>
          ) : wallet === undefined ? null : (
            <a
              href={`${MONAD_EXPLORER}/address/${wallet}`}
              target="_blank"
              rel="noreferrer"
              className="rounded-[8px] border border-line px-5 py-3.5 text-xs uppercase tracking-[0.16em] text-text-muted transition-colors duration-200 hover:border-accent hover:text-accent"
            >
              {shared("register.openAddress", { wallet: shortHex(wallet) })}
            </a>
          )}
          {generated === null || generated.sealed === true ? null : (
            <a
              href={gatewayUrl(generated.image.uri)}
              target="_blank"
              rel="noreferrer"
              className="rounded-[8px] border border-line px-5 py-3.5 text-xs uppercase tracking-[0.16em] text-text-muted transition-colors duration-200 hover:border-accent hover:text-accent"
            >
              {shared("register.openImage")}
            </a>
          )}
          <button
            type="button"
            onClick={onReset}
            disabled={stating}
            className="rounded-[8px] border border-line px-5 py-3.5 text-xs uppercase tracking-[0.16em] text-text-muted transition-colors duration-200 hover:border-accent hover:text-accent disabled:opacity-50"
          >
            {t("another")}
          </button>
        </div>

        <p className="mt-6 font-mono text-[11px] text-text-faint">
          {state.registeredAt === null
            ? ""
            : format.dateTime(new Date(state.registeredAt), { dateStyle: "medium", timeStyle: "short" })}
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
 * browser, so there is no server markup for it to disagree with.
 */
function localTime(unixSeconds: number, locale: string): string {
  return new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit" }).format(new Date(unixSeconds * 1000));
}
