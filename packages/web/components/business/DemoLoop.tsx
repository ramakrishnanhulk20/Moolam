"use client";

import { AnimatePresence, motion } from "framer-motion";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { useIsReducedMotion } from "@/components/motion/useIsReducedMotion";
import { DEMO_STAGES } from "./content";
import { EASE } from "./Kit";
import type { DemoPicture as DemoPictureData } from "./data";
import { DemoPicture } from "./DemoPicture";
import { Seal } from "./Seal";

const LAST = DEMO_STAGES.length - 1;

/**
 * The partner site is drawn in its own bright palette whatever Moolam's theme
 * is, so the small Moolam window that opens over it reads as a second company
 * stepping in, which is what it is. Its accent is a cold blue so it never sits
 * beside Moolam's pink as a second warm colour.
 */
const PARTNER = {
  ground: "#f7f4ee",
  ink: "#1b1a17",
  muted: "#5f5b52",
  line: "#e0dacd",
  accent: "#2f4fd0",
} as const;

/**
 * The hero's coded demo: a partner site makes a picture, the person presses
 * Sign it as the creator, the Moolam window opens, one passkey tap, the
 * passport lands, then Chainlink's check lights on the same card.
 *
 * It loops on its own. The seven bars under it show where it is and jump to
 * any beat, which also stops the loop there. A reader who asked for less motion
 * gets the finished card standing still, and can still step through by hand.
 */
export function DemoLoop({ picture, className = "" }: { picture: DemoPictureData | null; className?: string }) {
  const t = useTranslations("business.demo");
  const reduced = useIsReducedMotion();
  const [stage, setStage] = useState(0);
  const [cycle, setCycle] = useState(0);
  // Null until the reader touches a control: the loop then plays unless they asked for less motion.
  const [playing, setPlaying] = useState<boolean | null>(null);
  const running = playing ?? !reduced;
  const shown = playing === null && reduced ? LAST : stage;

  useEffect(() => {
    if (!running) {
      return;
    }
    const timer = window.setTimeout(() => {
      if (stage === LAST) {
        setCycle((count) => count + 1);
        setStage(0);
      } else {
        setStage(stage + 1);
      }
    }, DEMO_STAGES[stage].hold);
    return () => window.clearTimeout(timer);
  }, [running, stage]);

  const jump = (to: number) => {
    setPlaying(false);
    setStage(to);
  };

  const instant = reduced ? { duration: 0 } : undefined;

  return (
    <figure
      data-demo-loop
      data-stage={DEMO_STAGES[shown].key}
      aria-label={t("label")}
      className={`relative ${className}`}
    >
      <div className="mb-3 flex items-center justify-between gap-4">
        <span className="font-mono text-[11px] uppercase tracking-[0.22em] text-text-faint">{t("illustration")}</span>
        <span className="font-mono text-[11px] uppercase tracking-[0.16em] text-text-muted">
          <span className="text-accent">{String(shown + 1).padStart(2, "0")}</span> / {String(DEMO_STAGES.length).padStart(2, "0")}
        </span>
      </div>

      <div
        aria-hidden
        className="relative overflow-hidden rounded-[12px] border border-line-strong shadow-[0_40px_120px_rgb(0_0_0/0.45)] [.light_&]:shadow-[0_36px_90px_rgb(90_60_50/0.2)]"
        style={{ background: PARTNER.ground, color: PARTNER.ink }}
      >
        <div className="flex items-center gap-3 border-b px-4 py-2.5" style={{ borderColor: PARTNER.line }}>
          <span className="flex gap-1.5">
            {[0, 1, 2].map((dot) => (
              <span key={dot} className="h-2.5 w-2.5 rounded-full" style={{ background: PARTNER.line }} />
            ))}
          </span>
          <span
            className="flex-1 truncate rounded-full px-3 py-1 text-center font-mono text-[11px]"
            style={{ background: "#ece7dd", color: PARTNER.muted }}
          >
            {t("address")}
          </span>
        </div>

        <div className="relative p-4 sm:p-5">
          <div className="flex items-center gap-2 rounded-[8px] border px-3 py-2.5" style={{ borderColor: PARTNER.line, background: "#fff" }}>
            <span className="min-w-0 flex-1 truncate text-[13px] sm:text-sm">
              <span key={`type-${cycle}`} className={`${shown === 0 ? "biz-type" : ""} inline-block`}>
                {t("prompt")}
              </span>
            </span>
            <span className="rounded-[6px] px-3 py-1 text-[12px] font-semibold text-white" style={{ background: PARTNER.accent }}>
              {t("draw")}
            </span>
          </div>

          <div className="relative mt-3 aspect-[4/3] overflow-hidden rounded-[8px]" style={{ background: "#e9e3d7" }}>
            <motion.div
              initial={false}
              animate={shown >= 1 ? { opacity: 1, filter: "blur(0px)", scale: 1 } : { opacity: 0.25, filter: "blur(14px)", scale: 1.06 }}
              transition={instant ?? { duration: 1.1, ease: EASE }}
              className="absolute inset-0"
            >
              <DemoPicture picture={picture} sizes="(min-width: 1024px) 40vw, 92vw" priority className="h-full w-full" />
            </motion.div>

            <AnimatePresence>
              {shown >= 5 ? (
                <motion.div
                  key="passport"
                  initial={{ opacity: 0, y: 40 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: 20 }}
                  transition={instant ?? { duration: 0.7, ease: EASE }}
                  className="absolute inset-x-3 bottom-3 flex items-center gap-3 rounded-[10px] border border-line-strong bg-bg/95 p-3 text-text backdrop-blur sm:inset-x-4 sm:bottom-4 sm:gap-4 sm:p-4"
                >
                  <motion.span
                    initial={reduced ? false : { scale: 1.8, rotate: -30, opacity: 0 }}
                    animate={{ scale: 1, rotate: -9, opacity: 1 }}
                    transition={instant ?? { type: "spring", stiffness: 320, damping: 17, delay: 0.25 }}
                    className="shrink-0"
                  >
                    <Seal className="h-12 w-12 sm:h-14 sm:w-14" />
                  </motion.span>
                  <span className="min-w-0">
                    <span className="block font-mono text-[11px] uppercase tracking-[0.2em] text-text-faint">{t("passport")}</span>
                    <span className="mt-1 block text-[14px] font-medium leading-snug sm:text-base">{t("credit")}</span>
                    <span
                      className={`relative mt-1.5 flex items-center gap-2 overflow-hidden font-mono text-[11px] uppercase tracking-[0.16em] transition-colors duration-500 ${
                        shown >= 6 ? "text-verified" : "text-text-faint"
                      }`}
                    >
                      <span className={`motif h-2.5 w-2.5 ${shown >= 6 ? "bg-verified" : "bg-line-strong"}`} />
                      {t("checked")}
                      {shown >= 6 && !reduced ? (
                        <span className="biz-sweep pointer-events-none absolute inset-y-0 left-0 w-12 bg-gradient-to-r from-transparent via-verified/40 to-transparent" />
                      ) : null}
                    </span>
                  </span>
                </motion.div>
              ) : null}
            </AnimatePresence>
          </div>

          <div className="mt-3 flex items-center justify-between gap-3">
            <span className="truncate text-[12px]" style={{ color: PARTNER.muted }}>
              {shown >= 1 ? t("prompt") : t("drawing")}
            </span>
            <motion.span
              animate={shown === 2 ? { scale: [1, 0.94, 1] } : { scale: 1 }}
              transition={instant ?? { duration: 0.5, delay: 0.5 }}
              className="relative shrink-0 rounded-[8px] px-3.5 py-2 text-[12px] font-semibold text-white sm:text-[13px]"
              style={{ background: PARTNER.ink, boxShadow: shown === 2 ? `0 0 0 4px ${PARTNER.accent}55` : "none" }}
            >
              {t("press")}
              {shown === 2 && !reduced ? (
                <motion.span
                  initial={{ opacity: 0, x: 40, y: 30 }}
                  animate={{ opacity: 1, x: 6, y: 8 }}
                  transition={{ duration: 0.5, ease: EASE }}
                  className="absolute bottom-0 right-6 h-4 w-4 rounded-full border-2 border-white"
                  style={{ background: PARTNER.accent }}
                />
              ) : null}
            </motion.span>
          </div>

          <AnimatePresence>
            {shown === 3 || shown === 4 ? (
              <motion.div
                key="window"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={instant ?? { duration: 0.35 }}
                className="absolute inset-0 flex items-center justify-center bg-[rgb(10_10_14/0.55)] backdrop-blur-[2px]"
              >
                <motion.div
                  initial={{ y: 30, scale: 0.94, opacity: 0 }}
                  animate={{ y: 0, scale: 1, opacity: 1 }}
                  exit={{ y: 16, opacity: 0 }}
                  transition={instant ?? { duration: 0.55, ease: EASE }}
                  className="w-[78%] max-w-[300px] rounded-[12px] border border-line-strong bg-bg p-4 text-text shadow-[0_30px_80px_rgb(0_0_0/0.5)]"
                >
                  <span className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.22em] text-accent">
                    <span className="motif h-2.5 w-2.5" />
                    {t("brand")}
                  </span>
                  <span className="mt-2 block font-display text-lg font-semibold uppercase leading-none tracking-[-0.02em]">{t("window")}</span>
                  <span className="mt-3 flex items-center gap-3">
                    <DemoPicture picture={picture} sizes="48px" className="h-12 w-12 shrink-0 rounded-[6px]" />
                    <span className="text-[12px] leading-snug text-text-muted">{t("windowLine")}</span>
                  </span>
                  {shown === 3 ? (
                    <span className="mt-4 flex h-10 items-center justify-center rounded-[8px] bg-accent text-[12px] font-semibold uppercase tracking-[0.12em] text-accent-ink">
                      {t("passkey")}
                    </span>
                  ) : (
                    <span className="mt-4 flex h-10 items-center justify-center gap-3 text-[12px] uppercase tracking-[0.14em] text-text-muted">
                      <span className="relative flex h-7 w-7 items-center justify-center">
                        <span className="biz-ring absolute inset-0 rounded-full border-2 border-accent" />
                        <span className="motif h-4 w-4" />
                      </span>
                      {t("passkeyWaiting")}
                    </span>
                  )}
                </motion.div>
              </motion.div>
            ) : null}
          </AnimatePresence>
        </div>
      </div>

      <figcaption className="mt-4 min-h-[3rem] text-base leading-relaxed text-text-muted">{t(`stages.${DEMO_STAGES[shown].key}.line`)}</figcaption>

      <div className="mt-2 flex items-center gap-2">
        <button
          type="button"
          onClick={() => setPlaying(!running)}
          aria-label={running ? t("pause") : t("play")}
          className="inline-flex h-11 shrink-0 items-center rounded-[8px] border border-line-strong px-3.5 font-mono text-[11px] uppercase tracking-[0.16em] text-text transition-colors duration-200 hover:border-accent hover:text-accent"
        >
          {running ? t("pauseShort") : t("playShort")}
        </button>
        <div className="grid flex-1 grid-cols-7 gap-1">
          {DEMO_STAGES.map((beat, at) => (
            <button
              key={beat.key}
              type="button"
              onClick={() => jump(at)}
              aria-label={t("step", { number: at + 1, label: t(`stages.${beat.key}.label`) })}
              aria-pressed={at === shown}
              className="group flex h-11 items-center"
            >
              <span
                className={`block h-1 w-full rounded-full transition-colors duration-300 group-hover:bg-accent/70 ${
                  at < shown ? "bg-text-muted" : at === shown ? "bg-accent" : "bg-line-strong"
                }`}
              />
            </button>
          ))}
        </div>
      </div>
    </figure>
  );
}
