"use client";

import { motion } from "framer-motion";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState, type RefObject } from "react";
import { useIsReducedMotion } from "@/components/motion/useIsReducedMotion";
import { Link } from "@/lib/i18n/routing";
import { GuideGround, type GuideClose, type GuideStage } from "./GuideGround";
import { GuideMarkDrawing } from "./marks";
import { guideSteps, nextStep } from "./steps";

/** A hole in the dim, in the stage's own coordinates. */
export interface Spot {
  x: number;
  y: number;
  width: number;
  height: number;
}

const PAD = 8;
const CARD = 320;

/**
 * Whether an element is really on the screen: rendered, not display none, and
 * not inside something switched off.
 *
 * getClientRects is empty for anything display none, which is exactly how the
 * header's links disappear on a phone and how the bottom bar's tabs disappear
 * on a laptop. offsetParent would have been the shorter test and the wrong one:
 * it reads null for a fixed element, which the bar is.
 */
function onScreen(node: HTMLElement): boolean {
  if (node.closest("[inert]") !== null) {
    return false;
  }
  const box = node.getBoundingClientRect();
  return node.getClientRects().length > 0 && box.width > 0 && box.height > 0;
}

/**
 * Finds the thing a step talks about and measures it against the stage.
 *
 * Both the header and the bottom bar carry the same anchor, and only one of
 * them is ever on the screen, so the first visible one is the right one without
 * this having to know anything about widths. Nothing visible is a normal
 * answer, not a fault: "My pictures" only appears for a device that has signed
 * in before, which a first-time visitor is not.
 */
export function spotFor(anchor: string, root: ParentNode, origin: DOMRect): Spot | null {
  const node = [...root.querySelectorAll<HTMLElement>(`[data-guide-anchor="${anchor}"]`)].find(onScreen);
  if (node === undefined) {
    return null;
  }

  const box = node.getBoundingClientRect();
  return {
    x: box.left - origin.left - PAD,
    y: box.top - origin.top - PAD,
    width: box.width + PAD * 2,
    height: box.height + PAD * 2,
  };
}

/**
 * The walk: one step at a time, with the light on the real thing.
 *
 * The dim is painted by the spotlight itself, as a very large shadow around the
 * hole, so whatever is being talked about stays sharp while everything else
 * goes dark. The light slides from one to the next rather than cutting, which
 * is the whole reason to do it this way instead of three cards.
 */
export function GuideWalk({
  open,
  onClose,
  stage = "window",
  scope,
}: {
  open: boolean;
  onClose: (reason: GuideClose) => void;
  stage?: GuideStage;
  /** Where to look for the anchors. A bench passes its own mock window. */
  scope?: RefObject<HTMLElement | null>;
}) {
  const t = useTranslations("guide");
  const reduced = useIsReducedMotion();
  const [index, setIndex] = useState(0);
  const [spot, setSpot] = useState<Spot | null>(null);
  const [room, setRoom] = useState({ width: 0, height: 0 });
  const wrap = useRef<HTMLDivElement>(null);

  const step = guideSteps[index];

  // The walk always starts at the beginning, however it was last left. Adjusted
  // while rendering rather than in an effect, so the first frame after an open
  // is already step one instead of a flash of whatever it was closed on.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open && index !== 0) {
      setIndex(0);
    }
  }

  // Measuring is the one thing that cannot be done while rendering: the step
  // has to be on the screen before its box can be read. It runs again on every
  // resize, because the header's links and the bar's tabs trade places there.
  useEffect(() => {
    if (!open) {
      return;
    }
    const measure = () => {
      const frame = wrap.current;
      if (frame === null) {
        return;
      }
      const origin = frame.getBoundingClientRect();
      setRoom({ width: origin.width, height: origin.height });
      setSpot(spotFor(step.anchor, scope?.current ?? document.body, origin));
    };

    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [open, scope, step.anchor]);

  const forward = () => {
    const after = nextStep(index);
    if (after === null) {
      onClose("done");
    } else {
      setIndex(after);
    }
  };

  // Under the light when there is room, over it when there is not, and never
  // off the side of the screen. With nothing lit the card goes to the bottom
  // middle, where a sheet on a phone would be.
  const below = spot !== null && spot.y + spot.height + 190 < room.height;
  const place =
    spot === null
      ? {
          bottom: "calc(24px + env(safe-area-inset-bottom))",
          left: Math.max(16, room.width / 2 - CARD / 2),
        }
      : {
          top: below ? spot.y + spot.height + 26 : Math.max(16, spot.y - 210),
          left: Math.min(Math.max(16, spot.x - 12), Math.max(16, room.width - CARD - 16)),
        };

  const counter = t("step", {
    shown: String(index + 1).padStart(2, "0"),
    total: String(guideSteps.length).padStart(2, "0"),
  });

  return (
    <GuideGround
      open={open}
      onClose={onClose}
      stage={stage}
      // The dim normally comes from the spotlight, which is nothing but a hole
      // in a very large shadow. With nothing to point at there is no hole and
      // no shadow either, so the ground takes the dim back and the step reads
      // as what it is: a thing that is not on this screen.
      ground={spot === null ? "blur" : "clear"}
      closeOnGround={false}
      label={t("dialog")}
    >
      <div ref={wrap} className="absolute inset-0">
        {/* The dim is this element's own shadow, so the hole in it is the real
            control, sharp and in its own place on the page. */}
        <motion.div
          aria-hidden
          initial={{ opacity: 0 }}
          animate={
            spot === null
              ? { opacity: 0, x: 0, y: 0, width: 0, height: 0 }
              : { opacity: 1, x: spot.x, y: spot.y, width: spot.width, height: spot.height }
          }
          exit={{ opacity: 0 }}
          transition={
            reduced
              ? { duration: 0.2 }
              : { type: "spring", stiffness: 260, damping: 32, opacity: { duration: 0.35 } }
          }
          className="absolute left-0 top-0 rounded-[10px] shadow-[0_0_0_9999px_rgb(0_0_0/0.82)] ring-1 ring-accent"
        />

        {/* The hairline from the light down to the words, so the two read as one thing. */}
        {spot !== null && below ? (
          <motion.span
            aria-hidden
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="absolute w-px bg-accent/50"
            style={{ left: spot.x + 16, top: spot.y + spot.height, height: 26 }}
          />
        ) : null}

        <motion.div
          key={step.id}
          initial={reduced ? { opacity: 0 } : { opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: reduced ? 0.2 : 0.5, ease: [0.16, 1, 0.3, 1] }}
          style={{ ...place, width: Math.min(CARD, Math.max(240, room.width - 32)) }}
          className="pointer-events-auto absolute rounded-[8px] border border-line bg-[color:var(--bg-raised)] p-5 shadow-[0_24px_60px_rgb(0_0_0/0.5)]"
        >
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-accent">{counter}</p>
              <h3 className="mt-2 max-w-[16ch] font-display text-[1.15rem] font-semibold leading-[1.1] tracking-[-0.03em]">
                {t(`steps.${step.id}.title`)}
              </h3>
            </div>
            <GuideMarkDrawing mark={step.mark} reduced={reduced} />
          </div>

          <p className="mt-3 text-[13px] leading-relaxed text-text-muted">{t(`steps.${step.id}.line`)}</p>

          {spot === null ? (
            <p className="mt-3 border-t border-line pt-3 text-[12px] leading-relaxed text-text-faint">
              {t(`steps.${step.id}.elsewhere`)}
            </p>
          ) : null}

          {/* Somebody sold on this step should not have to remember it and find
              it afterwards, so the step carries its own way there. The mark is
              written on the way out, like every other close. */}
          <Link
            href={step.href}
            prefetch={false}
            onClick={() => onClose("go")}
            className="group mt-4 inline-flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.14em] text-accent transition-colors duration-200 hover:text-text focus-visible:text-text"
          >
            {t(`steps.${step.id}.action`)}
            <span aria-hidden className="transition-transform duration-200 group-hover:translate-x-1">
              &rarr;
            </span>
          </Link>

          <div className="mt-5 flex items-center justify-between gap-4">
            <span aria-hidden className="flex items-center gap-1.5">
              {guideSteps.map((dot, at) => (
                <span
                  key={dot.id}
                  className={`h-[6px] w-[6px] transition-colors duration-300 ${
                    at === index ? "bg-accent" : "bg-line-strong"
                  }`}
                />
              ))}
            </span>

            <span className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => onClose("skip")}
                className="tap rounded-[8px] px-3 py-2 font-mono text-[10px] uppercase tracking-[0.16em] text-text-faint transition-colors duration-200 hover:text-accent focus-visible:text-accent"
              >
                {t("skip")}
              </button>
              <button
                type="button"
                onClick={forward}
                className="tap group inline-flex items-center gap-2 rounded-[8px] bg-accent px-4 py-2 font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-accent-ink transition-transform duration-200 hover:scale-[1.04] focus-visible:scale-[1.04]"
              >
                {nextStep(index) === null ? t("done") : t("next")}
                <span aria-hidden className="transition-transform duration-200 group-hover:translate-x-1">
                  &rarr;
                </span>
              </button>
            </span>
          </div>
        </motion.div>
      </div>
    </GuideGround>
  );
}
