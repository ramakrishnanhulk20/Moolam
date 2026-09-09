"use client";

import { AnimatePresence, motion } from "framer-motion";
import { useFormatter, useTranslations } from "next-intl";
import { useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { MONAD_EXPLORER, gatewayUrl, shortHex } from "@/lib/chain/client";
import { Link } from "@/lib/i18n/routing";
import { STEPS, checkImage, isBusy, isRegistered, passportId, type RegisterState, type Step } from "@/lib/studio/flow";
import type { Failure } from "@/lib/studio/problems";
import { FailureNote } from "./FailureNote";
import { useHeadingLeading } from "./leading";

/**
 * The working half of the studio: one picture, one title, three steps, one
 * passport. Nothing here is hidden behind a spinner without a sentence saying
 * what is being waited on.
 */
export function RegisterPanel({
  state,
  onChoose,
  onTitle,
  onRegister,
  onReset,
  onUnsponsored,
  onBind,
}: {
  state: RegisterState;
  onChoose: (file: File) => void;
  onTitle: (title: string) => void;
  onRegister: () => void;
  onReset: () => void;
  onUnsponsored: () => void;
  onBind: () => void;
}) {
  const t = useTranslations("studio");
  const leading = useHeadingLeading("leading-[0.95]", "leading-[1.15]");
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const [rejected, setRejected] = useState<Failure | null>(null);
  const busy = isBusy(state);
  const done = isRegistered(state);

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

  if (done) {
    return <Registered state={state} onReset={onReset} />;
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
        {t("register.kicker")}
      </p>
      <h2 className={`mt-5 max-w-[22ch] font-display text-[clamp(1.7rem,3.4vw,2.7rem)] font-semibold uppercase tracking-[-0.02em] ${leading}`}>
        {t("register.heading")}
      </h2>
      <p className="mt-4 max-w-[56ch] text-sm leading-relaxed text-text-muted">{t("register.body")}</p>

      <input
        ref={input}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        className="hidden"
        onChange={(event) => take(event.target.files?.[0])}
      />

      <div
        onDragOver={(event) => {
          event.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
        className={`grain relative mt-8 overflow-hidden border border-dashed transition-colors duration-200 ${
          over ? "border-accent bg-accent-soft" : "border-line-strong"
        }`}
      >
        {preview === null ? (
          <div className="flex flex-col items-start gap-4 p-8 sm:p-12">
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
          <div className="relative">
            {/* The creator's own upload, shown before it is signed. */}
            <img src={preview} alt="" className="max-h-[22rem] w-full object-cover" />
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

      <label className="mt-8 block">
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
      <p className="mt-2 text-xs text-text-faint">{t("register.titleHint")}</p>

      <button
        type="button"
        onClick={onRegister}
        disabled={busy || state.file === null}
        className="mt-8 w-full rounded-[8px] bg-accent px-7 py-4 text-sm font-semibold uppercase tracking-[0.14em] text-accent-ink transition-transform duration-200 hover:-translate-y-0.5 disabled:translate-y-0 disabled:opacity-50 sm:w-auto"
      >
        {t("register.submit")}
      </button>

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
          />
        </div>
      )}
    </motion.section>
  );
}

function StepRow({ step, index, state }: { step: Step; index: number; state: RegisterState }) {
  const t = useTranslations("studio");
  const status = state.steps[step];

  return (
    <li className="flex items-start gap-5 py-4">
      <span
        className={`mt-0.5 font-mono text-[11px] tabular-nums ${
          status === "waiting" ? "text-text-faint" : status === "failed" ? "text-failed" : "text-accent"
        }`}
      >
        {String(index + 1).padStart(2, "0")}
      </span>
      <span
        aria-hidden
        className={`mt-1.5 h-2 w-2 shrink-0 ${
          status === "done"
            ? "bg-verified"
            : status === "failed"
              ? "bg-failed"
              : status === "running"
                ? "animate-pulse bg-accent"
                : "bg-line-strong"
        }`}
      />
      <span className="min-w-0">
        <AnimatePresence mode="wait" initial={false}>
          <motion.span
            key={status}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.25 }}
            className={`block text-sm leading-relaxed ${
              status === "waiting" ? "text-text-faint" : status === "done" ? "text-verified" : "text-text"
            }`}
          >
            {t(`register.steps.${step}.${status}`)}
          </motion.span>
        </AnimatePresence>
      </span>
    </li>
  );
}

function Registered({ state, onReset }: { state: RegisterState; onReset: () => void }) {
  const t = useTranslations("studio");
  const leading = useHeadingLeading("leading-[0.95]", "leading-[1.15]");
  const format = useFormatter();
  const id = passportId(state);

  return (
    <motion.section
      initial={{ opacity: 0, y: 24 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
      className="grain relative overflow-hidden border border-line bg-bg-raised"
    >
      {state.prepared === null ? null : (
        <div className="relative">
          {/* The pinned copy, read back through the gateway: what a verifier will fetch. */}
          <img
            src={state.prepared.image.gatewayUrl}
            alt=""
            className="max-h-[24rem] w-full object-cover"
          />
          <div className="scrim pointer-events-none absolute inset-0" />
          <p className="absolute bottom-5 start-6 font-mono text-[11px] uppercase tracking-[0.24em] text-verified">
            {t("register.doneLabel")}
          </p>
        </div>
      )}

      <div className="p-6 sm:p-9">
        <h2 className={`max-w-[20ch] font-display text-[clamp(1.8rem,3.6vw,2.9rem)] font-semibold uppercase tracking-[-0.02em] ${leading}`}>
          {t("register.doneHeading")}
        </h2>
        <p className="mt-4 max-w-[54ch] text-sm leading-relaxed text-text-muted">{t("register.doneBody")}</p>

        <dl className="mt-8 grid gap-x-8 gap-y-5 border-t border-line pt-6 sm:grid-cols-2">
          <Row label={t("register.passportId")} value={id ?? ""} mono />
          <Row label={t("register.block")} value={state.block === null ? "" : state.block.toString()} mono />
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

        <div className="mt-8 flex flex-wrap items-center gap-3">
          {id === null ? null : (
            <Link
              href={`/passport/${id}`}
              className="rounded-[8px] bg-accent px-6 py-3.5 text-xs font-semibold uppercase tracking-[0.16em] text-accent-ink transition-transform duration-200 hover:-translate-y-0.5"
            >
              {t("register.openPassport")}
            </Link>
          )}
          {state.txHash === null ? null : (
            <a
              href={`${MONAD_EXPLORER}/tx/${state.txHash}`}
              target="_blank"
              rel="noreferrer"
              className="rounded-[8px] border border-line px-5 py-3.5 text-xs uppercase tracking-[0.16em] text-text-muted transition-colors duration-200 hover:border-accent hover:text-accent"
            >
              {t("register.openTx", { hash: shortHex(state.txHash) })}
            </a>
          )}
          {state.prepared === null ? null : (
            <a
              href={gatewayUrl(state.prepared.image.uri)}
              target="_blank"
              rel="noreferrer"
              className="rounded-[8px] border border-line px-5 py-3.5 text-xs uppercase tracking-[0.16em] text-text-muted transition-colors duration-200 hover:border-accent hover:text-accent"
            >
              {t("register.openImage")}
            </a>
          )}
          <button
            type="button"
            onClick={onReset}
            className="rounded-[8px] border border-line px-5 py-3.5 text-xs uppercase tracking-[0.16em] text-text-muted transition-colors duration-200 hover:border-accent hover:text-accent"
          >
            {t("register.another")}
          </button>
        </div>
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
