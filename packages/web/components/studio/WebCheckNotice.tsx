"use client";

import { AnimatePresence, motion } from "framer-motion";
import { useTranslations } from "next-intl";
import { useIsReducedMotion } from "@/components/motion/useIsReducedMotion";
import type { Mode } from "@/lib/studio/flow";
import { webCheckApplies } from "@/lib/studio/warning";

/**
 * The line that tells a creator, before anything is uploaded, that a public
 * photo goes to Google for the web check (L22). It shows only where the verify
 * service's one rule would send the picture, so turning sealed on takes it away
 * in the same frame the switch moves.
 */
export function WebCheckNotice({ mode, sealed, className = "" }: { mode: Mode; sealed: boolean; className?: string }) {
  const t = useTranslations("studio.webCheck");
  const reduced = useIsReducedMotion();
  const shown = webCheckApplies({ mode, sealed });

  return (
    <AnimatePresence initial={false}>
      {shown ? (
        <motion.p
          key="web-check"
          data-web-check-notice
          initial={reduced ? { opacity: 0 } : { opacity: 0, height: 0 }}
          animate={reduced ? { opacity: 1 } : { opacity: 1, height: "auto" }}
          exit={reduced ? { opacity: 0 } : { opacity: 0, height: 0 }}
          transition={reduced ? { duration: 0.15 } : { duration: 0.45, ease: [0.16, 1, 0.3, 1] }}
          className={`flex max-w-[60ch] items-start gap-3 overflow-hidden text-base leading-relaxed text-text-muted ${className}`}
        >
          <span aria-hidden className="mt-[0.55em] h-[9px] w-[9px] shrink-0 rounded-full border border-current" />
          <span>{t("notice")}</span>
        </motion.p>
      ) : null}
    </AnimatePresence>
  );
}
