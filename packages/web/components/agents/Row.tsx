"use client";

import { motion } from "framer-motion";
import { useFormatter, useTranslations } from "next-intl";
import { useIsReducedMotion } from "@/components/motion/useIsReducedMotion";
import { Link } from "@/lib/i18n/routing";
import type { AgentRow } from "./roster";

/**
 * One agent, as a line in a ledger rather than a card in a row of three.
 *
 * The trust score is the biggest thing on the line and it draws its own bar as
 * the line comes into view, because that number is the whole point of the page:
 * it is what the index has counted about an agent that signs pictures.
 */
export function Row({ agent, place }: { agent: AgentRow; place: number }) {
  const t = useTranslations("agents");
  const format = useFormatter();
  const reduced = useIsReducedMotion();

  return (
    <motion.li
      initial={reduced ? false : { opacity: 0, y: 30 }}
      whileInView={reduced ? undefined : { opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-60px" }}
      transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1], delay: place * 0.08 }}
      className="group relative border-b border-line"
    >
      <Link href={`/agent/${agent.id}`} className="block py-8 sm:py-10">
        <div className="grid gap-x-12 gap-y-7 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] lg:items-center">
          <div className="min-w-0">
            <p className="flex items-center gap-3 font-mono text-[10px] uppercase tracking-[0.2em] text-text-faint">
              <span aria-hidden className="tabular-nums">
                {String(place + 1).padStart(2, "0")}
              </span>
              <span aria-hidden className="h-px w-6 bg-line-strong transition-all duration-500 group-hover:w-10 group-hover:bg-accent" />
              {t("agentId", { id: agent.id })}
            </p>

            <h2 className="mt-4 max-w-[18ch] font-display text-[clamp(1.7rem,4vw,2.9rem)] font-semibold uppercase leading-[0.95] tracking-[-0.035em] transition-colors duration-300 group-hover:text-accent">
              {agent.name ?? t("unnamed")}
            </h2>

            <p className="mt-4 font-mono text-[10px] uppercase tracking-[0.18em] text-text-faint">
              {t("since", { when: format.dateTime(new Date(agent.firstSeenAt * 1000), { dateStyle: "medium" }) })}
            </p>
          </div>

          <div className="min-w-0">
            <div className="flex items-end gap-6">
              <p className="font-display text-[clamp(3rem,8vw,5rem)] font-semibold leading-[0.82] tracking-[-0.05em] tabular-nums text-accent">
                {agent.trustScore}
              </p>
              <p className="pb-2 font-mono text-[10px] uppercase tracking-[0.18em] text-text-faint">
                {t("trustScore")}
              </p>
            </div>

            <div aria-hidden className="mt-5 h-px w-full bg-line">
              <motion.div
                initial={{ scaleX: 0 }}
                whileInView={{ scaleX: agent.trustScore / 100 }}
                viewport={{ once: true }}
                transition={{ duration: reduced ? 0 : 1.1, ease: [0.16, 1, 0.3, 1], delay: reduced ? 0 : 0.2 }}
                style={{ transformOrigin: "left" }}
                className="h-px bg-accent"
              />
            </div>

            <dl className="mt-7 grid grid-cols-2 gap-x-8 gap-y-5 sm:grid-cols-4">
              <Count label={t("passports")} value={agent.passportCount} />
              <Count label={t("matched")} value={agent.matchedCount} tone="verified" />
              <Count label={t("mismatched")} value={agent.mismatchedCount} tone="failed" />
              <Count label={t("upheld")} value={agent.disputesUpheld} tone="failed" />
            </dl>
          </div>
        </div>
      </Link>

      {/* Outside the link above: a link inside a link is not a thing a browser can draw. */}
      <Link
        href={`/explore/view?agent=${agent.id}`}
        className="mb-8 inline-block font-mono text-[10px] uppercase tracking-[0.18em] text-text-muted transition-colors duration-200 hover:text-accent sm:mb-10"
      >
        {t("seeWorks")}
      </Link>
    </motion.li>
  );
}

function Count({ label, value, tone }: { label: string; value: number; tone?: "verified" | "failed" }) {
  const colour =
    value === 0 ? "text-text-muted" : tone === "verified" ? "text-verified" : tone === "failed" ? "text-failed" : "text-text";

  return (
    <div className="min-w-0">
      <dt className="font-mono text-[10px] uppercase tracking-[0.2em] text-text-faint">{label}</dt>
      <dd className={`mt-2 font-display text-2xl tabular-nums ${colour}`}>{value}</dd>
    </div>
  );
}
