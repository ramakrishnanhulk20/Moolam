"use client";

import { motion, useScroll, useTransform } from "framer-motion";
import { useTranslations } from "next-intl";
import { useRef } from "react";
import { useIsReducedMotion } from "@/components/motion/useIsReducedMotion";
import { HERO_META } from "./content";
import type { BusinessData, DemoPicture as DemoPictureData } from "./data";
import { DemoLoop } from "./DemoLoop";
import { EASE, Kicker, Lead, Quiet } from "./Kit";
import { Build, Call, Live, Person, Pricing, Security, Ways, Why } from "./Sections";

/** The demo's typing, its passkey ring and Chainlink's sweep: the three moves Tailwind cannot say. */
const BUSINESS_STYLE = `
@keyframes biz-type { from { clip-path: inset(0 100% 0 0); } to { clip-path: inset(0 0 0 0); } }
.biz-type { animation: biz-type 1.6s steps(34, end) 0.2s both; }
@keyframes biz-ring { from { transform: scale(0.55); opacity: 0.9; } to { transform: scale(1.5); opacity: 0; } }
.biz-ring { animation: biz-ring 1.4s cubic-bezier(0.16, 1, 0.3, 1) infinite; }
@keyframes biz-sweep { from { transform: translateX(-120%); } to { transform: translateX(320%); } }
.biz-sweep { animation: biz-sweep 1.6s ease-in-out 0.1s both; }
@media (prefers-reduced-motion: reduce) {
  .biz-type, .biz-ring, .biz-sweep { animation: none; }
}
`;

/**
 * The page for platforms, drawn as Ram picked it from the lab (drawing A):
 * Moolam's own look laid out the way the best platform pages are. The product
 * working sits beside the promise in the first screen, every section after it
 * is numbered like a reel, and every claim carries its proof link.
 */
export function BusinessPage({ data }: { data: BusinessData }) {
  return (
    <div data-business-page>
      <style href="moolam-business" precedence="default">
        {BUSINESS_STYLE}
      </style>
      <Hero picture={data.picture} />
      <Why number="01" />
      <Ways number="02" />
      <Person number="03" />
      <Build number="04" snippets={data.snippets} />
      <Live number="05" live={data.live} picture={data.picture} />
      <Pricing number="06" />
      <Security number="07" tally={data.tally} />
      <Call />
    </div>
  );
}

function Hero({ picture }: { picture: DemoPictureData | null }) {
  const t = useTranslations("business.hero");
  const reduced = useIsReducedMotion();
  const ref = useRef<HTMLElement>(null);
  const { scrollYProgress } = useScroll({ target: ref, offset: ["start start", "end start"] });
  const drift = useTransform(scrollYProgress, [0, 1], reduced ? ["0%", "0%"] : ["0%", "28%"]);
  const lift = useTransform(scrollYProgress, [0, 1], reduced ? ["0px", "0px"] : ["0px", "-60px"]);
  // The server cannot know the reader's motion setting, so it draws the
  // entrance's first frame. The resting frame is always the target: with no
  // target, a reader who asked for less motion was left on that first frame,
  // with the headline invisible.
  const rise = (delay: number) => ({
    initial: { opacity: 0, y: 24 },
    animate: { opacity: 1, y: 0 },
    transition: reduced ? { duration: 0 } : { duration: 0.9, ease: EASE, delay },
  });

  return (
    <section ref={ref} data-section="hero" className="grain relative overflow-hidden border-b border-line">
      <motion.div aria-hidden style={{ y: drift }} className="pointer-events-none absolute inset-0">
        <div className="absolute inset-0 opacity-[0.3] [background-image:linear-gradient(var(--line)_1px,transparent_1px),linear-gradient(90deg,var(--line)_1px,transparent_1px)] [background-size:56px_56px] [mask-image:radial-gradient(ellipse_at_70%_40%,black,transparent_70%)]" />
        <div className="absolute -right-[10%] -top-[20%] h-[70vw] max-h-[60rem] w-[70vw] max-w-[60rem] rounded-full bg-accent/[0.09] blur-[120px]" />
      </motion.div>

      <div className="relative mx-auto grid min-h-[calc(100svh-var(--header-h))] w-full max-w-[90rem] items-center gap-12 px-5 pb-16 pt-12 sm:px-8 lg:grid-cols-[minmax(0,1.08fr)_minmax(0,0.92fr)] lg:gap-14 lg:px-14 lg:py-16">
        <div className="min-w-0">
          <motion.div {...rise(0)}>
            <Kicker>{t("kicker")}</Kicker>
          </motion.div>
          <h1 className="mt-6 font-display text-[clamp(3rem,7.6vw,8rem)] font-semibold uppercase leading-[0.9] tracking-[-0.05em]">
            <motion.span {...rise(0.08)} className="block">
              {t("headline")}
            </motion.span>
            <motion.span {...rise(0.18)} className="block text-accent">
              {t("tail")}
            </motion.span>
          </h1>
          <motion.p {...rise(0.3)} className="mt-7 max-w-[46ch] text-base leading-relaxed text-text-muted sm:text-[1.15rem]">
            {t("promise")}
          </motion.p>
          <motion.div {...rise(0.4)} className="mt-9 flex flex-wrap gap-3">
            <Lead to="guide">{t("guide")}</Lead>
            <Quiet to="dreamloom">{t("live")}</Quiet>
          </motion.div>
          <motion.ul
            {...rise(0.5)}
            className="mt-10 flex flex-col gap-y-2 font-mono text-[11px] uppercase tracking-[0.2em] text-text-faint sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-3"
          >
            {HERO_META.map((item, at) => (
              <li key={item} className="flex items-center gap-3">
                {/* Stacked on a phone, where a wrapped row put a divider at the start of a line. */}
                {at > 0 ? <span aria-hidden className="hidden h-2.5 w-px bg-line-strong sm:block" /> : null}
                {t(`meta.${item}`)}
              </li>
            ))}
          </motion.ul>
        </div>

        <motion.div style={{ y: lift }} className="relative min-w-0 lg:-me-6">
          <motion.div
            initial={reduced ? false : { opacity: 0, y: 40, rotate: 1.5 }}
            animate={{ opacity: 1, y: 0, rotate: 0 }}
            transition={reduced ? { duration: 0 } : { duration: 1.1, ease: EASE, delay: 0.35 }}
          >
            <DemoLoop picture={picture} />
          </motion.div>
        </motion.div>
      </div>
    </section>
  );
}
