"use client";

import { motion, useReducedMotion } from "framer-motion";
import { useFormatter, useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import type { Hex } from "viem";
import { MONAD_EXPLORER, shortHex } from "@/lib/chain/client";
import { NOTHING_STATED } from "@/lib/chain/consent";
import { ConsentChoice } from "@/components/consent/ConsentChoice";
import type { LedgerAnswer } from "@/components/consent/ledger";
import { draftProblem, sameAsStanding, type ConsentDraft } from "@/components/consent/draft";
import { useSetConsent, type SetConsent } from "@/lib/consent/useSetConsent";

/**
 * The holder's panel itself, in a file of its own so that nothing on a passport
 * page reaches the wallet SDK until this component is asked for.
 * ConsentPanel.tsx holds the gate and pulls this in.
 */
export function ConsentEditor({
  passportId,
  owner,
  standing,
  minInterval,
}: {
  passportId: Hex;
  owner: Hex | null;
  standing: LedgerAnswer;
  minInterval: number;
}) {
  const consent = useSetConsent({
    passportId,
    owner,
    standing: { writer: standing.entry?.writer, at: standing.entry?.at },
    minInterval,
  });

  if (!consent.ready || !consent.isHolder) {
    return null;
  }

  return <Panel consent={consent} standing={standing} />;
}

function Panel({ consent, standing }: { consent: SetConsent; standing: LedgerAnswer }) {
  const t = useTranslations("passport.consent.control");
  const format = useFormatter();
  const calm = useReducedMotion() === true;

  // The control opens on what the register already holds, so a holder changes
  // their own statement rather than starting from a default that is not theirs.
  const held: ConsentDraft | null =
    standing.entry === null
      ? null
      : { consent: standing.entry.consent, constraintInfo: standing.entry.constraintInfo };
  const [draft, setDraft] = useState<ConsentDraft>(held ?? { consent: NOTHING_STATED, constraintInfo: "" });

  // The clock is read in an effect and never during a render, and the control
  // unlocks itself the moment the register's ten minutes are up rather than
  // waiting for the holder to reload the page. It starts locked, because
  // wrongly offering the button is the worse of the two first paints.
  const [now, setNow] = useState(0);
  useEffect(() => {
    const tick = () => setNow(Math.floor(Date.now() / 1000));
    tick();

    const opens = consent.opensAt;
    if (opens === null) {
      return;
    }
    const waitMs = opens * 1_000 - Date.now() + 500;
    if (waitMs <= 0) {
      return;
    }
    const timer = setTimeout(tick, waitMs);
    return () => clearTimeout(timer);
  }, [consent.opensAt]);

  const { state } = consent;
  const locked = consent.opensAt !== null && consent.opensAt > now;
  const problem = draftProblem(draft);
  const unchanged = sameAsStanding(draft, held);
  const sent = state.step === "done";

  return (
    <motion.section
      data-consent-panel
      initial={calm ? false : { opacity: 0, y: 28 }}
      whileInView={calm ? undefined : { opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-60px" }}
      transition={{ duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
      className="relative mt-20 border border-s-2 border-line border-s-accent bg-bg-raised p-6 sm:p-8"
    >
      <p className="flex items-center gap-3 font-mono text-[11px] uppercase tracking-[0.24em] text-accent">
        <span className="motif h-[9px] w-[9px]" />
        {t("kicker")}
      </p>
      <h3 className="mt-5 max-w-[20ch] font-display text-[clamp(1.5rem,3vw,2.3rem)] font-semibold uppercase leading-[1.02] tracking-[-0.03em]">
        {t("heading")}
      </h3>
      <p className="mt-5 max-w-[54ch] text-sm leading-relaxed text-text-muted">{t("body")}</p>

      <ConsentChoice draft={draft} onChange={setDraft} disabled={consent.busy} className="mt-8" />

      <div className="mt-9 flex flex-wrap items-center gap-x-5 gap-y-4">
        <button
          type="button"
          onClick={() => void consent.actions.submit(draft)}
          disabled={consent.busy || locked || unchanged || problem !== null}
          className="rounded-[8px] bg-accent px-6 py-3.5 text-xs font-semibold uppercase tracking-[0.16em] text-accent-ink transition-transform duration-200 hover:-translate-y-0.5 disabled:translate-y-0 disabled:opacity-50"
        >
          {t("submit")}
        </button>

        {consent.busy ? (
          <p className="flex items-center gap-3 font-mono text-[11px] uppercase tracking-[0.16em] text-accent">
            <span aria-hidden className="inline-block h-2 w-2 animate-pulse bg-accent" />
            {t(`steps.${state.step === "done" ? "confirming" : state.step}`)}
          </p>
        ) : null}
      </div>

      {/* One line under the button, and only ever one: whichever is the reason
          this holder cannot press it right now. */}
      <p className="mt-4 max-w-[54ch] text-xs leading-relaxed text-text-faint">
        {locked && consent.opensAt !== null
          ? t("locked", { at: format.dateTime(new Date(consent.opensAt * 1000), "time") })
          : problem === "conditionsRequired"
            ? t("needsConditions")
            : unchanged
              ? t("unchanged")
              : t("fee")}
      </p>

      {sent ? (
        <motion.div
          initial={calm ? false : { opacity: 0, y: 10 }}
          animate={calm ? undefined : { opacity: 1, y: 0 }}
          transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
          role="status"
          className="mt-7 border-s-2 border-verified bg-verified/5 py-3 ps-4"
        >
          <p className="max-w-[54ch] text-sm leading-relaxed text-verified">
            {t("done", {
              when:
                state.at === null
                  ? ""
                  : format.dateTime(new Date(state.at * 1000), "moment"),
            })}
          </p>
          {state.hash === undefined ? null : (
            <a
              href={`${MONAD_EXPLORER}/tx/${state.hash}`}
              target="_blank"
              rel="noreferrer"
              className="mt-4 inline-block rounded-[8px] border border-line px-4 py-2 font-mono text-[10px] uppercase tracking-[0.18em] text-text-muted transition-colors duration-200 hover:border-accent hover:text-accent"
            >
              {t("openTx", { hash: shortHex(state.hash) })}
            </a>
          )}
        </motion.div>
      ) : null}

      {state.failure === null ? null : <Failure consent={consent} />}
    </motion.section>
  );
}

/** One failure: the sentence, the register's own word under it, and the single thing worth doing next. */
function Failure({ consent }: { consent: SetConsent }) {
  const t = useTranslations("passport.consent");
  const control = useTranslations("passport.consent.control");
  const format = useFormatter();
  const failure = consent.state.failure;
  if (failure === null) {
    return null;
  }

  const handlers: Record<string, (() => void) | undefined> = {
    recheck: () => void consent.actions.recheck(),
    signIn: consent.actions.signIn,
  };
  const action = failure.next === undefined ? undefined : handlers[failure.next];

  // A statement that is still out is not a statement that failed, so it keeps
  // the muted ink and the status role rather than the alarm.
  const pending = failure.key === "confirmPending";
  const key = t.has(`failure.${failure.key}`) ? failure.key : "unknown";

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
      role={pending ? "status" : "alert"}
      data-tone={pending ? "pending" : "failed"}
      className={`mt-7 border-s-2 py-3 ps-4 ${pending ? "border-text-muted bg-text-muted/5" : "border-failed bg-failed/10"}`}
    >
      <p className={`max-w-[54ch] text-sm leading-relaxed ${pending ? "text-text-muted" : "text-failed"}`}>
        {t(`failure.${key}`, {
          at: failure.at === undefined ? "" : format.dateTime(new Date(failure.at * 1000), "time"),
        })}
      </p>
      {failure.reason === undefined ? null : (
        <p className="mt-2 max-w-[54ch] break-words font-mono text-[11px] leading-relaxed text-text-faint">
          {failure.reason}
        </p>
      )}
      {failure.address === undefined ? null : (
        <a
          href={`${MONAD_EXPLORER}/address/${failure.address}`}
          target="_blank"
          rel="noreferrer"
          className="mt-4 block font-mono text-[11px] text-text-faint underline decoration-line underline-offset-4 transition-colors duration-200 hover:text-accent"
        >
          {control("openAddress", { wallet: shortHex(failure.address) })}
        </a>
      )}
      {action === undefined ? null : (
        <button
          type="button"
          onClick={action}
          className="mt-4 rounded-[8px] border border-line px-4 py-2 text-[11px] uppercase tracking-[0.18em] text-text-muted transition-colors duration-200 hover:border-accent hover:text-accent"
        >
          {control(`actions.${failure.next}`)}
        </button>
      )}
    </motion.div>
  );
}
