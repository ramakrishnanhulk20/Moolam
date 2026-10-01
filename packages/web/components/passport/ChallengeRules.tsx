"use client";

import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { formatEther, type Hex } from "viem";
import { HEX_MARK, withHex } from "@/components/agents/hex";
import { shortHex } from "@/lib/chain/client";
import { bondFate } from "@/lib/disputes/flag";

/**
 * The parts of the challenge panel every reader may see: the frame with its
 * toggle, the opening that names the bond, what a challenge needs and who
 * decides it, and the sign-in offer for a reader with no session. They live
 * apart from Challenge.tsx so a stranger's page draws them without the wallet
 * SDK that file pulls in.
 */

const EASE = [0.16, 1, 0.3, 1] as const;

/** The section and its toggle: one line until somebody opens it, then the panel inside a dispute-coloured frame. */
export function ChallengeFrame({ open, onToggle, children }: { open: boolean; onToggle: () => void; children: ReactNode }) {
  const t = useTranslations("passport.dispute.flag");
  const calm = useReducedMotion() === true;

  return (
    <section data-dispute-panel className="mt-12 border-t border-line pt-6">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="group flex items-center gap-3 font-mono text-[11px] uppercase tracking-[0.24em] text-text-faint transition-colors duration-200 hover:text-disputed"
      >
        <span
          aria-hidden
          className={`h-[9px] w-[9px] border border-current transition-transform duration-300 ${
            open ? "rotate-45 bg-disputed" : "group-hover:rotate-45"
          }`}
        />
        <span className="underline decoration-line underline-offset-[6px] transition-colors duration-200 group-hover:decoration-disputed">
          {open ? t("close") : t("link")}
        </span>
      </button>

      <AnimatePresence initial={false}>
        {open ? (
          <motion.div
            key="open"
            initial={calm ? false : { opacity: 0, height: 0 }}
            animate={calm ? undefined : { opacity: 1, height: "auto" }}
            exit={calm ? undefined : { opacity: 0, height: 0 }}
            transition={{ duration: 0.5, ease: EASE }}
            className="overflow-hidden"
          >
            <div className="mt-7 border-s-2 border-disputed bg-disputed/5 p-6 sm:p-8">{children}</div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </section>
  );
}

/** The heading and the one sentence that names the bond, or says the policy sets it while the bond is still being read. */
export function ChallengeOpening({ bond }: { bond: bigint | null }) {
  const t = useTranslations("passport.dispute.flag");
  const amount = bond === null ? null : formatEther(bond);

  return (
    <>
      <h3 className="max-w-[22ch] font-display text-[clamp(1.4rem,2.6vw,2rem)] font-semibold uppercase leading-[1.02] tracking-[-0.03em]">
        {t("heading")}
      </h3>
      <p className="mt-5 max-w-[54ch] text-base leading-relaxed text-text-muted">
        {amount === null ? t("whatUnknown") : t("what", { bond: amount })}
      </p>
    </>
  );
}

const RULES = ["earlier", "proof", "verify", "licensed"] as const;

/**
 * What a challenge needs and who decides it, before the bond and the button.
 * The rules lead and the decider sits beside them, so a challenger reads the
 * burden of proof before they read the price.
 */
export function Rules({ treasury }: { treasury: Hex | null }) {
  const t = useTranslations("challenge");
  const calm = useReducedMotion() === true;
  const fate = bondFate(treasury);

  return (
    <div
      data-challenge-rules
      className="mt-8 grid gap-9 border-t border-line pt-6 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)] lg:gap-12"
    >
      <div className="min-w-0">
        <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-text-faint">{t("rules.heading")}</p>
        <ol className="mt-3 border-t border-line">
          {RULES.map((rule, index) => (
            <motion.li
              key={rule}
              data-rule={rule}
              initial={calm ? false : { opacity: 0, y: 12 }}
              animate={calm ? undefined : { opacity: 1, y: 0 }}
              transition={{ duration: 0.45, delay: 0.12 + index * 0.06, ease: EASE }}
              className="group grid grid-cols-[2.25rem_minmax(0,1fr)] items-baseline border-b border-line py-3.5"
            >
              <span className="font-mono text-[11px] tabular-nums text-disputed transition-transform duration-200 group-hover:translate-x-0.5">
                {String(index + 1).padStart(2, "0")}
              </span>
              <span className="text-base leading-relaxed text-text">{t(`rules.${rule}`)}</span>
            </motion.li>
          ))}
        </ol>
        <p className="mt-5 max-w-[54ch] border-s-2 border-disputed ps-4 text-base font-medium leading-relaxed text-text">
          {t("rules.burden")}
        </p>
      </div>

      <aside data-challenge-decider className="min-w-0 lg:border-s lg:border-line lg:ps-10">
        <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-text-faint">{t("decider.heading")}</p>
        <p className="mt-3 max-w-[46ch] text-base leading-relaxed text-text-muted">{t("decider.who")}</p>
        <p className="mt-3 max-w-[46ch] text-base leading-relaxed text-text-faint">{t("decider.seat")}</p>
        {fate === "burned" ? (
          <p data-bond-fate="burned" className="mt-3 max-w-[46ch] text-base leading-relaxed text-text-faint">
            {t("decider.bond")}
          </p>
        ) : fate === "treasury" && treasury !== null ? (
          <p data-bond-fate="treasury" className="mt-3 max-w-[46ch] text-base leading-relaxed text-text-faint">
            {withHex(t("decider.treasury", { treasury: HEX_MARK }), shortHex(treasury))}
          </p>
        ) : null}
      </aside>
    </div>
  );
}

/**
 * The action for a reader with no session, where the form would be: the rules
 * above are theirs to read, and the bond and the button come with an account.
 */
export function SignInToChallenge({ onSignIn }: { onSignIn: () => void }) {
  const t = useTranslations("passport.dispute.flag");

  return (
    <div data-challenge-sign-in className="mt-7 border-t border-line pt-6">
      <p className="max-w-[54ch] text-base leading-relaxed text-text-muted">{t("signedOut")}</p>
      <button
        type="button"
        onClick={onSignIn}
        className="mt-4 rounded-[8px] bg-disputed px-6 py-3.5 text-xs font-semibold uppercase tracking-[0.16em] text-bg transition-transform duration-200 hover:-translate-y-0.5"
      >
        {t("signInToChallenge")}
      </button>
    </div>
  );
}
