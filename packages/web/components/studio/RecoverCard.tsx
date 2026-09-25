"use client";

import { motion } from "framer-motion";
import { useTranslations } from "next-intl";
import type { Failure } from "@/lib/studio/problems";
import { FailureNote } from "./afterPress";
import { WaitLabel } from "./WaitLabel";
import { useHeadingLeading } from "./leading";

/**
 * A creator on a second browser. The chain says a passkey is bound and this
 * device has never seen it, which is normal, not broken: unlock once here and
 * the browser learns which credential belongs to this account.
 */
export function RecoverCard({
  busy,
  failure,
  onRecover,
  onBindInstead,
}: {
  busy: boolean;
  failure: Failure | null;
  onRecover: () => void;
  onBindInstead: () => void;
}) {
  const t = useTranslations("studio");
  const leading = useHeadingLeading("leading-[0.95]", "leading-[1.15]");

  return (
    <motion.section
      initial={{ opacity: 0, y: 24 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
      className="relative border border-line bg-bg-raised p-7 sm:p-10"
    >
      <p className="flex items-center gap-3 font-mono text-[11px] uppercase tracking-[0.24em] text-accent">
        <span className="motif h-[9px] w-[9px]" />
        {t("recover.kicker")}
      </p>

      <h2 className={`mt-5 max-w-[20ch] font-display text-[clamp(1.7rem,3.4vw,2.7rem)] font-semibold uppercase tracking-[-0.02em] ${leading}`}>
        {t("recover.heading")}
      </h2>
      <p className="mt-5 max-w-[56ch] text-base leading-relaxed text-text-muted">{t("recover.body")}</p>

      <div className="mt-8 flex flex-wrap items-center gap-4">
        <button
          type="button"
          onClick={onRecover}
          disabled={busy}
          className="rounded-[8px] bg-accent px-7 py-4 text-sm font-semibold uppercase tracking-[0.14em] text-accent-ink transition-transform duration-200 hover:-translate-y-0.5 disabled:translate-y-0 disabled:opacity-60"
        >
          {t("recover.button")}
        </button>
        <button
          type="button"
          onClick={onBindInstead}
          disabled={busy}
          className="rounded-[8px] border border-line px-5 py-3.5 text-xs uppercase tracking-[0.18em] text-text-muted transition-colors duration-200 hover:border-accent hover:text-accent disabled:opacity-60"
        >
          {t("recover.bindInstead")}
        </button>
      </div>

      {busy ? (
        <div className="mt-6">
          <WaitLabel text={t("recover.waiting")} />
        </div>
      ) : null}

      {failure === null ? null : (
        <div className="mt-7">
          <FailureNote failure={failure} onAgain={onRecover} onBind={onBindInstead} />
          <p className="mt-4 max-w-[54ch] text-sm leading-relaxed text-text-faint">{t("recover.otherDevice")}</p>
        </div>
      )}
    </motion.section>
  );
}
