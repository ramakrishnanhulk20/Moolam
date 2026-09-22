"use client";

import { motion } from "framer-motion";
import { useEffect, useRef, useState, type RefObject } from "react";
import { useIsReducedMotion } from "@/components/motion/useIsReducedMotion";
import { GuideGround, type GuideClose, type GuideStage } from "./GuideGround";
import { GuideMarkDrawing } from "./marks";
import { guideSteps, nextStep } from "./steps";

/** A hole in the dim, in the stage's own coordinates. */
export interface Spot {
  x: number;
  y: number;
  width: number;
  height: number;
  /** True when the light is sitting on a stand-in rather than the real thing. */
  standIn: boolean;
}

const PAD = 8;
const CARD = 320;

/**
 * Finds the thing a step talks about and measures it against the stage.
 *
 * A first-time visitor has no "My pictures" in the header, because that entry
 * only appears for a device that has signed in. So a missing anchor is a normal
 * state, not a fault: the light falls back to the menu and the card says where
 * the real thing will be.
 */
export function spotFor(anchor: string, root: ParentNode, origin: DOMRect): Spot | null {
  const real = root.querySelector<HTMLElement>(`[data-guide-anchor="${anchor}"]`);
  const node = real ?? root.querySelector<HTMLElement>('[data-guide-anchor="menu"]');
  if (node === null) {
    return null;
  }

  const box = node.getBoundingClientRect();
  return {
    x: box.left - origin.left - PAD,
    y: box.top - origin.top - PAD,
    width: box.width + PAD * 2,
    height: box.height + PAD * 2,
    standIn: real === null,
  };
}

/**
 * Drawing B: one step at a time, with the light on the real thing.
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
  /** Where to look for the anchors. The bench passes its own mock window. */
  scope?: RefObject<HTMLElement | null>;
}) {
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
  // resize, because the header rearranges itself on the way down to a phone.
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

  const go = (reason: GuideClose) => onClose(reason);
  const forward = () => {
    const after = nextStep(index);
    if (after === null) {
      go("done");
    } else {
      setIndex(after);
    }
  };

  // Under the light when there is room, over it when there is not, and never
  // off the side of the screen.
  const below = spot !== null && spot.y + spot.height + 190 < room.height;
  const cardTop =
    spot === null ? room.height / 2 - 130 : below ? spot.y + spot.height + 26 : Math.max(16, spot.y - 210);
  const cardLeft =
    spot === null
      ? Math.max(16, room.width / 2 - CARD / 2)
      : Math.min(Math.max(16, spot.x - 12), Math.max(16, room.width - CARD - 16));

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
      label="Where to look on Moolam"
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
          style={{ top: cardTop, left: cardLeft, width: Math.min(CARD, Math.max(240, room.width - 32)) }}
          className="pointer-events-auto absolute rounded-[8px] border border-line bg-[color:var(--bg-raised)] p-5 shadow-[0_24px_60px_rgb(0_0_0/0.5)]"
        >
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-accent">
                {step.number} of {String(guideSteps.length).padStart(2, "0")}
              </p>
              <h3 className="mt-2 max-w-[16ch] font-display text-[1.15rem] font-semibold leading-[1.1] tracking-[-0.03em]">
                {step.title}
              </h3>
            </div>
            <GuideMarkDrawing mark={step.mark} reduced={reduced} />
          </div>

          <p className="mt-3 text-[13px] leading-relaxed text-text-muted">{step.line}</p>

          {spot === null || spot.standIn ? (
            <p className="mt-3 border-t border-line pt-3 text-[12px] leading-relaxed text-text-faint">
              {spot === null
                ? "This one is not on the screen yet. In the app it sits in the header, beside the others."
                : "At this width the header items are behind the menu, so the light is on the menu. In the phone shell it sits on the bottom bar tab."}
            </p>
          ) : null}

          <div className="mt-5 flex items-center justify-between gap-4">
            <span className="flex items-center gap-1.5" aria-label={`Step ${index + 1} of ${guideSteps.length}`}>
              {guideSteps.map((dot, at) => (
                <span
                  key={dot.id}
                  aria-hidden
                  className={`h-[6px] w-[6px] transition-colors duration-300 ${
                    at === index ? "bg-accent" : "bg-line-strong"
                  }`}
                />
              ))}
            </span>

            <span className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => go("skip")}
                className="tap rounded-[8px] px-3 py-2 font-mono text-[10px] uppercase tracking-[0.16em] text-text-faint transition-colors duration-200 hover:text-accent focus-visible:text-accent"
              >
                Skip
              </button>
              <button
                type="button"
                onClick={forward}
                className="tap group inline-flex items-center gap-2 rounded-[8px] bg-accent px-4 py-2 font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-accent-ink transition-transform duration-200 hover:scale-[1.04] focus-visible:scale-[1.04]"
              >
                {nextStep(index) === null ? "Done" : "Next"}
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
