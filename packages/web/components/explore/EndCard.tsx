"use client";

import { motion } from "framer-motion";
import { useTranslations } from "next-intl";
import { useIsReducedMotion } from "@/components/motion/useIsReducedMotion";
import { Link } from "@/lib/i18n/routing";
import { endClasses, endSpans, hasEnd } from "./end";

/**
 * The cells a short last row leaves empty, taken by one quiet card that asks
 * the reader to register a picture of their own.
 *
 * It spans exactly the empty cells at each column count and is not drawn where
 * the row is full, so the sheet always closes as a clean rectangle. It shows
 * under every filter, the test images included: the invitation is true
 * anywhere, and a filter that happens to leave a short row would otherwise be
 * the one place a grey box came back.
 */
export function EndCard({ count }: { count: number }) {
  const t = useTranslations("explore.invite");
  const reduced = useIsReducedMotion();
  const spans = endSpans(count);

  if (!hasEnd(spans)) {
    return null;
  }

  return (
    <motion.li
      data-end-card
      initial={reduced ? false : { opacity: 0, y: 26 }}
      whileInView={reduced ? undefined : { opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-40px" }}
      transition={{ duration: 0.55, ease: [0.16, 1, 0.3, 1], delay: 0.12 }}
      className={`${endClasses(spans)} @container relative min-w-0 flex-col justify-between gap-4 overflow-hidden bg-bg-raised p-3 sm:p-5 xl:p-6`}
    >
      <span className="grain pointer-events-none absolute inset-0" />
      <span aria-hidden className="motif relative h-[7px] w-[7px] opacity-60" />
      <div className="relative flex max-w-[34rem] flex-col gap-3 @[28rem]:gap-4">
        <p className="font-display text-[0.9rem] font-semibold leading-tight tracking-[-0.02em] text-text @[17rem]:text-[1.35rem] @[28rem]:text-[clamp(1.6rem,2.4vw,2.3rem)] @[28rem]:leading-[1.05]">
          {t("line")}
        </p>
        {/* A single phone cell is too narrow for the sentence as well; the line
            and the button carry the invitation there. */}
        <p className="hidden text-sm leading-relaxed text-text-muted @[17rem]:block @[28rem]:text-base">{t("body")}</p>
        <Link
          href="/studio"
          prefetch={false}
          data-end-make
          className="group mt-1 inline-flex h-11 w-fit items-center gap-3 rounded-[8px] bg-text px-4 text-xs font-semibold uppercase tracking-[0.14em] text-bg transition duration-200 hover:-translate-y-0.5 hover:opacity-90 active:translate-y-0 @[17rem]:px-6"
        >
          {t("make")}
          <span aria-hidden className="block h-px w-5 bg-current transition-all duration-300 group-hover:w-8" />
        </Link>
      </div>
    </motion.li>
  );
}
