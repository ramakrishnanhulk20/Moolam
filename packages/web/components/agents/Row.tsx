"use client";

import { motion } from "framer-motion";
import { useFormatter, useTranslations } from "next-intl";
import { useIsReducedMotion } from "@/components/motion/useIsReducedMotion";
import { Link } from "@/lib/i18n/routing";
import type { AgentRow } from "./roster";
import { PictureStrip } from "./PictureStrip";
import type { AgentStrip } from "./strip";

/**
 * One agent, as a line in a ledger rather than a card in a row of three.
 *
 * The trust score is the biggest thing on the line and it draws its own bar as
 * the line comes into view, because that number is the whole point of the page:
 * it is what the index has counted about an agent that signs pictures. Under
 * the name, the pictures it signed, so a reader sees what the agent makes
 * before reading how it has held up.
 *
 * The whole line opens the agent through the name's link, stretched over the
 * row. The strip's tiles and the Explore link stand above that stretch as links
 * of their own, because a link inside a link is not a thing a browser can draw.
 */
export function Row({ agent, place, strip = null }: { agent: AgentRow; place: number; strip?: AgentStrip | null }) {
  const t = useTranslations("agents");
  const format = useFormatter();
  const reduced = useIsReducedMotion();

  return (
    <motion.li
      initial={reduced ? false : { opacity: 0, y: 30 }}
      whileInView={reduced ? undefined : { opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-60px" }}
      transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1], delay: place * 0.08 }}
      className="group relative border-b border-line pt-8 sm:pt-10"
    >
      <div className="grid gap-x-12 gap-y-7 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] lg:items-center">
        <div className="min-w-0">
          <p className="flex items-center gap-3 font-mono text-[10px] uppercase tracking-[0.2em] text-text-faint">
            <span aria-hidden className="tabular-nums">
              {String(place + 1).padStart(2, "0")}
            </span>
            <span aria-hidden className="h-px w-6 bg-line-strong transition-all duration-500 group-hover:w-10 group-hover:bg-accent" />
            {t("agentId", { id: agent.id })}
          </p>

          {/* Sized for the longest name on the board, "Moolam generator on a
              Privy server wallet": two lines in the laptop column and three at
              most across a phone. The trust score beside it is the number the
              page is about, so the name no longer outweighs it. */}
          <h2
            data-agent-name
            className="mt-4 max-w-[26ch] font-display text-[clamp(1.35rem,2.6vw,2.1rem)] font-semibold uppercase leading-[1] tracking-[-0.03em] transition-colors duration-300 group-hover:text-accent"
          >
            <Link
              href={`/agent/${agent.id}`}
              data-agent-link
              className="outline-offset-4 after:absolute after:inset-0 after:content-['']"
            >
              {agent.name ?? t("unnamedTitle")}
            </Link>
          </h2>
          {/* A title is what a line in a ledger needs, so the sentence saying
              why there is no name sits under it, at reading size. */}
          {agent.name === null ? (
            <p data-agent-unnamed className="mt-2 text-base leading-relaxed text-text-muted">
              {t("unnamed")}
            </p>
          ) : null}

          <p className="mt-4 font-mono text-[10px] uppercase tracking-[0.18em] text-text-faint">
            {t("since", { when: format.dateTime(new Date(agent.firstSeenAt * 1000), { dateStyle: "medium" }) })}
          </p>

          {strip === null ? null : <PictureStrip strip={strip} />}
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
            <Count label={t("upheld")} value={agent.disputesUpheld} tone="disputed" />
          </dl>
        </div>
      </div>

      <Link
        href={`/explore/view?agent=${agent.id}`}
        className="relative z-10 mb-8 mt-7 inline-block font-mono text-[10px] uppercase tracking-[0.18em] text-text-muted transition-colors duration-200 hover:text-accent sm:mb-10 sm:mt-8"
      >
        {t("seeWorks")}
      </Link>
    </motion.li>
  );
}

const COUNT_TONE = { verified: "text-verified", failed: "text-failed", disputed: "text-disputed" } as const;

function Count({ label, value, tone }: { label: string; value: number; tone?: keyof typeof COUNT_TONE }) {
  const colour = value === 0 ? "text-text-muted" : tone === undefined ? "text-text" : COUNT_TONE[tone];

  return (
    <div className="min-w-0">
      <dt className="font-mono text-[10px] uppercase tracking-[0.2em] text-text-faint">{label}</dt>
      <dd className={`mt-2 font-display text-2xl tabular-nums ${colour}`}>{value}</dd>
    </div>
  );
}
