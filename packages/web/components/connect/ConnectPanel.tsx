"use client";

import { motion } from "framer-motion";
import { useTranslations } from "next-intl";
import { useState, useSyncExternalStore } from "react";
import type { Hex } from "viem";
import { EASE, Kicker, PRIMARY, SECONDARY, StateSwap } from "@/components/cosign/Marks";
import { useIsReducedMotion } from "@/components/motion/useIsReducedMotion";
import { currentOpener, postAddress } from "@/lib/cosign/opener";
import { useCheckoutWindow, useCloseWhenDone } from "@/lib/cosign/popup";
import type { OriginAsker } from "@/lib/data/platform-label";
import { ConnectCheckout } from "./ConnectCheckout";

const noChange = () => () => undefined;

/** Where the page is: waiting for the account, asking to sign in, ready to share, or done either way. */
export type ConnectPhase = "opening" | "signIn" | "ready" | "shared" | "cancelled";

/** An address cut into fours, so a person can compare it with another screen group by group. */
export function addressGroups(address: string): string[] {
  const body = address.slice(2);
  const groups = ["0x"];
  for (let at = 0; at < body.length; at += 4) {
    groups.push(body.slice(at, at + 4));
  }
  return groups;
}

/**
 * The connect page: a site asks for the person's Moolam address so it can
 * hand them passports later. The address is printed in full, cut into fours;
 * who asks is named from Moolam's list or called an unlisted site, with the
 * exact origin shown; and the kolam crosses from one card to the other only
 * when Share is pressed (P22). Nothing is posted before that press, only to
 * the one origin that asked, and never on Cancel. Nothing is ever read from
 * the opener.
 */
export function ConnectPanel({
  asker,
  wallet,
  signedIn,
  onSignIn,
  checkout,
}: {
  asker: OriginAsker;
  /** The signed-in account's embedded wallet, checksummed, or null while there is none. */
  wallet: Hex | null;
  signedIn: boolean | null;
  onSignIn: () => void;
  /** Draws the checkout window whatever the window is. Left out, the window itself decides. */
  checkout?: boolean;
}) {
  const t = useTranslations("connect");
  const reduced = useIsReducedMotion();
  const [done, setDone] = useState<"shared" | "cancelled" | null>(null);
  // Null on the server and for the render being hydrated, so both paint the
  // same; the browser answers straight after. window.opener does not change
  // while the page lives, so there is nothing to subscribe to.
  const hasOpener = useSyncExternalStore(
    noChange,
    () => currentOpener() !== null,
    () => null,
  );

  const inWindow = useCheckoutWindow();
  const compact = checkout ?? inWindow;
  // Share sets done only after postAddress went out, and Cancel sends nothing, so either way nothing is left to send.
  const closing = useCloseWhenDone(compact, done !== null);

  const phase: ConnectPhase =
    done ?? (signedIn === false ? "signIn" : signedIn === null || wallet === null ? "opening" : "ready");
  const listed = asker.name !== null;
  const origin = asker.origin;
  const name = asker.name ?? "";

  const share = () => {
    if (wallet === null || phase !== "ready") return;
    if (postAddress(currentOpener(), origin, wallet)) setDone("shared");
  };

  const heading =
    origin === null
      ? t("headingInvalid")
      : listed
        ? t.rich("headingListed", { name, accent: (chunks) => <span className="text-accent">{chunks}</span> })
        : t("headingUnlisted");

  if (compact) {
    return (
      <ConnectCheckout
        asker={asker}
        wallet={wallet}
        phase={phase}
        hasOpener={hasOpener}
        heading={heading}
        closing={closing}
        onSignIn={onSignIn}
        onShare={share}
        onCancel={() => setDone("cancelled")}
      />
    );
  }

  return (
    <article
      data-connect-state={phase}
      data-listed={listed}
      className="@container grain relative isolate overflow-clip bg-bg text-text"
    >
      <span
        aria-hidden
        className="pointer-events-none absolute -end-[12cqw] -top-[14cqw] -z-10 h-[52cqw] w-[52cqw] rounded-full bg-[radial-gradient(circle,var(--accent-soft),transparent_65%)]"
      />
      <div className="px-5 pb-10 pt-10 @3xl:px-10 @5xl:px-14 @5xl:pb-16 @5xl:pt-16">
        <motion.p
          initial={reduced ? false : { opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={reduced ? { duration: 0 } : { duration: 0.6, ease: EASE }}
          className="flex items-center gap-3 font-mono text-[11px] uppercase tracking-[0.28em] text-accent"
        >
          <span className="motif h-[10px] w-[10px]" />
          {t("kicker")}
        </motion.p>
        <motion.h1
          initial={reduced ? false : { opacity: 0, y: 24 }}
          animate={{ opacity: 1, y: 0 }}
          transition={reduced ? { duration: 0 } : { duration: 0.8, ease: EASE, delay: 0.06 }}
          className="mt-5 max-w-[17ch] break-words font-display text-[clamp(2.3rem,6cqw,5.6rem)] font-semibold leading-[0.92] tracking-[-0.045em]"
        >
          {heading}
        </motion.h1>
        {origin === null ? null : (
          <p className="mt-5 break-all font-mono text-[11px] tracking-[0.12em] text-text-muted">
            {t("askingFrom", { origin })}
          </p>
        )}

        {origin === null ? (
          <p className="mt-8 max-w-[62ch] text-base leading-relaxed text-text">{t("invalidLine")}</p>
        ) : (
          <>
            <div className="mt-10 grid items-stretch gap-4 @4xl:grid-cols-[minmax(0,1.25fr)_minmax(5rem,0.35fr)_minmax(0,1fr)] @4xl:gap-0">
              <div className="min-w-0 border border-line-strong bg-bg-raised/80 p-5 backdrop-blur-sm @3xl:p-7">
                <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-text-muted">{t("account")}</p>
                {wallet !== null && phase !== "signIn" ? (
                  <>
                    <p
                      data-exact-address={wallet}
                      className="mt-4 flex flex-wrap gap-x-[0.45em] gap-y-1 font-mono text-[clamp(1.05rem,2.2cqw,1.7rem)] leading-snug tracking-[0.02em] text-text"
                    >
                      {addressGroups(wallet).map((group, index) => (
                        <span key={index} className={index === 0 ? "text-text-faint" : ""}>
                          {group}
                        </span>
                      ))}
                    </p>
                    <p className="mt-4 text-base leading-relaxed text-text-muted">{t("exactly")}</p>
                  </>
                ) : phase === "signIn" ? (
                  <>
                    <p className="mt-4 text-base leading-relaxed text-text">{t("signInLine")}</p>
                    <button type="button" onClick={onSignIn} data-connect-sign-in className={`${PRIMARY} mt-5`}>
                      <span aria-hidden className="motif h-[14px] w-[14px] bg-accent-ink" />
                      {t("signIn")}
                    </button>
                  </>
                ) : (
                  <p className="mt-4 flex items-center gap-3 text-base leading-relaxed text-text-muted">
                    <span aria-hidden className="motif h-[9px] w-[9px] motion-safe:animate-pulse" />
                    {t("opening")}
                  </p>
                )}
              </div>

              <HandOver sent={phase === "shared"} cancelled={phase === "cancelled"} reduced={reduced} />

              <div className="min-w-0 border border-line-strong bg-bg-raised/80 p-5 backdrop-blur-sm @3xl:p-7">
                <p className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.22em] text-text-muted">
                  {listed ? (
                    <span aria-hidden className="motif h-[8px] w-[8px]" />
                  ) : (
                    <span aria-hidden className="h-[8px] w-[8px] border border-dashed border-text-muted" />
                  )}
                  {listed ? t("listedLabel") : t("unlistedLabel")}
                </p>
                <p className="mt-4 break-words font-display text-[clamp(1.3rem,2.4cqw,2rem)] font-semibold leading-tight tracking-[-0.025em]">
                  {listed ? name : t("unlistedName")}
                </p>
                <p data-asking-origin={origin} className="mt-1.5 break-all font-mono text-[11px] text-text-muted">
                  {origin}
                </p>
                <p className="mt-4 text-base leading-relaxed text-text-muted">
                  {listed ? t("listedLine") : t("unlistedLine")}
                </p>
              </div>
            </div>

            <p className="mt-8 max-w-[62ch] text-base leading-relaxed text-text">
              {listed ? t("usesListed", { name }) : t("usesUnlisted")}
            </p>

            <StateSwap state={phase === "shared" || phase === "cancelled" ? phase : hasOpener === null ? "reading" : hasOpener ? "ask" : "no-opener"} className="mt-8">
              {phase === "shared" ? (
                <>
                  <Kicker tone="done">{t("sharedKicker")}</Kicker>
                  <p className="mt-3 max-w-[60ch] text-base leading-relaxed text-text">
                    {listed ? t("sharedListed", { name, origin }) : t("sharedUnlisted", { origin })}
                  </p>
                </>
              ) : phase === "cancelled" ? (
                <>
                  <Kicker tone="stop">{t("cancelledKicker")}</Kicker>
                  <p className="mt-3 max-w-[60ch] text-base leading-relaxed text-text">
                    {listed ? t("cancelledListed", { name }) : t("cancelledUnlisted")}
                  </p>
                </>
              ) : hasOpener === null ? null : !hasOpener ? (
                <>
                  <Kicker tone="stop">{t("noOpenerKicker")}</Kicker>
                  <p className="mt-3 max-w-[60ch] text-base leading-relaxed text-text">{t("noOpenerLine")}</p>
                </>
              ) : (
                <>
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
                    <button
                      type="button"
                      onClick={share}
                      disabled={phase !== "ready" || hasOpener !== true}
                      data-connect-share
                      className={PRIMARY}
                    >
                      <span aria-hidden className="motif h-[14px] w-[14px] bg-accent-ink" />
                      {t("share")}
                    </button>
                    <button type="button" onClick={() => setDone("cancelled")} data-connect-cancel className={SECONDARY}>
                      {t("cancel")}
                    </button>
                  </div>
                  <p className="mt-4 max-w-[60ch] break-words text-base leading-relaxed text-text-faint">
                    {t("shareNote", { origin })}
                  </p>
                </>
              )}
            </StateSwap>
          </>
        )}
      </div>
    </article>
  );
}

/**
 * The gap between the two cards: a rule the kolam crosses once, left to right
 * on a laptop and top to bottom on a phone, when the address is sent. A
 * cancelled page leaves the rule broken and the mark at home.
 */
function HandOver({ sent, cancelled, reduced }: { sent: boolean; cancelled: boolean; reduced: boolean }) {
  const rule = cancelled ? "opacity-40" : sent ? "bg-verified" : "bg-line-strong";
  // The knot's own rule pins it to position relative, so each travelling mark is
  // a positioned wrapper with the knot inside it.
  const mark = "absolute flex h-5 w-5 -translate-x-1/2 -translate-y-1/2";
  const knot = <span className={`motif h-full w-full ${sent ? "bg-verified" : ""}`} />;
  const move = reduced ? { duration: 0 } : { duration: 0.9, ease: EASE };

  return (
    <div aria-hidden data-hand-over={sent ? "sent" : cancelled ? "kept" : "waiting"} className="relative h-20 @4xl:h-auto">
      <span
        className={`absolute left-1/2 top-0 h-full w-px ${rule} ${
          cancelled ? "border-s border-dashed border-line-strong" : ""
        } @4xl:hidden`}
      />
      <span
        className={`absolute left-0 top-1/2 hidden h-px w-full ${rule} ${
          cancelled ? "border-t border-dashed border-line-strong" : ""
        } @4xl:block`}
      />
      <motion.span
        className={`${mark} left-1/2 @4xl:hidden`}
        initial={false}
        animate={{ top: sent ? "88%" : "12%", scale: sent ? 1.15 : 1 }}
        transition={move}
      >
        {knot}
      </motion.span>
      <motion.span
        className={`${mark} top-1/2 hidden @4xl:block`}
        initial={false}
        animate={{ left: sent ? "88%" : "12%", scale: sent ? 1.15 : 1 }}
        transition={move}
      >
        {knot}
      </motion.span>
    </div>
  );
}
