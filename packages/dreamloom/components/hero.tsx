"use client";

import { motion, useReducedMotion, useScroll, useTransform } from "framer-motion";
import { HeroCollage } from "./gallery/hero-collage";
import { PromptBox } from "./weave/prompt-box";
import { Wordmark } from "./wordmark";

const rise = {
  hidden: { opacity: 0, y: 28 },
  shown: { opacity: 1, y: 0 },
};

export function Hero() {
  const still = useReducedMotion() ?? false;
  const { scrollY } = useScroll();
  const cloudsNear = useTransform(scrollY, [0, 900], [0, still ? 0 : 220]);
  const cloudsFar = useTransform(scrollY, [0, 900], [0, still ? 0 : 90]);

  return (
    <header className="relative isolate overflow-hidden">
      <div aria-hidden className="pointer-events-none absolute inset-0 -z-10">
        <motion.div style={{ y: cloudsFar }} className="absolute inset-0">
          <div className="dream-cloud absolute -top-40 -left-32 size-[36rem] rounded-full bg-violet/25 blur-3xl" />
          <div className="dream-cloud absolute top-10 right-[-12rem] size-[32rem] rounded-full bg-tangerine/20 blur-3xl" />
        </motion.div>
        <motion.div style={{ y: cloudsNear }} className="absolute inset-0">
          <div className="dream-cloud absolute bottom-[-14rem] left-1/3 size-[30rem] rounded-full bg-sun/35 blur-3xl" />
        </motion.div>
      </div>

      <motion.nav
        initial={{ opacity: 0, y: -12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
        className="mx-auto flex max-w-[88rem] items-center justify-between px-5 pt-5 sm:px-10 sm:pt-7"
      >
        <a href="/" className="rounded-full transition-opacity hover:opacity-75">
          <Wordmark />
        </a>
        <a
          href="#gallery"
          className="inline-flex min-h-11 items-center rounded-full border-2 border-ink/10 bg-card/70 px-4 py-2 text-sm font-semibold text-ink backdrop-blur transition hover:-translate-y-0.5 hover:border-violet hover:text-violet"
        >
          See the gallery
        </a>
      </motion.nav>

      <motion.div
        initial="hidden"
        animate="shown"
        transition={{ staggerChildren: 0.12, delayChildren: 0.1 }}
        className="mx-auto max-w-[88rem] px-5 pt-6 pb-14 sm:px-10 sm:pt-12 sm:pb-24"
      >
        <h1
          className="font-display text-[clamp(2.5rem,8.4vw,7.5rem)] leading-[0.9] font-extrabold tracking-[-0.05em] text-ink"
          style={{ fontVariationSettings: '"opsz" 96, "wdth" 86' }}
        >
          <motion.span variants={rise} transition={{ duration: 0.8, ease: [0.22, 1, 0.36, 1] }} className="block">
            Describe a <span className="text-daybreak pr-[0.04em]">dream.</span>
          </motion.span>
          <motion.span
            variants={rise}
            transition={{ duration: 0.8, ease: [0.22, 1, 0.36, 1] }}
            className="block lg:pl-[0.9em]"
          >
            We weave the picture.
          </motion.span>
        </h1>

        <div className="mt-6 grid gap-10 sm:mt-10 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)] lg:gap-14">
          <div className="max-w-[44rem]">
            <motion.div
              variants={{ hidden: { opacity: 0, y: 36, scale: 0.97 }, shown: { opacity: 1, y: 0, scale: 1 } }}
              transition={{ type: "spring", stiffness: 140, damping: 18 }}
            >
              <PromptBox />
            </motion.div>

            <motion.p
              variants={rise}
              transition={{ duration: 0.7, ease: [0.22, 1, 0.36, 1] }}
              className="mt-6 flex max-w-[36rem] items-start gap-2.5 text-base text-ink-soft"
            >
              <img
                src="/moolam-mark.svg"
                alt=""
                width={22}
                height={22}
                className="mt-0.5 size-[22px] shrink-0 rounded-full bg-[#14121c] p-[3px]"
              />
              Every picture can get a Moolam passport that credits you, the person who imagined it, and says how AI may use it.
            </motion.p>
          </div>

          <HeroCollage />
        </div>
      </motion.div>
    </header>
  );
}
