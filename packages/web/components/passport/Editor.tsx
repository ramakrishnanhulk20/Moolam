"use client";

import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useFormatter, useTranslations } from "next-intl";
import { useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import type { Hex } from "viem";
import { MONAD_EXPLORER, shortHex } from "@/lib/chain/client";
import { HEX_MARK, withHex } from "@/components/agents/hex";
import { Link, useRouter } from "@/lib/i18n/routing";
import {
  EDIT_STEPS,
  NOTE_LIMIT,
  isEditBusy,
  isEditDone,
  isEditOutstanding,
  isEditPending,
  type EditFailure,
  type EditState,
  type EditStep,
  type StepState,
} from "@/lib/passport/edit";
import { refreshPassport } from "@/lib/passport/refresh";
import { useEditPassport, type PassportEdit } from "@/lib/passport/useEditPassport";
import { Mono } from "./Mono";
import { WarningMark } from "@/components/WarningMark";

/**
 * The owner's panel itself, in a file of its own so that nothing on a passport page reaches the
 * wallet SDK until this component is asked for. EditPanel.tsx holds the gate and pulls this in.
 */
export function Editor({ parentId, owner, sealed = false }: { parentId: Hex; owner: Hex | null; sealed?: boolean }) {
  const router = useRouter();
  // The tree above this panel is rendered on the server from the chain, so once the child is on
  // chain the page is asked to read itself again rather than being patched in the browser. The
  // page is held for a minute, so what is held about this passport goes first: without that the
  // re-read would hand the creator back the same tree, with no sign of the edit they just made.
  const edit = useEditPassport({
    parentId,
    owner,
    onLanded: async () => {
      await refreshPassport(parentId);
      router.refresh();
    },
  });

  if (!edit.ready || !edit.isOwner) {
    return null;
  }

  return <Panel edit={edit} sealed={sealed} />;
}

function Panel({ edit, sealed }: { edit: PassportEdit; sealed: boolean }) {
  const t = useTranslations("passport.edit");
  const sealedWords = useTranslations("passport.sealed");
  const calm = useReducedMotion() === true;
  const { state } = edit;

  return (
    <motion.section
      initial={calm ? false : { opacity: 0, y: 28 }}
      whileInView={calm ? undefined : { opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-60px" }}
      transition={{ duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
      data-edit-panel
      className="relative mt-14 border border-s-2 border-line border-s-accent bg-bg-raised p-6 sm:p-8"
    >
      <p className="flex items-center gap-3 font-mono text-[11px] uppercase tracking-[0.24em] text-accent">
        <span className="motif h-[9px] w-[9px]" />
        {t("kicker")}
      </p>
      <h2 className="mt-5 max-w-[18ch] font-display text-[clamp(1.5rem,3vw,2.3rem)] font-semibold uppercase leading-[1.02] tracking-[-0.03em]">
        {t("heading")}
      </h2>

      {/* An edit is a new picture registered from this one, and the service has
          to read the picture to make it. A sealed passport has none to read, so
          the holder is told that in one line and the drop zone is not drawn. */}
      {sealed ? (
        <p className="mt-5 max-w-[48ch] text-base leading-relaxed text-text-muted">{sealedWords("edit")}</p>
      ) : !edit.configured ? (
        <p className="mt-5 max-w-[48ch] text-base leading-relaxed text-text-muted">{t("notConfigured")}</p>
      ) : isEditDone(state) ? (
        <Recorded edit={edit} />
      ) : edit.granted ? (
        <AddEdit edit={edit} />
      ) : (
        <AskForSigner edit={edit} />
      )}
    </motion.section>
  );
}

/** State one: what a signer is, in one sentence, and the button that asks Privy for it. */
function AskForSigner({ edit }: { edit: PassportEdit }) {
  const t = useTranslations("passport.edit");

  return (
    <div className="mt-5">
      <p className="max-w-[50ch] text-base leading-relaxed text-text-muted">{t("signer.what")}</p>
      <p className="mt-4 max-w-[50ch] border-s-2 border-line ps-4 text-base leading-relaxed text-text-faint">
        {t("signer.policy")}
      </p>

      <button
        type="button"
        onClick={() => void edit.actions.grant()}
        disabled={edit.granting}
        className="mt-7 w-full rounded-[8px] bg-accent px-6 py-3.5 text-xs font-semibold uppercase tracking-[0.16em] text-accent-ink transition-transform duration-200 hover:-translate-y-0.5 disabled:translate-y-0 disabled:opacity-60 sm:w-auto"
      >
        {t("signer.grant")}
      </button>

      {edit.granting ? (
        <p role="status" className="mt-4 flex items-center gap-3 font-mono text-[11px] uppercase tracking-[0.16em] text-pending">
          <span aria-hidden className="motif h-2 w-2 bg-pending motion-safe:animate-pulse" />
          {t("signer.granting")}
        </p>
      ) : null}

      {edit.grantFailure === null ? null : (
        <div className="mt-6">
          <FailureLine failure={edit.grantFailure} edit={edit} />
        </div>
      )}
    </div>
  );
}

/** State two: the edited picture, what changed, and the two steps it takes to land. */
function AddEdit({ edit }: { edit: PassportEdit }) {
  const t = useTranslations("passport.edit");
  const common = useTranslations("common");
  const { state } = edit;
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const busy = isEditBusy(state);
  // An edit that may be on the network keeps the send closed, even between one look at the chain
  // and the next, because a second send of the same picture is the one thing that cannot be undone.
  const outstanding = isEditOutstanding(state);

  // The chosen picture is drawn from the file itself, so nothing is uploaded to preview it.
  const preview = useMemo(() => (state.file === null ? null : URL.createObjectURL(state.file)), [state.file]);
  useEffect(
    () => () => {
      if (preview !== null) {
        URL.revokeObjectURL(preview);
      }
    },
    [preview],
  );

  function take(file: File | undefined) {
    if (file !== undefined) {
      edit.actions.choose(file);
    }
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setOver(false);
    take(event.dataTransfer.files?.[0]);
  }

  return (
    <div className="mt-5">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <p className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.2em] text-verified">
          <span aria-hidden className="motif h-2 w-2 bg-verified" />
          {t("signer.granted")}
        </p>
        <button
          type="button"
          onClick={() => void edit.actions.revoke()}
          disabled={edit.revoking || busy}
          className="font-mono text-[10px] uppercase tracking-[0.2em] text-text-faint underline decoration-line underline-offset-4 transition-colors duration-200 hover:text-accent disabled:opacity-60"
        >
          {edit.revoking ? t("signer.revoking") : t("signer.revoke")}
        </button>
      </div>
      <p className="mt-3 max-w-[50ch] text-base leading-relaxed text-text-muted">{t("body")}</p>

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
        className={`grain relative mt-7 overflow-hidden border border-dashed transition-colors duration-200 ${
          over ? "border-accent bg-accent-soft" : "border-line-strong"
        }`}
      >
        {preview === null ? (
          <div className="flex flex-col items-start gap-4 p-7 sm:p-9">
            <p className="max-w-[26ch] font-display text-[clamp(1.1rem,2vw,1.5rem)] leading-[1.15] tracking-[-0.02em]">
              {t("form.drop")}
            </p>
            <button
              type="button"
              onClick={() => input.current?.click()}
              disabled={busy}
              className="rounded-[8px] border border-line px-5 py-3 text-[11px] uppercase tracking-[0.2em] text-text-muted transition-colors duration-200 hover:border-accent hover:text-accent disabled:opacity-60"
            >
              {t("form.choose")}
            </button>
            <p className="max-w-[44ch] text-base leading-relaxed text-text-faint">{t("form.hint")}</p>
          </div>
        ) : (
          <div className="relative">
            {/* The owner's edited file, shown before anything is pinned, in a box
                of fixed height so the form under it stays put while it decodes. */}
            <img
              src={preview}
              alt={editPictureAlt(state.title, state.file?.name ?? common("registeredPicture"))}
              className="block h-64 w-full object-cover sm:h-[18rem]"
            />
            <div className="scrim pointer-events-none absolute inset-0" />
            <div className="absolute inset-x-0 bottom-0 flex flex-wrap items-end justify-between gap-3 p-4">
              <p className="max-w-[24ch] break-all font-mono text-[11px] text-text">
                {state.file?.name} <span className="text-text-faint">{megabytes(state.file)}</span>
              </p>
              <button
                type="button"
                onClick={() => input.current?.click()}
                disabled={busy}
                className="rounded-[8px] border border-line-strong bg-bg/70 px-4 py-2 text-[10px] uppercase tracking-[0.18em] text-text backdrop-blur transition-colors duration-200 hover:border-accent hover:text-accent disabled:opacity-60"
              >
                {t("form.replace")}
              </button>
            </div>
          </div>
        )}
      </div>

      <label className="mt-7 block">
        <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-text-faint">{t("form.title")}</span>
        <input
          type="text"
          value={state.title}
          maxLength={120}
          disabled={busy}
          onChange={(event) => edit.actions.setTitle(event.target.value)}
          placeholder={t("form.titlePlaceholder")}
          className="mt-2 w-full border border-line bg-bg px-4 py-3 text-base text-text outline-none transition-colors duration-200 placeholder:text-text-faint focus:border-accent"
        />
      </label>

      <label className="mt-6 block">
        <span className="flex flex-wrap items-baseline justify-between gap-2 font-mono text-[10px] uppercase tracking-[0.2em] text-text-faint">
          {t("form.note")}
          <span className="tabular-nums">{t("form.noteLeft", { left: NOTE_LIMIT - state.note.length })}</span>
        </span>
        <textarea
          value={state.note}
          maxLength={NOTE_LIMIT}
          rows={3}
          disabled={busy}
          onChange={(event) => edit.actions.setNote(event.target.value)}
          placeholder={t("form.notePlaceholder")}
          className="mt-2 w-full resize-none border border-line bg-bg px-4 py-3 text-base leading-relaxed text-text outline-none transition-colors duration-200 placeholder:text-text-faint focus:border-accent"
        />
      </label>
      <p className="mt-2 text-base leading-relaxed text-text-faint">{t("form.noteHint", { limit: NOTE_LIMIT })}</p>

      <button
        type="button"
        onClick={() => void edit.actions.submit()}
        disabled={busy || outstanding || state.file === null || state.title.trim().length === 0}
        className="mt-7 w-full rounded-[8px] bg-accent px-6 py-3.5 text-xs font-semibold uppercase tracking-[0.16em] text-accent-ink transition-transform duration-200 hover:-translate-y-0.5 disabled:translate-y-0 disabled:opacity-50 sm:w-auto"
      >
        {t("form.submit")}
      </button>

      {state.quota === null ? null : (
        <p className="mt-3 font-mono text-[10px] uppercase tracking-[0.2em] text-text-faint">
          {t("allowance", { used: state.quota.used, limit: state.quota.limit })}
        </p>
      )}

      <ol className="mt-8 space-y-px border-t border-line pt-1">
        {EDIT_STEPS.map((step, index) => (
          <StepRow key={step} step={step} index={index} state={state} />
        ))}
      </ol>

      {state.failure === null ? null : (
        <div className="mt-6">
          <FailureLine failure={state.failure} edit={edit} />
        </div>
      )}
    </div>
  );
}

/** The receipt: the child passport, the block it landed in, and where to read it. */
function Recorded({ edit }: { edit: PassportEdit }) {
  const t = useTranslations("passport.edit");
  // The studio's own sentences, so an edit and a first registration say the same thing about a
  // camera's record.
  const receipt = useTranslations("studio.receipt");
  const common = useTranslations("common");
  const format = useFormatter();
  const { state } = edit;
  const child = state.result?.child.exactHash ?? null;
  const camera = state.result?.manifest?.cameraRecord;

  return (
    <div className="mt-5">
      {state.result === null ? null : (
        <div className="grain relative overflow-hidden border border-line">
          {/* The pinned copy, read back through the gateway: what a verifier will fetch. */}
          <img
            src={state.result.image.gatewayUrl}
            alt={editPictureAlt(state.title, common("registeredPicture"))}
            className="block h-64 w-full object-cover sm:h-[18rem]"
          />
          <div className="scrim pointer-events-none absolute inset-0" />
          <p className="absolute bottom-4 start-5 font-mono text-[11px] uppercase tracking-[0.24em] text-verified">
            {t("done.label")}
          </p>
        </div>
      )}

      <p className="mt-6 max-w-[50ch] text-base leading-relaxed text-text-muted">{t("done.body")}</p>
      {camera === undefined ? null : (
        <p data-camera-record={camera} className="mt-3 max-w-[50ch] text-base leading-relaxed text-text-muted">
          {camera === "kept"
            ? receipt("cameraKept")
            : camera === "credentials-kept"
              ? receipt("credentialsKept")
              : receipt("cameraDropped")}
        </p>
      )}

      <dl className="mt-6 grid gap-x-8 gap-y-5 border-t border-line pt-5 sm:grid-cols-2">
        <div className="min-w-0">
          <dt className="font-mono text-[10px] uppercase tracking-[0.2em] text-text-faint">{t("done.child")}</dt>
          <dd className="mt-1.5 text-sm">
            {child === null ? null : (
              <Link href={`/passport/${child}`} className="transition-colors duration-200 hover:text-accent">
                <Mono value={child} className="text-sm" />
              </Link>
            )}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="font-mono text-[10px] uppercase tracking-[0.2em] text-text-faint">{t("done.block")}</dt>
          <dd className="mt-1.5 font-mono text-sm">
            {state.block === null ? t("done.blockPending") : state.block.toString()}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="font-mono text-[10px] uppercase tracking-[0.2em] text-text-faint">{t("done.fee")}</dt>
          <dd className="mt-1.5 text-base leading-relaxed text-text-muted">
            {state.result?.sponsored === true ? t("done.feeSponsored") : t("done.feeOwn")}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="font-mono text-[10px] uppercase tracking-[0.2em] text-text-faint">{t("done.edits")}</dt>
          <dd className="mt-1.5 font-mono text-sm tabular-nums">
            {state.total === null ? t("done.blockPending") : state.total}
          </dd>
        </div>
      </dl>

      {state.quota === null ? null : (
        <p className="mt-5 font-mono text-[10px] uppercase tracking-[0.2em] text-text-faint">
          {t("allowance", { used: state.quota.used, limit: state.quota.limit })}{" "}
          {t("done.resets", {
            at: format.dateTime(new Date(state.quota.resetsAt * 1000), "time"),
          })}
        </p>
      )}

      <div className="mt-7 flex flex-wrap items-center gap-3">
        {child === null ? null : (
          <Link
            href={`/passport/${child}`}
            className="rounded-[8px] bg-accent px-5 py-3 text-xs font-semibold uppercase tracking-[0.16em] text-accent-ink transition-transform duration-200 hover:-translate-y-0.5"
          >
            {t("done.open")}
          </Link>
        )}
        {state.result === null ? null : (
          <a
            href={`${MONAD_EXPLORER}/tx/${state.result.hash}`}
            target="_blank"
            rel="noreferrer"
            className="rounded-[8px] border border-line px-5 py-3 text-xs uppercase tracking-[0.16em] text-text-muted transition-colors duration-200 hover:border-accent hover:text-accent"
          >
            {withHex(t("done.openTx", { hash: HEX_MARK }), shortHex(state.result.hash))}
          </a>
        )}
        <button
          type="button"
          onClick={edit.actions.reset}
          className="rounded-[8px] border border-line px-5 py-3 text-xs uppercase tracking-[0.16em] text-text-muted transition-colors duration-200 hover:border-accent hover:text-accent"
        >
          {t("done.another")}
        </button>
      </div>
    </div>
  );
}

/** What a row is painted as, which is not always what the reducer stored. */
type Tone = StepState | "pending";

export const NUMBER_TONE: Record<Tone, string> = {
  waiting: "text-text-faint",
  running: "text-pending",
  done: "text-verified",
  failed: "text-failed",
  pending: "text-text-muted",
};

export const MARKER_TONE: Record<Tone, string> = {
  waiting: "bg-line-strong",
  running: "motion-safe:animate-pulse bg-pending",
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

function StepRow({ step, index, state }: { step: EditStep; index: number; state: EditState }) {
  const t = useTranslations("passport.edit");
  const status = state.steps[step];

  // A send that ran out of patience, or one the service handed to Privy and could not confirm, is
  // not a send that failed. It may still land, so the row waits in the muted ink with a hollow
  // marker rather than turning red.
  const tone: Tone = step === "send" && status === "failed" && isEditPending(state.failure) ? "pending" : status;

  const label =
    step === "send" && status === "running" && state.confirming
      ? t("steps.send.watching")
      : tone === "pending"
        ? t("steps.send.pending")
        : t(`steps.${step}.${status}`);

  return (
    <li data-step={step} data-tone={tone} className="flex items-start gap-4 py-3.5">
      <span className={`mt-0.5 font-mono text-[11px] tabular-nums ${NUMBER_TONE[tone]}`}>
        {String(index + 1).padStart(2, "0")}
      </span>
      <span aria-hidden className={`motif mt-1.5 h-2 w-2 shrink-0 ${MARKER_TONE[tone]}`} />
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
 * One failure, in the same shape everywhere: the sentence, the service's own words under it, and
 * the single thing worth doing next.
 */
function FailureLine({ failure, edit }: { failure: EditFailure; edit: PassportEdit }) {
  const t = useTranslations("passport.edit");
  const format = useFormatter();
  const quota = edit.state.quota;
  const openPassport = failure.next === "openPassport" && failure.passportId !== undefined;

  const handlers: Record<string, (() => void) | undefined> = {
    grant: () => void edit.actions.grant(),
    again: () => void edit.actions.submit(),
    // Nothing was sent when a dependency did not answer, so this one is a plain retry with copy
    // that says what it is waiting on.
    later: () => void edit.actions.submit(),
    recheck: () => void edit.actions.recheck(),
    signIn: edit.actions.signIn,
  };
  const action = failure.next === undefined || openPassport ? undefined : handlers[failure.next];

  // A send that is still out is not a send that failed, so it keeps the muted ink and the status
  // role rather than the alarm.
  const pending = isEditPending(failure);

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
      role={pending ? "status" : "alert"}
      data-tone={pending ? "pending" : "failed"}
      className={`border-s-2 py-3 ps-4 ${pending ? "border-text-muted bg-text-muted/5" : "border-failed bg-failed/5"}`}
    >
      <p className={`flex max-w-[50ch] items-start gap-2.5 text-base leading-relaxed ${pending ? "text-text-muted" : "text-failed"}`}>
        {pending ? null : <WarningMark className="mt-[5px]" />}
        {t(`failure.${failure.key}`, {
          used: quota?.used ?? 0,
          limit: quota?.limit ?? 0,
          at: quota == null ? "" : format.dateTime(new Date(quota.resetsAt * 1000), "time"),
        })}
      </p>
      {failure.reason === undefined ? null : (
        <p className="mt-2 max-w-[50ch] break-words font-mono text-[11px] leading-relaxed text-text-faint">
          {failure.reason}
        </p>
      )}
      {openPassport ? (
        <Link
          href={`/passport/${failure.passportId}`}
          className="mt-4 inline-block rounded-[8px] border border-line px-4 py-2 text-[11px] uppercase tracking-[0.18em] text-text-muted transition-colors duration-200 hover:border-accent hover:text-accent"
        >
          {t("actions.openPassport")}
        </Link>
      ) : null}
      {action === undefined ? null : (
        <button
          type="button"
          onClick={action}
          className="mt-4 rounded-[8px] border border-line px-4 py-2 text-[11px] uppercase tracking-[0.18em] text-text-muted transition-colors duration-200 hover:border-accent hover:text-accent"
        >
          {t(`actions.${failure.next}`)}
        </button>
      )}
    </motion.div>
  );
}

/** The picture's own title as its alt text, or the fallback while no title is typed yet. */
export function editPictureAlt(title: string, fallback: string): string {
  const named = title.trim();
  return named === "" ? fallback : named;
}

function megabytes(file: File | null): string {
  return file === null ? "" : `${(file.size / 1_000_000).toFixed(1)} MB`;
}
