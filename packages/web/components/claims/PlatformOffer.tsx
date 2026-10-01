"use client";

import { LayoutGroup, motion } from "framer-motion";
import { useFormatter, useTranslations } from "next-intl";
import { useState } from "react";
import type { Hex } from "viem";
import { ConsentChoice } from "@/components/consent/ConsentChoice";
import { draftProblem } from "@/components/consent/draft";
import { WaitLabel } from "@/components/studio/WaitLabel";
import { shortHex } from "@/lib/chain/client";
import { previewUrl } from "@/lib/claims/art";
import type { VerifiedBy } from "@/lib/claims/client";
import type { PlatformOffers } from "@/lib/claims/offers";
import type { ClaimRefusal } from "@/lib/claims/refusal";
import type { PlatformBusy } from "@/lib/claims/useClaims";
import { NOTHING_TO_STATE } from "@/lib/studio/consent";
import type { ConsentDraft } from "@/lib/consent/call";
import { RefusalLine } from "./RefusalLine";

/** The message key for each way a platform says it checked the address. */
const CLAIM_KEYS: Record<VerifiedBy, "google" | "emailCode" | "platform"> = {
  google: "google",
  "email-code": "emailCode",
  platform: "platform",
};

/**
 * One platform's offers and the person's one answer to all of them.
 *
 * The address named is the person's own, from their own session, and how the
 * platform checked it is said as the platform's claim beside the platform's
 * listed name, never as Moolam's (P36). Every picture shows its passport id,
 * with or without a preview, so nothing is accepted without a name to it.
 */
export function PlatformOffer({
  group,
  emails,
  busy,
  failure,
  index,
  onMine,
  onNotMine,
  onReload,
  onSignIn,
}: {
  group: PlatformOffers;
  emails: string[];
  busy?: PlatformBusy;
  failure?: ClaimRefusal;
  index: number;
  onMine: (key: Hex, draft: ConsentDraft, sendFuture: boolean) => void;
  onNotMine: (key: Hex) => void;
  onReload: () => void;
  onSignIn: () => void;
}) {
  const t = useTranslations("claims");
  const format = useFormatter();
  const [draft, setDraft] = useState<ConsentDraft>(NOTHING_TO_STATE);
  const [sendFuture, setSendFuture] = useState(false);
  const platform = group.platform.name;
  const key = group.platform.keyHash;
  const email = emails.length === 0 ? t("yourEmail") : format.list(emails, { type: "disjunction" });
  const problem = draftProblem(draft);
  const locked = busy !== undefined;
  const tickId = `claims-future-${key.slice(2, 14)}`;

  return (
    <motion.article
      data-claims-platform={key}
      initial={{ opacity: 0, y: 24 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, amount: 0.15 }}
      transition={{ duration: 0.65, delay: Math.min(index, 4) * 0.08, ease: [0.16, 1, 0.3, 1] }}
      className="p-6 sm:p-8 lg:p-10"
    >
      <p
        data-claims-holding
        className="max-w-[40ch] break-words font-display text-[clamp(1.3rem,2.2vw,1.75rem)] font-semibold leading-[1.12] tracking-[-0.02em]"
      >
        {t("holding", { platform, count: group.offers.length, email })}
      </p>
      {group.verifiedBy.map((word) => (
        <p key={word} data-claims-claim={word} className="mt-3 flex max-w-[60ch] items-start gap-2.5 text-sm leading-snug text-text-muted">
          <span aria-hidden className="motif mt-[5px] h-[6px] w-[6px] shrink-0" />
          <span className="min-w-0">{t(`verifiedBy.${CLAIM_KEYS[word]}`, { platform })}</span>
        </p>
      ))}

      <ul className="-mx-6 mt-7 flex snap-x scroll-px-6 gap-3 overflow-x-auto px-6 pb-3 sm:-mx-8 sm:scroll-px-8 sm:px-8 lg:-mx-10 lg:scroll-px-10 lg:px-10">
        {group.offers.map((offer, at) => {
          const picture = previewUrl(offer.preview?.image);
          return (
            <motion.li
              key={offer.ticketId}
              data-claims-offer={offer.passportId}
              initial={{ opacity: 0, y: 16 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.55, delay: Math.min(at, 6) * 0.05, ease: [0.16, 1, 0.3, 1] }}
              className="group w-[10.5rem] shrink-0 snap-start sm:w-[12.5rem]"
            >
              <div className="grain relative aspect-[4/5] overflow-hidden border border-line bg-bg-sunken">
                {picture === undefined ? (
                  <span
                    data-claims-no-preview
                    className="absolute inset-0 flex items-center justify-center p-4 text-center font-mono text-[10px] uppercase tracking-[0.2em] text-text-faint"
                  >
                    {t("noPreview")}
                  </span>
                ) : (
                  // eslint-disable-next-line @next/next/no-img-element -- a pinned thumbnail through the site's gateway, drawn the way the grid below draws its own
                  <img
                    src={picture}
                    alt={offer.preview?.title ?? ""}
                    loading="lazy"
                    className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-[1.04]"
                  />
                )}
                <div className="scrim pointer-events-none absolute inset-0" />
                {offer.preview === null ? null : (
                  <p className="absolute inset-x-3 bottom-3 truncate text-sm text-text">{offer.preview.title}</p>
                )}
              </div>
              <p className="mt-2 font-mono text-[11px] text-text-faint" title={offer.passportId}>
                {shortHex(offer.passportId, 8, 6)}
              </p>
            </motion.li>
          );
        })}
      </ul>

      <div className="mt-8">
        <p className="mb-4 font-mono text-[10px] uppercase tracking-[0.2em] text-text-faint">{t("termsLabel")}</p>
        {/* Each card's choice keeps its own sliding bar, so two platforms never share one. */}
        <LayoutGroup id={`claims-${key}`}>
          <ConsentChoice draft={draft} onChange={setDraft} disabled={locked} size="compact" />
        </LayoutGroup>
      </div>

      <label htmlFor={tickId} className="group/tick mt-7 flex max-w-[60ch] cursor-pointer items-start gap-3">
        <input
          id={tickId}
          type="checkbox"
          checked={sendFuture}
          disabled={locked}
          onChange={(event) => setSendFuture(event.target.checked)}
          className="peer sr-only"
        />
        <span
          aria-hidden
          className="mt-[3px] flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-[4px] border border-line-strong transition-colors duration-200 group-hover/tick:border-accent peer-checked:border-accent peer-checked:bg-accent peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-accent"
        >
          {sendFuture ? (
            <svg viewBox="0 0 12 12" className="h-3 w-3 text-accent-ink" fill="none">
              <path d="M2 6.4 4.8 9 10 3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          ) : null}
        </span>
        <span className="text-base leading-snug text-text-muted transition-colors duration-200 group-hover/tick:text-text">
          {t("sendFuture", { platform })}
        </span>
      </label>

      <div className="mt-8 flex flex-wrap items-center gap-3">
        <button
          type="button"
          data-claims-mine
          disabled={locked || problem !== null}
          onClick={() => onMine(key, draft, sendFuture)}
          className="rounded-[8px] bg-accent px-7 py-4 text-sm font-semibold uppercase tracking-[0.14em] text-accent-ink transition-transform duration-200 hover:-translate-y-0.5 disabled:translate-y-0 disabled:opacity-50"
        >
          {t("mine")}
        </button>
        <button
          type="button"
          data-claims-not-mine
          disabled={locked}
          onClick={() => onNotMine(key)}
          className="rounded-[8px] border border-line-strong px-7 py-4 text-sm font-semibold uppercase tracking-[0.14em] text-text transition-colors duration-200 hover:border-accent hover:text-accent disabled:opacity-50"
        >
          {t("notMine")}
        </button>
      </div>
      <p className="mt-4 max-w-[60ch] text-sm leading-relaxed text-text-faint">{t("notMineNote", { platform })}</p>

      {locked ? (
        <div className="mt-6">
          <WaitLabel text={t("saving")} />
        </div>
      ) : null}
      {failure === undefined ? null : (
        // The two answers stay right above, so "again" is pressing one of them, not a third button.
        <RefusalLine refusal={failure} className="mt-6" onReload={onReload} onSignIn={onSignIn} />
      )}
    </motion.article>
  );
}
