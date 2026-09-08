"use client";

import { motion } from "framer-motion";
import { useLocale, useTranslations } from "next-intl";
import { useRef } from "react";
import { useIsReducedMotion } from "@/components/motion/useIsReducedMotion";
import { useScrubProgress } from "@/components/motion/useScrubProgress";
import { Eyebrow, Motif } from "@/components/hero/Motif";
import type { HeroStill } from "@/components/hero/still";
import { shortHex } from "@/lib/chain/client";
import { Link } from "@/lib/i18n/routing";

interface HeroPosterProps {
  still: HeroStill | null;
  passports: number | null;
  registry: string;
  chainId: number;
  /** Already formatted by the server so the two languages agree on the date. */
  stillDate: string | null;
}

const EASE = [0.16, 1, 0.3, 1] as const;

/**
 * The first screen: one still, full bleed, with the title sitting across it.
 *
 * The image drifts against the scroll through a custom property the scrub hook
 * writes onto the section, so the parallax costs one compositor transform and no
 * React render. Everything in the credits column is read from the chain.
 */
export function HeroPoster({ still, passports, registry, chainId, stillDate }: HeroPosterProps) {
  const section = useRef<HTMLElement>(null);
  const reduced = useIsReducedMotion();
  const t = useTranslations("hero");
  const locale = useLocale();

  // Tamil sets much wider than Latin at the same point size, and the same clamp
  // turns a two line title into four. The script gets its own optical size.
  const titleSize = locale === "ta" ? "clamp(2.25rem,6.4vw,6rem)" : "clamp(3rem,10vw,9rem)";

  // The entrance always starts from the hidden state so the server HTML and the
  // first client render agree. Someone asking for less motion gets it finished
  // rather than a shorter version of the same move.
  const enter = (duration: number, delay = 0) =>
    reduced ? { duration: 0.001, delay: 0 } : { duration, delay, ease: EASE };

  useScrubProgress(section, "--hero", { start: "top top", end: "bottom top" });

  const lines = [t("titleLineOne"), t("titleLineTwo")];

  const credits: { label: string; value: string; href?: string }[] = [
    ...(still === null
      ? []
      : [
          { label: t("credit.passport"), value: shortHex(still.passportId, 10, 8) },
          {
            label: t("credit.agent"),
            value: still.agentId === "0" ? t("credit.agentNone") : `#${still.agentId}`,
          },
          { label: t("credit.creator"), value: shortHex(still.creator, 8, 6) },
        ]),
    { label: t("credit.registry"), value: shortHex(registry, 8, 6) },
  ];

  return (
    <section ref={section} className="relative isolate min-h-[calc(100svh-var(--chrome,5rem))] overflow-hidden bg-bg-sunken">
      <div className="absolute inset-0 -z-10">
        {still === null ? (
          // SWAP: hero image. Nothing on the registry answered with a picture, so
          // the frame stays empty rather than showing something that is not real.
          <div className="absolute inset-0 bg-bg-sunken" />
        ) : (
          <div
            className="absolute inset-0"
            style={{ transform: "translate3d(0, calc(var(--hero, 0) * 16vh), 0)", willChange: "transform" }}
          >
            <motion.div
              className="h-full w-full"
              initial={{ scale: 1.16 }}
              animate={{ scale: 1.06 }}
              transition={enter(3.2)}
            >
              {/* eslint-disable-next-line @next/next/no-img-element -- the still
                  comes from whichever IPFS gateway the passport points at, which
                  is not a host next/image can be told about ahead of time. */}
              <img
                src={still.imageUrl}
                alt={t("stillAlt")}
                // Graded like a film still, and graded differently per theme:
                // on near-black the picture has to come down to sit under white
                // type, on paper it has to come up or the scrim erases it.
                className="h-full w-full object-cover [filter:brightness(1.02)_saturate(1.05)_contrast(1.02)] dark:[filter:brightness(0.56)_saturate(0.82)_contrast(1.06)]"
                fetchPriority="high"
              />
            </motion.div>
          </div>
        )}

        {/* Plain alpha rather than a blend mode: this layer moves with the scroll,
            and a blended one repaints the whole screen on every frame. */}
        <div className="grain absolute inset-0" style={{ ["--grain-blend" as string]: "normal" }} />

        {/* Two scrims, both mixed from the page background so they follow the
            theme, and both three stop so no edge shows where they run out. */}
        <div
          aria-hidden
          className="absolute inset-0 bg-[linear-gradient(to_top,var(--bg)_0%,color-mix(in_srgb,var(--bg)_58%,transparent)_36%,transparent_82%)]"
        />
        <div
          aria-hidden
          className="absolute inset-0 bg-[linear-gradient(to_right,var(--bg)_0%,color-mix(in_srgb,var(--bg)_46%,transparent)_44%,transparent_78%)]"
        />
        {/* A vignette, so the frame reads as a still rather than a screenshot. */}
        <div aria-hidden className="absolute inset-0 shadow-[inset_0_0_22vw_2vw_var(--bg)]" />
      </div>

      <div className="mx-auto flex min-h-[calc(100svh-var(--chrome,5rem))] w-full max-w-[100rem] flex-col justify-end px-5 pb-8 pt-24 sm:px-8 lg:px-14">
        <div className="grid gap-x-12 gap-y-10 lg:grid-cols-12 lg:items-end">
          <div className="lg:col-span-8 lg:-ml-[2.5vw]">
            <motion.div
              initial={{ opacity: 0, y: 14 }}
              animate={{ opacity: 1, y: 0 }}
              transition={enter(0.7)}
            >
              <Eyebrow>{t("kicker")}</Eyebrow>
            </motion.div>

            <h1
              className="mt-6 font-display font-bold uppercase leading-[0.92] tracking-[-0.04em]"
              style={{ fontSize: titleSize }}
            >
              {lines.map((line, index) => (
                <span key={line} className="block overflow-hidden pb-[0.06em]">
                  <motion.span
                    className="block"
                    initial={{ y: "110%" }}
                    animate={{ y: 0 }}
                    transition={enter(1.05, 0.12 + index * 0.11)}
                  >
                    {line}
                  </motion.span>
                </span>
              ))}
            </h1>

            <motion.p
              className="mt-8 max-w-[56ch] text-base leading-relaxed text-text-muted sm:text-lg"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={enter(0.9, 0.45)}
            >
              {t("lede")}
            </motion.p>

            <motion.div
              className="mt-10 flex flex-wrap gap-3"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={enter(0.9, 0.58)}
            >
              <Link
                href="/verify"
                className="group inline-flex items-center gap-3 rounded-[8px] bg-accent px-6 py-3 text-sm font-medium text-accent-ink transition-transform duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] hover:-translate-y-0.5"
              >
                {t("ctaVerify")}
                <span className="transition-transform duration-300 group-hover:translate-x-1">&rarr;</span>
              </Link>
              <Link
                href="/studio"
                className="inline-flex items-center rounded-[8px] border border-line-strong px-6 py-3 text-sm text-text transition-colors duration-300 hover:border-accent hover:text-accent"
              >
                {t("ctaStudio")}
              </Link>
            </motion.div>
          </div>

          <motion.dl
            className="space-y-3 border-l border-line pl-5 lg:col-span-4 lg:justify-self-end"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={enter(0.9, 0.7)}
          >
            {credits.map((credit) => (
              <div key={credit.label} className="flex flex-wrap items-baseline gap-x-3">
                <dt className="font-mono text-[11px] uppercase tracking-[0.05em] text-text-faint">{credit.label}</dt>
                <dd className="font-mono text-sm text-text-muted">{credit.value}</dd>
              </div>
            ))}
          </motion.dl>
        </div>

        <motion.div
          className="mt-10 flex flex-wrap items-center gap-x-6 gap-y-2 border-t border-line pt-4 font-mono text-[11px] uppercase tracking-[0.05em] text-text-faint"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={enter(1, 0.85)}
        >
          <span className="flex items-center gap-2 text-text-muted">
            <Motif size={8} />
            {t("meta.network", { chainId })}
          </span>
          <span>{passports === null ? t("meta.countUnread") : t("meta.count", { count: passports })}</span>
          <span>{t("meta.chainlink")}</span>
          {stillDate === null ? null : <span className="ml-auto">{t("meta.registered", { date: stillDate })}</span>}
        </motion.div>
      </div>
    </section>
  );
}
