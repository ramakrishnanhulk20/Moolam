"use client";

import { motion } from "framer-motion";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import type { Hex } from "viem";
import { WarningMark } from "@/components/WarningMark";
import { useIsReducedMotion } from "@/components/motion/useIsReducedMotion";
import type { ClaimsAnswer, ClaimTerms } from "@/lib/claims/client";
import { offersByPlatform, waitingByPlatform } from "@/lib/claims/offers";
import type { ClaimRefusal } from "@/lib/claims/refusal";
import type { ConfirmRow } from "@/lib/claims/useClaimConfirm";
import { failureKey, type PlatformBusy } from "@/lib/claims/useClaims";
import type { PendingGroup } from "@/lib/claims/usePendingConfirm";
import type { ConsentDraft } from "@/lib/consent/call";
import { ClaimSettings } from "./ClaimSettings";
import { ConfirmCard } from "./ConfirmCard";
import { PlatformOffer } from "./PlatformOffer";
import { RefusalLine } from "./RefusalLine";

/** A group confirmed on this visit, kept on screen after the chain stops listing it as one to confirm. */
export interface ConfirmedNow {
  key: string;
  terms: ClaimTerms;
  txHash: Hex;
  rows: ConfirmRow[];
}

export interface ClaimsViewProps {
  answer: ClaimsAnswer;
  /** The signed-in person's verified addresses, from their own session. Never from the answer. */
  emails: string[];
  busy: Readonly<Record<string, PlatformBusy>>;
  failures: Readonly<Record<string, ClaimRefusal>>;
  /** The last read of the list was refused, though an older answer is still on screen. */
  refusal: ClaimRefusal | null;
  watching: boolean;
  pending: {
    status: "idle" | "reading" | "ready" | "unreadable";
    groups: PendingGroup[];
  };
  confirmedNow: ConfirmedNow[];
  renderConfirm: (group: PendingGroup) => ReactNode;
  onMine: (key: Hex, draft: ConsentDraft, sendFuture: boolean) => void;
  onNotMine: (key: Hex) => void;
  onStop: (key: Hex) => void;
  onUnmute: (key: Hex) => void;
  onReload: () => void;
  onReread: () => void;
  onSignIn: () => void;
}

const EASE = [0.16, 1, 0.3, 1] as const;

/**
 * "Waiting for you": what platforms are holding for this person's email, what
 * they have accepted and are waiting on, and what has arrived and wants one
 * press to confirm. Drawn above the person's own pictures and only when there
 * is something in it. The standing choices sit at its foot, or alone in a
 * quiet strip when nothing else is waiting.
 */
export function ClaimsView(props: ClaimsViewProps) {
  const { answer, pending, confirmedNow } = props;
  const t = useTranslations("claims");

  const offers = offersByPlatform(answer.offers);
  const accepted = waitingByPlatform(answer.waiting, "accepted");
  const failed = waitingByPlatform(answer.waiting, "failed");
  const pendingKeys = new Set(pending.groups.map((group) => group.key));
  const confirmedShown = confirmedNow.filter((one) => !pendingKeys.has(one.key));
  const unreadable = pending.status === "unreadable";
  // Everything still to come: offers to answer, handovers under way or stuck, and arrivals to confirm.
  const waitingCount =
    answer.offers.length +
    answer.waiting.filter((entry) => entry.state !== "delivered").length +
    pending.groups.reduce((sum, group) => sum + group.ids.length, 0);

  const hasWaiting =
    offers.length + accepted.length + failed.length + pending.groups.length + confirmedShown.length > 0 || unreadable;
  const settings = (
    <ClaimSettings
      standing={answer.standing}
      muted={answer.muted}
      busy={props.busy}
      failures={props.failures}
      onStop={props.onStop}
      onUnmute={props.onUnmute}
      onReload={props.onReload}
      onSignIn={props.onSignIn}
    />
  );
  const hasSettings = answer.standing.length + answer.muted.length > 0;

  if (!hasWaiting) {
    return hasSettings ? (
      <motion.section
        data-claims="settings"
        initial={{ opacity: 0, y: 24 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6, ease: EASE }}
        className="mb-12 max-w-[56rem]"
      >
        {settings}
      </motion.section>
    ) : null;
  }

  return (
    <motion.section
      data-claims="waiting"
      aria-labelledby="claims-heading"
      initial={{ opacity: 0, y: 24 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.7, ease: EASE }}
      className="relative mb-14 overflow-hidden border border-line bg-bg-raised sm:mb-20"
    >
      {/* The poster's one light source, low and pink, behind the heading. */}
      <div
        aria-hidden
        className="pointer-events-none absolute -start-48 -top-48 h-[34rem] w-[34rem] rounded-full bg-accent opacity-[0.08] blur-3xl"
      />
      <div className="relative grid lg:grid-cols-[minmax(0,4fr)_minmax(0,8fr)]">
        <Masthead count={waitingCount} />

        <div className="min-w-0 divide-y divide-line">
          {offers.map((group, index) => (
            <PlatformOffer
              key={group.platform.keyHash}
              group={group}
              emails={props.emails}
              busy={props.busy[failureKey("offer", group.platform.keyHash)]}
              failure={props.failures[failureKey("offer", group.platform.keyHash)]}
              index={index}
              onMine={props.onMine}
              onNotMine={props.onNotMine}
              onReload={props.onReload}
              onSignIn={props.onSignIn}
            />
          ))}

          {accepted.map((group) => (
            <Handover
              key={`accepted-${group.platform.keyHash}`}
              platform={group.platform.name}
              count={group.entries.length}
              watching={props.watching}
              onLook={props.onReload}
            />
          ))}

          {failed.map((group) => (
            <div key={`failed-${group.platform.keyHash}`} data-claims-handover-failed className="p-6 sm:px-8 lg:px-10">
              <p className="flex max-w-[64ch] items-start gap-2.5 text-base leading-relaxed text-failed">
                <WarningMark className="mt-[5px] shrink-0" />
                <span className="min-w-0">
                  {t("handoverFailed", {
                    platform: group.platform.name,
                    count: group.entries.length,
                  })}
                </span>
              </p>
            </div>
          ))}

          {pending.groups.map((group) => (
            <div key={`confirm-${group.key}`}>{props.renderConfirm(group)}</div>
          ))}

          {confirmedShown.map((one) => (
            <ConfirmCard
              key={`done-${one.key}`}
              rows={one.rows}
              terms={one.terms}
              step="done"
              failure={null}
              txHash={one.txHash}
              onConfirm={NOTHING}
              onRecheck={NOTHING}
              onReread={NOTHING}
            />
          ))}

          {unreadable ? (
            <div role="alert" className="flex flex-wrap items-center gap-x-5 gap-y-3 p-6 sm:px-8 lg:px-10">
              <p className="flex max-w-[60ch] items-start gap-2.5 text-base leading-relaxed text-failed">
                <WarningMark className="mt-[5px] shrink-0" />
                <span className="min-w-0">{t("confirm.unreadable")}</span>
              </p>
              <button
                type="button"
                onClick={props.onReread}
                className="tap rounded-[8px] border border-line-strong px-4 py-2 font-mono text-[10px] uppercase tracking-[0.18em] text-text transition-colors duration-200 hover:border-accent hover:text-accent"
              >
                {t("confirm.readAgain")}
              </button>
            </div>
          ) : null}

          {props.refusal === null ? null : (
            <div className="p-6 sm:px-8 lg:px-10">
              <RefusalLine refusal={props.refusal} onAgain={props.onReload} onReload={props.onReload} onSignIn={props.onSignIn} />
            </div>
          )}
        </div>
      </div>

      {hasSettings ? <div className="relative border-t border-line p-6 sm:px-8 lg:px-10">{settings}</div> : null}
    </motion.section>
  );
}

const NOTHING = () => undefined;

/** The heading column: what this is, in poster type, with the count bled off its corner. */
function Masthead({ count }: { count: number }) {
  const t = useTranslations("claims");

  return (
    <header className="relative overflow-hidden border-b border-line p-6 pb-10 sm:p-10 sm:pb-40 lg:border-b-0 lg:border-e lg:pb-48">
      {count === 0 ? null : (
        <motion.p
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, delay: 0.1, ease: EASE }}
          className="flex items-center gap-3 font-mono text-[11px] uppercase tracking-[0.24em] text-accent"
        >
          <span className="motif h-[9px] w-[9px]" />
          {t("count", { count })}
        </motion.p>
      )}
      <motion.h2
        id="claims-heading"
        initial={{ opacity: 0, y: 24 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.75, delay: 0.16, ease: EASE }}
        className="mt-5 font-display text-[clamp(2.4rem,5vw,4.6rem)] font-semibold uppercase leading-[0.9] tracking-[-0.035em]"
      >
        {t("heading")}
      </motion.h2>
      <motion.p
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.7, delay: 0.24, ease: EASE }}
        className="mt-6 max-w-[34ch] text-base leading-relaxed text-text-muted"
      >
        {t("line")}
      </motion.p>
      {/* The count again as a poster numeral, outlined and cut by the column's edge. */}
      {count === 0 ? null : (
        <motion.span
          aria-hidden
          initial={{ opacity: 0, y: 40 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 1.1, delay: 0.3, ease: EASE }}
          className="pointer-events-none absolute -bottom-[0.18em] end-[-0.04em] hidden select-none font-display text-[clamp(10rem,17vw,17rem)] font-bold leading-none tracking-[-0.07em] text-transparent [-webkit-text-stroke:1.5px_var(--line-strong)] sm:block"
        >
          {String(Math.min(count, 99)).padStart(2, "0")}
        </motion.span>
      )}
    </header>
  );
}

/** A platform the person said yes to, moving the passports over; the page looks again on its own a few times. */
function Handover({
  platform,
  count,
  watching,
  onLook,
}: {
  platform: string;
  count: number;
  watching: boolean;
  onLook: () => void;
}) {
  const t = useTranslations("claims");
  const reduced = useIsReducedMotion();

  return (
    <div data-claims-handover className="flex flex-wrap items-center gap-x-5 gap-y-3 p-6 sm:px-8 lg:px-10">
      <span aria-hidden className="relative flex h-4 w-4 shrink-0 items-center justify-center">
        {reduced ? null : (
          <motion.span
            className="motif absolute h-4 w-4 bg-accent"
            animate={{ scale: [1, 1.9], opacity: [0.5, 0] }}
            transition={{ duration: 1.8, repeat: Infinity, ease: "easeOut" }}
          />
        )}
        <span className="motif h-2.5 w-2.5 bg-accent" />
      </span>
      <p className="min-w-0 text-base leading-snug text-text">{t("handingOver", { platform })}</p>
      <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-text-faint">{t("count", { count })}</span>
      {watching ? (
        <span className="basis-full font-mono text-[10px] uppercase tracking-[0.2em] text-text-faint sm:ms-9">
          {t("handoverNote")}
        </span>
      ) : (
        <button
          type="button"
          onClick={onLook}
          className="tap rounded-[8px] border border-line-strong px-4 py-2 font-mono text-[10px] uppercase tracking-[0.18em] text-text transition-colors duration-200 hover:border-accent hover:text-accent"
        >
          {t("lookAgain")}
        </button>
      )}
    </div>
  );
}
