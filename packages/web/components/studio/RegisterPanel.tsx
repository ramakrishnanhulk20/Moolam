"use client";

import { AnimatePresence, motion } from "framer-motion";
import { useFormatter, useTranslations } from "next-intl";
import { useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from "react";
import type { Hex } from "viem";
import {
  STEPS,
  checkImage,
  isBusy,
  isRegistered,
  passportId,
  type RegisterState,
  type Step,
  type StepState,
} from "@/lib/studio/flow";
import type { Failure } from "@/lib/studio/problems";
import { draftProblem, type ConsentDraft } from "@/components/consent/draft";
import { ConsentField } from "./ConsentField";
import { DoneActions, FailureNote } from "./afterPress";
import { SealedChoice, SealedDoneBand, SealedFileCard, sketchOf } from "./SealedFile";
import { StatusBand } from "./StatusBand";
import { hasStarted } from "./press";
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
 * The working half of the studio: one picture, one title, three steps, one
 * passport. Nothing here is hidden behind a spinner without a sentence saying
 * what is being waited on.
 */
export function RegisterPanel({
  state,
  wallet,
  receipt,
  pressing = false,
  onChoose,
  onTitle,
  onConsent,
  onSealed,
  onSaved,
  onRegister,
  onReset,
  onUnsponsored,
  onBind,
  onRecheck,
}: {
  state: RegisterState;
  /** Only for the fallback link, when a sponsored send landed without handing back a hash. */
  wallet?: Hex;
  /** The stub, which is part of this one box and sits under whatever face is showing. */
  receipt?: ReactNode;
  /** True from the moment the button is pressed until the run has actually started. */
  pressing?: boolean;
  onChoose: (file: File) => void;
  onTitle: (title: string) => void;
  onConsent: (draft: ConsentDraft) => void;
  /** Register this picture without publishing it, and whether a private copy is kept for a re-check. */
  onSealed: (on: boolean, privateRecheck?: boolean) => void;
  /** The creator has written the one copy of a sealed picture to their own disk. */
  onSaved: () => void;
  onRegister: () => void;
  onReset: () => void;
  onUnsponsored: () => void;
  onBind: () => void;
  onRecheck?: () => void;
}) {
  const t = useTranslations("studio");
  const leading = useHeadingLeading("leading-[0.95]", "leading-[1.15]");
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const [rejected, setRejected] = useState<Failure | null>(null);
  const busy = isBusy(state);
  const done = isRegistered(state);
  const wide = useWide();

  // The chosen picture is shown from the file itself, so nothing is uploaded to
  // preview it. The URL is handed back to the browser when the file changes.
  const preview = useMemo(() => (state.file === null ? null : URL.createObjectURL(state.file)), [state.file]);
  useEffect(() => () => {
    if (preview !== null) {
      URL.revokeObjectURL(preview);
    }
  }, [preview]);

  function take(file: File | undefined) {
    if (file === undefined) {
      return;
    }
    const problem = checkImage(file);
    setRejected(problem);
    if (problem === null) {
      onChoose(file);
    }
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setOver(false);
    take(event.dataTransfer.files?.[0]);
  }

  const folded = hasStarted(state);

  const sealedChoice = (
    <SealedChoice
      on={state.sealed.on}
      onChange={(on) => onSealed(on)}
      bits={sketchOf(state.prepared?.passport.blockhash256)}
      privateRecheck={state.sealed.privateRecheck === true}
      onPrivateRecheck={(keep) => onSealed(true, keep)}
      disabled={busy}
    />
  );

  // On a laptop the picture keeps the left column through the run and the done
  // screen, and the band lands in the right one, where the button was pressed.
  //
  // The done picture is mounted once and placed by CSS. A sealed one holds the
  // only copy of the file and the save link made from it, so a second hidden
  // copy was a second link to the same bytes. Below lg the face becomes one
  // column: the details column steps aside (contents) so the status band can
  // go first, then this picture, then the card it sits on top of.
  if ((done || folded) && wide) {
    return (
      <div
        data-studio-panel="upload"
        data-face={done ? "receipt" : "run"}
        data-studio-layout="wide"
        className={done ? `${WIDE_FACE} max-lg:flex max-lg:flex-col` : WIDE_FACE}
      >
        <div data-studio-column="picture" className={`${done ? "" : "hidden lg:block "}${AT_LEFT} ${WIDE_STAGE}`}>
          {done ? (
            <Registered state={state} onSaved={onSaved} media="only" />
          ) : (
            <div className="grain relative overflow-hidden border border-line-strong">
              {preview === null ? null : (
                <img src={preview} alt="" className={`w-full object-cover ${WIDE_PICTURE}`} />
              )}
              <div className="scrim pointer-events-none absolute inset-0" />
              <p className="absolute inset-x-0 bottom-0 max-w-[28ch] break-all p-5 font-mono text-[11px] text-text">
                {state.file?.name} <span className="text-text-faint">{megabytes(state.file)}</span>
              </p>
            </div>
          )}
        </div>
        <div data-studio-column="details" className={done ? `${AT_RIGHT} max-lg:contents` : AT_RIGHT}>
          <div className={`sticky top-[var(--studio-top,var(--header-h))] z-30${done ? " max-lg:order-first" : ""}`}>
            <StatusBand state={state} />
          </div>
          {done ? (
            <Registered state={state} onSaved={onSaved} media="none" />
          ) : (
            <Run
              state={state}
              onRegister={onRegister}
              onBind={onBind}
              onUnsponsored={onUnsponsored}
              onRecheck={onRecheck}
              onSaved={onSaved}
            />
          )}
        </div>
        <div className={ACROSS}>{receipt}</div>
        {done ? (
          <div className={UNDER_RIGHT}>
            <DoneActions state={state} wallet={wallet} onReset={onReset} />
          </div>
        ) : null}
      </div>
    );
  }

  if (done || folded) {
    return (
      <div data-studio-panel="upload" data-face={done ? "receipt" : "run"}>
        <div className="sticky top-[var(--studio-top,var(--header-h))] z-30">
          <StatusBand state={state} />
        </div>
        {done ? (
          <Registered state={state} onSaved={onSaved} />
        ) : (
          <Run
            state={state}
            onRegister={onRegister}
            onBind={onBind}
            onUnsponsored={onUnsponsored}
            onRecheck={onRecheck}
            onSaved={onSaved}
          />
        )}
        {receipt}
        {done ? <DoneActions state={state} wallet={wallet} onReset={onReset} /> : null}
      </div>
    );
  }

  return (
    <div data-studio-panel="upload" data-face="form" data-studio-layout={wide ? "wide" : undefined}>
    <motion.section
      initial={{ opacity: 0, y: 24 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
      className={`border border-line bg-bg-raised p-6 sm:p-9${wideOnly(wide, `${WIDE_COLUMNS} lg:p-7 xl:p-8`)}`}
    >
      <WideColumn wide={wide} name="picture" className={WIDE_STAGE}>
      <p className="flex items-center gap-3 font-mono text-[11px] uppercase tracking-[0.24em] text-accent">
        <span className="motif h-[9px] w-[9px]" />
        {t("register.kicker")}
      </p>
      <h2
        className={`mt-5 max-w-[22ch] font-display text-[clamp(1.7rem,3.4vw,2.7rem)] font-semibold uppercase tracking-[-0.02em] ${leading}${wideOnly(
          wide,
          WIDE_CARD_HEADING,
        )}`}
      >
        {t("register.heading")}
      </h2>
      <p className={`mt-4 max-w-[56ch] text-sm leading-relaxed text-text-muted${wideOnly(wide, "lg:mt-2")}`}>{t("register.body")}</p>

      <input
        ref={input}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        className="hidden"
        onChange={(event) => take(event.target.files?.[0])}
      />

      <div
        data-studio-picture
        onDragOver={(event) => {
          event.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
        className={`grain relative mt-8 overflow-hidden border border-dashed${wideOnly(wide, "lg:mt-6")} transition-colors duration-200 ${
          over ? "border-accent bg-accent-soft" : "border-line-strong"
        }${wideOnly(wide, WIDE_PICTURE)}`}
      >
        {preview === null ? (
          <div className={`flex flex-col items-start gap-4 p-8 sm:p-12${wideOnly(wide, "lg:h-full lg:justify-end")}`}>
            <p className="max-w-[40ch] font-display text-[clamp(1.2rem,2.2vw,1.7rem)] leading-[1.2] tracking-[-0.02em]">
              {t("register.drop")}
            </p>
            <button
              type="button"
              onClick={() => input.current?.click()}
              disabled={busy}
              className="rounded-[8px] border border-line px-5 py-3 text-[11px] uppercase tracking-[0.2em] text-text-muted transition-colors duration-200 hover:border-accent hover:text-accent disabled:opacity-60"
            >
              {t("register.choose")}
            </button>
            <p className="max-w-[46ch] text-xs leading-relaxed text-text-faint">{t("register.hint")}</p>
          </div>
        ) : (
          <div className={`relative${wideOnly(wide, "lg:h-full")}`}>
            {/* The creator's own upload, shown before it is signed. */}
            <img src={preview} alt="" className={`max-h-[22rem] w-full object-cover${wideOnly(wide, "lg:h-full lg:max-h-none")}`} />
            <div className="scrim pointer-events-none absolute inset-0" />
            <div className="absolute inset-x-0 bottom-0 flex flex-wrap items-end justify-between gap-3 p-5">
              <p className="max-w-[28ch] break-all font-mono text-[11px] text-text">
                {state.file?.name} <span className="text-text-faint">{megabytes(state.file)}</span>
              </p>
              <button
                type="button"
                onClick={() => input.current?.click()}
                disabled={busy}
                className="rounded-[8px] border border-line-strong bg-bg/70 px-4 py-2 text-[10px] uppercase tracking-[0.18em] text-text backdrop-blur transition-colors duration-200 hover:border-accent hover:text-accent disabled:opacity-60"
              >
                {t("register.replace")}
              </button>
            </div>
          </div>
        )}
      </div>

      {rejected === null ? null : (
        <div className="mt-6">
          <FailureNote failure={rejected} onAgain={() => setRejected(null)} />
        </div>
      )}

      <label className={`mt-8 block${wideOnly(wide, "lg:mt-6")}`}>
        <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-text-faint">{t("register.title")}</span>
        <input
          type="text"
          value={state.title}
          maxLength={120}
          disabled={busy}
          onChange={(event) => onTitle(event.target.value)}
          placeholder={t("register.titlePlaceholder")}
          className="mt-2 w-full border border-line bg-bg px-4 py-3 text-base text-text outline-none transition-colors duration-200 placeholder:text-text-faint focus:border-accent"
        />
      </label>
      <p data-title-hint className="mt-2 text-xs text-text-faint">{t("register.titleHint")}</p>
      {/* On a laptop the picture, its name and whether it is published are one
          column, so the right one is the AI-use choice and the press. */}
      {wide ? <div className="hidden lg:block">{sealedChoice}</div> : null}
      </WideColumn>

      <WideColumn wide={wide} name="details">
      <ConsentField draft={state.consent} onChange={onConsent} disabled={busy} />

      {wide ? <div className="lg:hidden">{sealedChoice}</div> : sealedChoice}

      {/* The press is answered here before anything else moves: the label turns
          into the first line of the run and the button goes quiet. The room for
          two lines is held from the start, because a button that grows under the
          thumb moves the whole page with it. */}
      <button
        type="button"
        onClick={onRegister}
        disabled={pressing || busy || state.file === null || draftProblem(state.consent) !== null}
        data-press
        className={`mt-8 flex min-h-[4.5rem] w-full items-center justify-center rounded-[8px] bg-accent px-7 py-4 text-center text-sm font-semibold text-accent-ink transition-transform duration-200 hover:-translate-y-0.5 disabled:translate-y-0 disabled:opacity-60 sm:inline-flex sm:min-h-0 sm:w-auto ${
          pressing ? "normal-case" : "uppercase tracking-[0.14em]"
        }${wideOnly(wide, "lg:mt-6 lg:flex lg:w-full")}`}
      >
        {pressing ? t("register.steps.prepare.running") : t("register.submit")}
      </button>

      {/* What the press is about to do, in the same three lines the run itself
          uses. A creator should be able to read the whole of it before they
          start, which is the one thing a folded run cannot show them. */}
      <ol className="mt-9 space-y-px border-t border-line pt-1">
        {STEPS.map((step, index) => (
          <StepRow key={step} step={step} index={index} state={state} />
        ))}
      </ol>

      {state.failure === null ? null : (
        <div className="mt-7">
          <FailureNote
            failure={state.failure}
            passportId={passportId(state)}
            onAgain={onRegister}
            onBind={onBind}
            onUnsponsored={onUnsponsored}
            onRecheck={onRecheck}
          />
        </div>
      )}
      </WideColumn>
    </motion.section>
    {receipt}
    </div>
  );
}

/**
 * What the box holds while the run is out: the three steps, the one copy of a
 * sealed picture, and whatever went wrong.
 *
 * The form is gone by now and the band above carries the name, so this is only
 * the progress. The rows keep the place they had at the foot of the form, which
 * is where a creator already looks for them.
 */
function Run({
  state,
  onRegister,
  onBind,
  onUnsponsored,
  onRecheck,
  onSaved,
}: {
  state: RegisterState;
  onRegister: () => void;
  onBind: () => void;
  onUnsponsored: () => void;
  onRecheck?: () => void;
  onSaved: () => void;
}) {
  return (
    <motion.section
      initial={{ opacity: 0, y: 18 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.55, delay: 0.08, ease: [0.16, 1, 0.3, 1] }}
      className="border border-line bg-bg-raised p-6 sm:p-9"
    >
      <ol className="space-y-px">
        {STEPS.map((step, index) => (
          <StepRow key={step} step={step} index={index} state={state} />
        ))}
      </ol>

      {state.sealed.file === null ? null : (
        <SealedFileCard
          file={state.sealed.file}
          bits={sketchOf(state.prepared?.passport.blockhash256)}
          title={state.title}
          saved={state.sealed.saved}
          onSaved={onSaved}
          privateCopy={state.prepared?.privateRecheck === true}
        />
      )}

      {state.failure === null ? null : (
        <div className="mt-7">
          <FailureNote
            failure={state.failure}
            passportId={passportId(state)}
            onAgain={onRegister}
            onBind={onBind}
            onUnsponsored={onUnsponsored}
            onRecheck={onRecheck}
          />
        </div>
      )}
    </motion.section>
  );
}

/** What a row is painted as, which is not always what the reducer stored. */
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
  const t = useTranslations("studio");
  const status = state.steps[step];

  // A send that ran out of patience is not a send that failed. The transaction
  // was accepted and may still land, so the row waits in the muted ink with a
  // hollow marker. The red is kept for the sends that really did not make it.
  const tone: Tone = status === "unconfirmed" ? "pending" : status;

  // Once the send is out, the wait is no longer about sending: it is about
  // Monad showing the passport, which is the thing actually being watched.
  const label =
    step === "send" && status === "running" && state.confirming
      ? t("register.steps.send.watching")
      : tone === "pending"
        ? t("register.steps.send.pending")
        : t(`register.steps.${step}.${status}`);

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

/**
 * The done screen. Under the wide layout it is drawn in two parts: the picture
 * alone in the left column, and the words without it on the right. Below lg the
 * two stack and join into the one card a phone always read.
 */
function Registered({
  state,
  onSaved,
  media,
}: {
  state: RegisterState;
  onSaved: () => void;
  media?: "only" | "none";
}) {
  const t = useTranslations("studio");
  const leading = useHeadingLeading("leading-[0.95]", "leading-[1.15]");
  const format = useFormatter();
  const id = passportId(state);
  const prepared = state.prepared;
  // The answer decides, not the switch: what was registered is what came back.
  const sealed = prepared !== null && prepared.sealed === true;

  const picture = sealed ? (
    <SealedDoneBand
      file={state.sealed.file}
      bits={sketchOf(prepared?.passport.blockhash256)}
      title={state.title}
      registeredAt={state.registeredAt}
      saved={state.sealed.saved}
      onSaved={onSaved}
      privateCopy={state.prepared?.privateRecheck === true}
    />
  ) : prepared === null || prepared.sealed === true ? null : (
    <div className="relative">
      {/* The pinned copy, read back through the gateway: what a verifier will fetch. */}
      <img
        src={prepared.image.gatewayUrl}
        alt=""
        className={`max-h-[24rem] w-full object-cover${wideOnly(media === "only", `lg:max-h-none ${WIDE_PICTURE}`)}`}
      />
      <div className="scrim pointer-events-none absolute inset-0" />
      <p className="absolute bottom-5 start-6 font-mono text-[11px] uppercase tracking-[0.24em] text-verified">
        {t("register.doneLabel")}
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
      className={`grain relative overflow-hidden border border-line bg-bg-raised${wideOnly(media === "none", "max-lg:border-t-0")}`}
    >
      {media === "none" ? null : picture}

      <div className="p-6 sm:p-9">
        <h2 className={`max-w-[20ch] font-display text-[clamp(1.8rem,3.6vw,2.9rem)] font-semibold uppercase tracking-[-0.02em] ${leading}`}>
          {t("register.doneHeading")}
        </h2>
        <p className="mt-4 max-w-[54ch] text-sm leading-relaxed text-text-muted">{t("register.doneBody")}</p>

        <dl className="mt-8 grid gap-x-8 gap-y-5 border-t border-line pt-6 sm:grid-cols-2">
          <Row label={t("register.passportId")} value={id ?? ""} mono />
          <Row
            label={t("register.block")}
            value={state.block === null ? t("register.blockPending") : state.block.toString()}
            mono={state.block !== null}
          />
          <Row
            label={t("register.when")}
            value={
              state.registeredAt === null
                ? ""
                : format.dateTime(new Date(state.registeredAt), { dateStyle: "medium", timeStyle: "short" })
            }
          />
          <Row label={t("register.fee")} value={state.unsponsored ? t("register.feeOwn") : t("register.feeSponsored")} />
        </dl>
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

function megabytes(file: File | null): string {
  return file === null ? "" : `${(file.size / 1_000_000).toFixed(1)} MB`;
}
