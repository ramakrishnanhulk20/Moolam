"use client";

import { motion } from "framer-motion";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import type { Hex } from "viem";
import { CHECKOUT_COLUMN, CHECKOUT_DOCK, CHECKOUT_SHELL, CheckoutBar, DoneLine, QUIET } from "@/components/cosign/Checkout";
import { EASE, Kicker, PRIMARY, StateSwap } from "@/components/cosign/Marks";
import { useIsReducedMotion } from "@/components/motion/useIsReducedMotion";
import type { Closing } from "@/lib/cosign/popup";
import type { OriginAsker } from "@/lib/data/platform-label";
import { addressGroups, type ConnectPhase } from "./ConnectPanel";

export interface ConnectCheckoutProps {
  asker: OriginAsker;
  wallet: Hex | null;
  phase: ConnectPhase;
  hasOpener: boolean | null;
  heading: ReactNode;
  closing: Closing;
  onSignIn: () => void;
  onShare: () => void;
  onCancel: () => void;
}

/**
 * The connect page as a checkout window: who is asking, named from Moolam's
 * list or called unlisted with its exact origin; the exact address that would
 * go; Share as the one button and Cancel as a quiet link under it. The
 * presses are the panel's own, so the address still goes to the one origin
 * that asked and only on Share (P22).
 */
export function ConnectCheckout({
  asker,
  wallet,
  phase,
  hasOpener,
  heading,
  closing,
  onSignIn,
  onShare,
  onCancel,
}: ConnectCheckoutProps) {
  const t = useTranslations("connect");
  const windowWords = useTranslations("checkout");
  const reduced = useIsReducedMotion();
  const listed = asker.name !== null;
  const origin = asker.origin;
  const name = asker.name ?? "";
  const rise = (delay: number) =>
    reduced
      ? { initial: false as const, animate: { opacity: 1, y: 0 }, transition: { duration: 0 } }
      : { initial: { opacity: 0, y: 18 }, animate: { opacity: 1, y: 0 }, transition: { duration: 0.6, ease: EASE, delay } };

  const lock = origin === null ? null : listed ? windowWords("lockListed", { platform: name }) : windowWords("lockUnnamed");
  const done = phase === "shared" || phase === "cancelled";

  return (
    <article
      data-connect-state={phase}
      data-listed={listed}
      data-checkout
      data-lenis-prevent
      className={CHECKOUT_SHELL}
    >
      <CheckoutBar lock={lock} listed={listed} />

      <div className="relative isolate flex-1 overflow-x-clip">
        <span
          aria-hidden
          className="pointer-events-none absolute -end-28 -top-32 -z-10 h-80 w-80 rounded-full bg-[radial-gradient(circle,var(--accent-soft),transparent_65%)]"
        />
        <div className={`${CHECKOUT_COLUMN} pb-6 pt-6`}>
          <motion.p
            {...rise(0)}
            className="flex items-center gap-2.5 font-mono text-[10px] uppercase tracking-[0.24em] text-accent"
          >
            <span className="motif h-[9px] w-[9px]" />
            {t("kicker")}
          </motion.p>
          <motion.h1
            {...rise(0.06)}
            className="mt-3 break-words font-display text-[clamp(1.75rem,7.2vw,2.5rem)] font-semibold leading-[0.95] tracking-[-0.04em]"
          >
            {heading}
          </motion.h1>

          {origin === null ? (
            <p className="mt-6 text-base leading-relaxed text-text">{t("invalidLine")}</p>
          ) : (
            <>
              <motion.div {...rise(0.12)} className="mt-5">
                <p className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.22em] text-text-muted">
                  {listed ? (
                    <span aria-hidden className="motif h-[8px] w-[8px]" />
                  ) : (
                    <span aria-hidden className="h-[8px] w-[8px] border border-dashed border-text-muted" />
                  )}
                  {listed ? t("listedLabel") : t("unlistedLabel")}
                </p>
                <p data-asking-origin={origin} className="mt-1.5 break-all font-mono text-[11px] text-text">
                  {origin}
                </p>
                <p className="mt-2 text-base leading-relaxed text-text-muted">{listed ? t("listedLine") : t("unlistedLine")}</p>
              </motion.div>

              <motion.div
                {...rise(0.18)}
                className="grain relative mt-6 border border-line-strong bg-bg-raised/80 p-4 backdrop-blur-sm"
              >
                <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-text-muted">{t("account")}</p>
                {wallet !== null && phase !== "signIn" ? (
                  <>
                    <p
                      data-exact-address={wallet}
                      className="mt-3 flex flex-wrap gap-x-[0.45em] gap-y-0.5 font-mono text-[clamp(1rem,4.4vw,1.2rem)] leading-snug tracking-[0.02em] text-text"
                    >
                      {addressGroups(wallet).map((group, index) => (
                        <span key={index} className={index === 0 ? "text-text-faint" : ""}>
                          {group}
                        </span>
                      ))}
                    </p>
                    <p className="mt-2 text-base leading-relaxed text-text-muted">{t("exactly")}</p>
                  </>
                ) : phase === "signIn" ? (
                  <p className="mt-3 text-base leading-relaxed text-text">{t("signInLine")}</p>
                ) : (
                  <p className="mt-3 flex items-center gap-3 text-base leading-relaxed text-text-muted">
                    <span aria-hidden className="motif h-[9px] w-[9px] motion-safe:animate-pulse" />
                    {t("opening")}
                  </p>
                )}
                <Relay sent={phase === "shared"} cancelled={phase === "cancelled"} to={listed ? name : t("unlistedName")} reduced={reduced} />
              </motion.div>

              <p className="mt-5 text-base leading-relaxed text-text-muted">
                {listed ? t("usesListed", { name }) : t("usesUnlisted")}
              </p>
            </>
          )}
        </div>
      </div>

      {origin === null ? null : (
        <div className={CHECKOUT_DOCK}>
          <div className={CHECKOUT_COLUMN}>
            <StateSwap
              state={done ? `${phase}-${closing}` : hasOpener === null ? "reading" : hasOpener ? `ask-${phase === "signIn" ? "in" : "share"}` : "no-opener"}
            >
              {done ? (
                <>
                  <Kicker tone={phase === "shared" ? "done" : "stop"}>
                    {phase === "shared" ? t("sharedKicker") : t("cancelledKicker")}
                  </Kicker>
                  <div className="mt-2.5">
                    {closing === "idle" ? (
                      <p className="text-base leading-relaxed text-text">
                        {phase === "shared"
                          ? listed
                            ? t("sharedListed", { name, origin })
                            : t("sharedUnlisted", { origin })
                          : listed
                            ? t("cancelledListed", { name })
                            : t("cancelledUnlisted")}
                      </p>
                    ) : (
                      <DoneLine closing={closing} platform={listed ? name : null} />
                    )}
                  </div>
                </>
              ) : hasOpener === null ? null : !hasOpener ? (
                <>
                  <Kicker tone="stop">{t("noOpenerKicker")}</Kicker>
                  <p className="mt-2.5 text-base leading-relaxed text-text">{t("noOpenerLine")}</p>
                </>
              ) : (
                <div className="flex flex-col gap-1.5">
                  <p className="mb-2.5 break-words text-base leading-relaxed text-text-faint">{t("shareNote", { origin })}</p>
                  {phase === "signIn" ? (
                    <button type="button" onClick={onSignIn} data-connect-sign-in className={`${PRIMARY} w-full justify-center`}>
                      <span aria-hidden className="motif h-[14px] w-[14px] bg-accent-ink" />
                      {t("signIn")}
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={onShare}
                      disabled={phase !== "ready"}
                      data-connect-share
                      className={`${PRIMARY} w-full justify-center`}
                    >
                      <span aria-hidden className="motif h-[14px] w-[14px] bg-accent-ink" />
                      {t("share")}
                    </button>
                  )}
                  <button type="button" onClick={onCancel} data-connect-cancel className={QUIET}>
                    {t("cancel")}
                  </button>
                </div>
              )}
            </StateSwap>
          </div>
        </div>
      )}
    </article>
  );
}

/**
 * The hand-over, drawn small: a rail from this account to the site that
 * asked, and the kolam that crosses it once, only when Share is pressed. A
 * cancelled window leaves the rail broken and the mark at home.
 */
function Relay({ sent, cancelled, to, reduced }: { sent: boolean; cancelled: boolean; to: string; reduced: boolean }) {
  return (
    <div aria-hidden data-hand-over={sent ? "sent" : cancelled ? "kept" : "waiting"} className="mt-4 border-t border-line pt-3">
      <div className="relative h-5">
        <span
          className={`absolute inset-x-2.5 top-1/2 h-px ${
            cancelled ? "border-t border-dashed border-line-strong opacity-60" : sent ? "bg-verified" : "bg-line-strong"
          }`}
        />
        <span className="absolute end-0 top-0 h-5 w-5 border border-dashed border-line-strong" />
        <motion.span
          className="absolute top-0 flex h-5 w-5"
          initial={false}
          animate={{ left: sent ? "calc(100% - 1.25rem)" : "0%", scale: sent ? 1.1 : 1 }}
          transition={reduced ? { duration: 0 } : { duration: 0.9, ease: EASE }}
        >
          <span className={`motif h-full w-full ${sent ? "bg-verified" : ""}`} />
        </motion.span>
      </div>
      <p className="mt-2 truncate text-end font-mono text-[10px] uppercase tracking-[0.2em] text-text-faint">{to}</p>
    </div>
  );
}
