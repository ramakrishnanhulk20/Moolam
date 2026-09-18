"use client";

import { motion } from "framer-motion";
import { useTranslations } from "next-intl";
import { ConsentChoice } from "@/components/consent/ConsentChoice";
import { draftProblem, type ConsentDraft } from "@/components/consent/draft";
import { useHeadingLeading } from "./leading";

/**
 * Where a creator says how AI may use the picture, at the moment they make it.
 *
 * It is the same control the passport page gives the holder, a size down, so a
 * statement made here and a statement made later are the same three choices and
 * the same four uses. What is said here travels further though: it goes into the
 * signed file before anything is registered, and then onto the chain.
 *
 * Saying nothing is a real answer and the one this opens on. The line under the
 * plates says plainly what silence means, because a creator who never noticed
 * this block should not later find they gave permission by not speaking.
 */
export function ConsentField({
  draft,
  onChange,
  disabled = false,
}: {
  draft: ConsentDraft;
  onChange: (draft: ConsentDraft) => void;
  /** True while a send is out, when nothing on the panel may be changed under it. */
  disabled?: boolean;
}) {
  const t = useTranslations("studio.consent");
  const leading = useHeadingLeading("leading-[1.02]", "leading-[1.22]");
  const problem = draftProblem(draft);

  return (
    <motion.div
      initial={{ opacity: 0, y: 18 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, amount: 0.25 }}
      transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
      className="relative mt-10 border-t border-line pt-8"
    >
      <span aria-hidden className="pointer-events-none absolute -top-px start-0 h-px w-20 bg-accent" />

      <p className="flex items-center gap-3 font-mono text-[10px] uppercase tracking-[0.24em] text-accent">
        <span className="motif h-[8px] w-[8px]" />
        {t("kicker")}
      </p>
      <h3
        className={`mt-4 max-w-[18ch] font-display text-[clamp(1.3rem,2.6vw,1.9rem)] font-semibold uppercase tracking-[-0.025em] ${leading}`}
      >
        {t("heading")}
      </h3>
      <p className="mt-3 max-w-[54ch] text-sm leading-relaxed text-text-muted">{t("body")}</p>

      <ConsentChoice draft={draft} onChange={onChange} disabled={disabled} size="compact" className="mt-6" />

      <p className="mt-5 max-w-[56ch] text-xs leading-relaxed text-text-faint">{t("hint")}</p>

      {problem === "conditionsRequired" ? (
        <p role="status" className="mt-3 max-w-[56ch] text-xs leading-relaxed text-failed">
          {t("needsConditions")}
        </p>
      ) : null}
    </motion.div>
  );
}
