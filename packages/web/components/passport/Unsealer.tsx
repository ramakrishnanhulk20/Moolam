"use client";

import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useFormatter, useTranslations } from "next-intl";
import { useEffect, useRef } from "react";
import type { Hex } from "viem";
import { gatewayUrl, shortHex } from "@/lib/chain/client";
import { useRouter } from "@/lib/i18n/routing";
import { pictureSources } from "@/lib/images";
import { refreshPassport } from "@/lib/passport/refresh";
import {
  isUnsealBusy,
  isUnsealDone,
  useUnsealPassport,
  type PassportUnseal,
  type UnsealFailure,
} from "@/lib/passport/unseal";
import type { UnsealResponse } from "@/lib/verifier/client";
import { Mono } from "./Mono";
import { Picture } from "./Picture";
import type { PublishedVisit } from "./UnsealPanel";
import { WarningMark } from "@/components/WarningMark";

/**
 * Publishing the picture, in a file of its own so that nothing on a passport
 * page reaches the wallet SDK until this component is asked for.
 * UnsealPanel.tsx holds the gate and pulls this in.
 */
export function Unsealer({
  passportId,
  owner,
  visit,
}: {
  passportId: Hex;
  owner: Hex | null;
  /** Handed down by UnsealPanel, which outlives this panel's own state. */
  visit?: PublishedVisit;
}) {
  const router = useRouter();
  // The poster, the record and the second opinion above this panel are all
  // rendered on the server from the pinned document and the record beside it,
  // so once the picture is public the page is asked to read itself again. What
  // is held about this passport goes first, or the re-read would hand the
  // holder back the very plate they just replaced.
  const unseal = useUnsealPassport({
    passportId,
    owner,
    onPublished: async () => {
      await refreshPassport(passportId);
      router.refresh();
    },
  });

  const result = unseal.state.result;
  const keep = visit?.keep;
  useEffect(() => {
    if (result !== null) {
      keep?.(result);
    }
  }, [keep, result]);

  if (!unseal.ready || !unseal.isHolder) {
    return null;
  }

  return <Panel unseal={unseal} passportId={passportId} visit={visit} />;
}

function Panel({ unseal, passportId, visit }: { unseal: PassportUnseal; passportId: Hex; visit?: PublishedVisit }) {
  const t = useTranslations("passport.unseal");
  const calm = useReducedMotion() === true;
  const { state } = unseal;
  // The panel's own answer first; the kept one covers a panel drawn again after
  // the page turned public, when its own state started empty.
  const receipt = state.result ?? visit?.receipt ?? null;

  return (
    <motion.section
      initial={calm ? false : { opacity: 0, y: 28 }}
      whileInView={calm ? undefined : { opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-60px" }}
      transition={{ duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
      data-unseal-panel
      className="relative mt-14 overflow-hidden border border-s-2 border-line border-s-accent bg-bg-raised p-6 sm:p-8"
    >
      {/* The one light in the panel, thrown from the corner the seal sits in.
          It is the same gesture the sealed plate uses, so publishing reads as
          the end of that picture's story rather than a different screen. */}
      <div
        aria-hidden
        className="pointer-events-none absolute -end-24 -top-24 h-64 w-64 rounded-full opacity-[0.16]"
        style={{ background: "radial-gradient(circle, var(--accent) 0%, transparent 70%)" }}
      />

      <p className="flex items-center gap-3 font-mono text-[11px] uppercase tracking-[0.24em] text-accent">
        <span className="motif h-[9px] w-[9px]" />
        {t("kicker")}
      </p>
      <h2 className="mt-5 max-w-[18ch] font-display text-[clamp(1.5rem,3vw,2.3rem)] font-semibold uppercase leading-[1.02] tracking-[-0.03em]">
        {t("heading")}
      </h2>

      {isUnsealDone(state) || receipt !== null ? (
        <Published result={receipt} settled={visit?.settled === true} firstReveal={visit?.firstReveal} />
      ) : (
        <Choose unseal={unseal} passportId={passportId} />
      )}
    </motion.section>
  );
}

/** The file, the check that runs on this machine, and the one button that cannot be taken back. */
function Choose({ unseal, passportId }: { unseal: PassportUnseal; passportId: Hex }) {
  const t = useTranslations("passport.unseal");
  const input = useRef<HTMLInputElement>(null);
  const { state } = unseal;
  const busy = isUnsealBusy(state);

  return (
    <div className="mt-5">
      <p className="max-w-[52ch] text-base leading-relaxed text-text-muted">{t("body")}</p>

      <p className="mt-5 max-w-[52ch] border-s-2 border-accent/60 ps-4 text-base leading-relaxed text-text">
        {t("permanent")}
      </p>

      <input
        ref={input}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          // Cleared so choosing the same file twice, after a refusal, still
          // fires a change and runs the check again.
          event.target.value = "";
          if (file !== undefined) {
            void unseal.actions.choose(file);
          }
        }}
      />

      <div className="mt-7 flex flex-wrap items-center gap-4">
        <button
          type="button"
          onClick={() => input.current?.click()}
          disabled={busy}
          className="rounded-[8px] border border-line px-5 py-3 text-[11px] uppercase tracking-[0.2em] text-text-muted transition-colors duration-200 hover:border-accent hover:text-accent disabled:opacity-60"
        >
          {state.kept === null ? t("choose") : t("chooseAnother")}
        </button>

        {state.kept === null ? null : (
          <button
            type="button"
            onClick={() => void unseal.actions.publish()}
            disabled={busy}
            className="rounded-[8px] bg-accent px-6 py-3.5 text-xs font-semibold uppercase tracking-[0.16em] text-accent-ink transition-transform duration-200 hover:-translate-y-0.5 disabled:translate-y-0 disabled:opacity-50"
          >
            {t("publish")}
          </button>
        )}
      </div>

      <AnimatePresence mode="wait" initial={false}>
        {state.checking ? (
          <Line key="checking" tone="running" text={t("checking")} />
        ) : state.sending ? (
          <Line key="sending" tone="running" text={t("sending")} />
        ) : state.kept === null ? null : (
          <motion.div
            key="kept"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
            className="mt-6 border-s-2 border-verified bg-verified/5 py-3 ps-4"
          >
            <p className="flex items-center gap-3 font-mono text-[10px] uppercase tracking-[0.2em] text-verified">
              <span aria-hidden className="h-2 w-2 bg-verified" />
              {t("matched")}
            </p>
            <p className="mt-2 break-all font-mono text-[11px] text-text">
              {state.kept.name} <span className="text-text-faint">{megabytes(state.kept.size)}</span>
            </p>
            <p className="mt-2 max-w-[48ch] text-base leading-relaxed text-text-muted">
              {t("matchedLine", { id: shortHex(passportId, 8, 6) })}
            </p>
          </motion.div>
        )}
      </AnimatePresence>

      {state.quota === null ? null : (
        <p className="mt-5 font-mono text-[10px] uppercase tracking-[0.2em] text-text-faint">
          {t("allowance", { used: state.quota.used, limit: state.quota.limit })}
        </p>
      )}

      {state.failure === null ? null : (
        <div className="mt-6">
          <FailureLine failure={state.failure} unseal={unseal} />
        </div>
      )}
    </div>
  );
}

/**
 * The receipt: the picture that is now public, and the four addresses it lives at.
 *
 * The refresh that turns the page public swaps the poster above for the new
 * picture and moves everything under the reader, so once it lands the receipt
 * is brought back into view, once, and never again on a later visit to it.
 */
function Published({
  result,
  settled,
  firstReveal,
}: {
  result: UnsealResponse | null;
  settled: boolean;
  firstReveal?: () => boolean;
}) {
  const t = useTranslations("passport.unseal");
  const format = useFormatter();
  const calm = useReducedMotion() === true;
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!settled || result === null || box.current === null || firstReveal?.() !== true) {
      return;
    }
    box.current.scrollIntoView({ behavior: calm ? "instant" : "smooth", block: "start" });
  }, [calm, firstReveal, result, settled]);

  if (result === null) {
    return null;
  }

  return (
    <motion.div
      ref={box}
      data-unseal-receipt
      style={{ scrollMarginTop: "calc(var(--header-h) + 1rem)" }}
      initial={{ opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
      className="mt-5"
    >
      <div className="grain relative h-[16rem] overflow-hidden border border-line">
        {/* The pinned file itself, read back through the gateway: the picture a
            verifier now fetches when it re-checks this passport. */}
        <Picture
          sources={pictureSources(gatewayUrl(result.image.uri))}
          alt=""
          sizes="(max-width: 640px) 100vw, 40vw"
          className="object-cover"
        />
        <div className="scrim pointer-events-none absolute inset-0" />
        <p className="absolute bottom-4 start-5 font-mono text-[11px] uppercase tracking-[0.24em] text-verified">
          {t("done.label")}
        </p>
      </div>

      <p className="mt-6 max-w-[52ch] text-base leading-relaxed text-text-muted">{t("done.body")}</p>
      <p className="mt-3 font-mono text-[10px] uppercase tracking-[0.2em] text-text-faint">
        {t("done.at", { when: format.dateTime(new Date(result.unsealedAt), "moment") })}
      </p>

      <dl className="mt-6 grid gap-x-8 gap-y-5 border-t border-line pt-5 sm:grid-cols-2">
        <Address label={t("done.image")} uri={result.image.uri} cid={result.image.cid} />
        <Address label={t("done.thumbnail")} uri={result.thumbnail.uri} cid={result.thumbnail.cid} />
        {result.manifest === undefined ? null : (
          <Address label={t("done.manifest")} uri={result.manifest.uri} cid={result.manifest.cid} />
        )}
        <Address label={t("done.record")} uri={result.record.uri} cid={result.record.cid} />
      </dl>

      <p className="mt-6 max-w-[52ch] text-base leading-relaxed text-text-faint">{t("done.check")}</p>
    </motion.div>
  );
}

function Address({ label, uri, cid }: { label: string; uri: string; cid: string }) {
  return (
    <div className="min-w-0">
      <dt className="font-mono text-[10px] uppercase tracking-[0.2em] text-text-faint">{label}</dt>
      <dd className="mt-1.5">
        <a
          href={gatewayUrl(uri)}
          target="_blank"
          rel="noreferrer"
          className="tap min-w-0 transition-colors duration-200 hover:text-accent"
        >
          <Mono value={cid} className="text-xs leading-relaxed" />
        </a>
      </dd>
    </div>
  );
}

/** One honest label for a wait the reader is watching. */
function Line({ tone, text }: { tone: "running"; text: string }) {
  return (
    <motion.p
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      transition={{ duration: 0.3 }}
      role="status"
      data-tone={tone}
      className="mt-6 flex items-center gap-3 font-mono text-[11px] uppercase tracking-[0.16em] text-pending"
    >
      <span aria-hidden className="inline-block h-2 w-2 bg-pending motion-safe:animate-pulse" />
      {text}
    </motion.p>
  );
}

/**
 * One failure, in the same shape the edit panel uses: the sentence, the
 * service's own words under it, and the single thing worth doing next.
 *
 * Two of these are not alarms. A passport that is already public is not a
 * failure the holder can do anything about except look at the page, so those
 * two keep the muted ink and the status role.
 */
function FailureLine({ failure, unseal }: { failure: UnsealFailure; unseal: PassportUnseal }) {
  const t = useTranslations("passport.unseal");
  const format = useFormatter();
  const router = useRouter();
  const quota = unseal.state.quota;
  const settled = failure.next === "showPicture";

  const handlers: Record<string, (() => void) | undefined> = {
    again: () => void unseal.actions.publish(),
    later: () => void unseal.actions.publish(),
    chooseAgain: unseal.actions.reset,
    signIn: unseal.actions.signIn,
    showPicture: () => router.refresh(),
  };
  const action = failure.next === undefined ? undefined : handlers[failure.next];

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
      role={settled ? "status" : "alert"}
      data-tone={settled ? "settled" : "failed"}
      className={`border-s-2 py-3 ps-4 ${settled ? "border-text-muted bg-text-muted/5" : "border-failed bg-failed/5"}`}
    >
      <p className={`flex max-w-[52ch] items-start gap-2.5 text-base leading-relaxed ${settled ? "text-text-muted" : "text-failed"}`}>
        {settled ? null : <WarningMark className="mt-[5px]" />}
        {t(`failure.${failure.key}`, {
          used: quota?.used ?? 0,
          limit: quota?.limit ?? 0,
          at: quota == null ? "" : format.dateTime(new Date(quota.resetsAt * 1000), "time"),
        })}
      </p>
      {failure.reason === undefined ? null : (
        <p className="mt-2 max-w-[52ch] break-words font-mono text-[11px] leading-relaxed text-text-faint">
          {failure.reason}
        </p>
      )}
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

function megabytes(size: number): string {
  return `${(size / 1_000_000).toFixed(1)} MB`;
}
