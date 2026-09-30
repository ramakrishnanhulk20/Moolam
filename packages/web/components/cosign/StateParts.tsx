"use client";

import { motion } from "framer-motion";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import type { Hex } from "viem";
import { useIsReducedMotion } from "@/components/motion/useIsReducedMotion";
import { MONAD_EXPLORER } from "@/lib/chain/client";
import { canSign, failReason, pressFor, type CosignModel, type Press } from "@/lib/cosign/flow";
import { Link } from "@/lib/i18n/routing";
import { canPayOwnFee } from "@/lib/studio/problems";
import { QUIET } from "./Checkout";
import { PRIMARY, SECONDARY, StateLine, shortAddress, type Tone } from "./Marks";

/**
 * What a co-sign state says and offers. The full page and the checkout window
 * both draw from these, so the two layouts can never disagree about which
 * press a button stands for or when it opens.
 */
export interface Words {
  kicker: string;
  headline: string;
  line: string;
  tone: Tone;
  primary?: string;
  secondary?: string;
  note?: string;
}

/** One of the six numbered clauses, with the one mark that says how far Moolam vouches for it. */
export interface Clause {
  key: string;
  label: string;
  mark: "solid" | "dashed" | "none";
  body: ReactNode;
}

/**
 * The buttons a state offers, each one mapped to the one press it stands for.
 * The checkout window draws the same two presses, the primary across the
 * window and the second as a quiet link under it.
 */
export function Actions({
  model,
  words,
  exactHash,
  onPress,
  checkout = false,
}: {
  model: CosignModel;
  words: Words;
  exactHash: Hex | null;
  onPress: (press: Press) => void;
  checkout?: boolean;
}) {
  const primary = pressFor(model, "primary");
  const secondary = pressFor(model, "secondary");
  const view = model.view;
  const busy = model.bind.at !== "idle";
  const taken = view === "failed" && failReason(model) === "taken";

  const primaryHref =
    view === "registered" && model.send.at === "registered"
      ? `/passport/${model.send.passportId}`
      : taken && exactHash !== null
        ? `/passport/${exactHash}`
        : null;

  if (words.primary === undefined && words.secondary === undefined) {
    return null;
  }

  const disabled = (view === "ready" && !canSign(model)) || busy;
  const primaryClass = checkout ? `${PRIMARY} w-full justify-center` : PRIMARY;

  return (
    <div className={checkout ? "flex flex-col gap-1.5" : "mt-8 flex flex-wrap items-center gap-x-4 gap-y-3 pb-3"}>
      {words.primary === undefined ? null : primaryHref !== null ? (
        <Link href={primaryHref} className={primaryClass}>
          <span aria-hidden className="motif h-[14px] w-[14px] bg-accent-ink" />
          {words.primary}
        </Link>
      ) : primary === null ? null : (
        <button
          type="button"
          data-press={primary}
          disabled={disabled}
          onClick={() => onPress(primary)}
          className={primaryClass}
        >
          <span aria-hidden className="motif h-[14px] w-[14px] bg-accent-ink" />
          {words.primary}
        </button>
      )}
      {words.secondary === undefined || secondary === null ? null : (
        <button
          type="button"
          data-press={secondary}
          disabled={busy}
          onClick={() => onPress(secondary)}
          className={checkout ? QUIET : SECONDARY}
        >
          {words.secondary}
        </button>
      )}
    </div>
  );
}

/**
 * What a running press is doing, and what stopped the last one, under the
 * buttons. A fee Privy would not pay gets the studio's own answer in the
 * studio's words: send the same signed bytes and pay the fee from the account,
 * with the balance beside the offer, or the line that says the account is empty.
 */
export function Progress({
  model,
  balance,
  onPress,
}: {
  model: CosignModel;
  balance: bigint | null;
  onPress: (press: Press) => void;
}) {
  const t = useTranslations("cosign");
  const failures = useTranslations("studio.failure");
  const studio = useTranslations("studio");
  const bind = model.bind;
  const failure =
    (bind.at === "idle" ? bind.failure : null) ??
    (model.send.at === "idle" || model.send.at === "unconfirmed" ? model.send.failure : null);

  if (bind.at !== "idle") {
    return (
      <p data-bind-stage={bind.at} className="mb-3 flex items-center gap-3 text-base leading-relaxed text-text-muted">
        <span aria-hidden className="motif h-[9px] w-[9px] shrink-0 motion-safe:animate-pulse" />
        {t(`bindStage.${bind.at}`)}
      </p>
    );
  }
  if (failure === null || model.view === "registered") {
    return null;
  }
  return (
    <div data-press-failure={failure.key} className="mb-3">
      <StateLine tone="failed" className="max-w-[58ch]">
        {failures.has(failure.key) ? failures(failure.key) : failures("unknown")}
      </StateLine>
      {failure.next !== "unsponsored" ? null : canPayOwnFee(balance) ? (
        <div className="ms-[23px] mt-3 flex flex-wrap items-center gap-x-5 gap-y-2">
          <button type="button" data-press="unsponsored" onClick={() => onPress("unsponsored")} className={SECONDARY}>
            {studio("actions.unsponsored")}
          </button>
          {balance === null ? null : (
            <p data-balance className="font-mono text-xs leading-relaxed text-text-faint">
              {studio("register.balance", { mon: (Number(balance) / 1e18).toFixed(4) })}
            </p>
          )}
        </div>
      ) : (
        <p data-balance-empty className="ms-[23px] mt-3 max-w-[54ch] text-base leading-relaxed text-text-muted">
          {studio("register.balanceEmpty")}
        </p>
      )}
      {failure.reason === undefined ? null : (
        <p className="ms-[23px] mt-1.5 break-words font-mono text-[11px] leading-relaxed text-text-muted">{failure.reason}</p>
      )}
    </div>
  );
}

/**
 * What only some states carry under their words: the honest steps of a wait,
 * the passport and its receipt once they exist, the terms' own progress, and
 * the fingerprint that failed to match.
 */
export function Extras({ model }: { model: CosignModel }) {
  const t = useTranslations("cosign");
  const reduced = useIsReducedMotion();
  const view = model.view;

  const steps =
    view === "waitingAgent"
      ? [
          { label: t("steps.agentSigns"), at: "now" as const },
          { label: t("steps.pinned"), at: "next" as const },
          { label: t("steps.passkey"), at: "next" as const },
        ]
      : view === "signing"
        ? [
            { label: t("steps.passkey"), at: model.send.at === "signing" ? ("now" as const) : ("done" as const) },
            {
              label: t("steps.sent"),
              at: model.send.at === "sending" ? ("now" as const) : model.send.at === "confirming" ? ("done" as const) : ("next" as const),
            },
            { label: t("steps.written"), at: model.send.at === "confirming" ? ("now" as const) : ("next" as const) },
          ]
        : null;

  if (steps !== null) {
    return (
      <ol data-wait-steps className="grid grid-cols-3 gap-2">
        {steps.map((step, index) => (
          <li key={step.label} data-step={step.at} className="min-w-0">
            <span className={`relative block h-[2px] overflow-hidden ${step.at === "done" ? "bg-verified" : "bg-line"}`}>
              {step.at === "now" ? (
                <motion.span
                  className="absolute inset-y-0 start-0 w-1/2 bg-accent"
                  initial={{ x: "-100%" }}
                  animate={reduced ? { x: "50%" } : { x: ["-100%", "200%"] }}
                  transition={reduced ? { duration: 0 } : { duration: 1.6, ease: "easeInOut", repeat: Infinity }}
                />
              ) : null}
            </span>
            <span
              className={`mt-2 block font-mono text-[10px] uppercase leading-snug tracking-[0.16em] ${
                step.at === "next" ? "text-text-faint" : "text-text"
              }`}
            >
              {String(index + 1).padStart(2, "0")} {step.label}
            </span>
          </li>
        ))}
      </ol>
    );
  }

  if (view === "registered" && model.send.at === "registered") {
    const terms = model.terms;
    return (
      <div className="flex flex-col gap-2">
        <p className="font-mono text-[11px] leading-relaxed text-text-muted">
          {t("registeredLine", { id: shortAddress(model.send.passportId) })}
          {" · "}
          <a
            href={`${MONAD_EXPLORER}/tx/${model.send.txHash}`}
            target="_blank"
            rel="noreferrer noopener"
            className="text-text underline decoration-line-strong underline-offset-4 transition-colors duration-200 hover:text-accent hover:decoration-accent"
          >
            {t("transaction")}
          </a>
        </p>
        {terms.at === "none" ? null : (
          <p data-terms={terms.at} className={`text-base leading-relaxed ${terms.at === "written" ? "text-verified" : "text-text-muted"}`}>
            {terms.at === "stated"
              ? t("termsLine.stated", { writer: shortAddress(terms.writer) })
              : t(`termsLine.${terms.at}`)}
          </p>
        )}
      </div>
    );
  }

  if (view === "failed" && model.gate.at === "failed") {
    const gate = model.gate;
    const detail =
      gate.what === "picture"
        ? t("detailsPicture")
        : gate.what === "metadata"
          ? t("detailsMetadata")
          : gate.local !== undefined && gate.other !== undefined
            ? t("detailsDigest", { local: gate.local, other: gate.other })
            : t("detailsRecord");
    return (
      <details className="group ms-[23px] text-sm text-text-muted">
        <summary className="cursor-pointer font-mono text-[10px] uppercase tracking-[0.2em] transition-colors duration-200 hover:text-text">
          {t("details")}
        </summary>
        <p className="mt-2 break-all font-mono text-[11px] leading-relaxed">{detail}</p>
      </details>
    );
  }

  return null;
}
