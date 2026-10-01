"use client";

import { motion } from "framer-motion";
import { useTranslations } from "next-intl";
import { useIsReducedMotion } from "@/components/motion/useIsReducedMotion";

/**
 * The sentence a creator signs under, drawn beside the button that signs it
 * (L21). The verify service writes the same words into every studio, generate,
 * edit and co-sign document, so this is the statement in the passport, word for
 * word, read before the press rather than found on the page afterwards.
 */
export function SwornLine({ className = "" }: { className?: string }) {
  const t = useTranslations("sworn");
  const reduced = useIsReducedMotion();
  return (
    <motion.figure
      data-sworn
      initial={reduced ? false : { opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={reduced ? { duration: 0 } : { duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
      className={`relative border-s-2 border-accent ps-4 ${className}`}
    >
      <figcaption className="font-mono text-[10px] uppercase tracking-[0.22em] text-text-faint">{t("label")}</figcaption>
      <blockquote className="mt-1.5 max-w-[46ch] font-display text-[1.05rem] font-semibold leading-snug tracking-[-0.01em] text-text">
        {t("line")}
      </blockquote>
      <p className="mt-1.5 max-w-[52ch] text-base leading-relaxed text-text-muted">{t("note")}</p>
    </motion.figure>
  );
}
