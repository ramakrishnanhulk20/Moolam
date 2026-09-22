"use client";

import { motion } from "framer-motion";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState, type RefObject } from "react";
import { useIsReducedMotion } from "@/components/motion/useIsReducedMotion";
import { Link } from "@/lib/i18n/routing";
import { GuideGround, type GuideClose, type GuideStage } from "./GuideGround";
import { GuideMarkDrawing } from "./marks";
import { guideSteps, nextStep } from "./steps";

/** The box the guide is drawn in: the window, or a bench's mock window. */
export interface Stage {
  left: number;
  top: number;
  width: number;
  height: number;
}

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
 * How long the walk waits for a step's anchor before deciding it is not on this
 * screen.
 *
 * The bottom bar mounts a moment after the page does, so a step asked on the
 * very first frame finds nothing and would draw the card at the bottom of the
 * screen, only to move it onto the tab once that arrived. Half a second of
 * patience costs a first visitor nothing and is the difference between a guide
 * that lands and a guide that jumps.
 */
const PATIENCE = 500;

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
export function spotFor(
  anchor: string,
  root: ParentNode,
  origin: Stage,
): Spot | null {
  const node = [
    ...root.querySelectorAll<HTMLElement>(`[data-guide-anchor="${anchor}"]`),
  ].find(onScreen);
  if (node === undefined) {
    return null;
  }

  const box = node.getBoundingClientRect();
  return {
    x: Math.round(box.left - origin.left - PAD),
    y: Math.round(box.top - origin.top - PAD),
    width: Math.round(box.width + PAD * 2),
    height: Math.round(box.height + PAD * 2),
  };
}

/** One spot as a string, so a rect that has not moved costs nothing. */
function same(spot: Spot | null): string {
  return spot === null
    ? "none"
    : `${spot.x} ${spot.y} ${spot.width} ${spot.height}`;
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
  // null until the walk has looked at least once. Nothing may be drawn before
  // that: see the note on measured below.
  const [room, setRoom] = useState<{ width: number; height: number } | null>(
    null,
  );
  const wrap = useRef<HTMLDivElement>(null);

  const step = guideSteps[index];

  // The walk always starts at the beginning, however it was last left. Adjusted
  // while rendering rather than in an effect, so the first frame after an open
  // is already step one instead of a flash of whatever it was closed on.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setRoom(null);
      if (index !== 0) {
        setIndex(0);
      }
    }
  }

  // Measuring is the one thing that cannot be done while rendering: the step has
  // to be on the screen before its box can be read.
  //
  // It keeps looking, every frame, because the thing being pointed at moves. The
  // bottom bar slides up from its own height when it arrives, so a single
  // measurement on open put the light 56 px below the tab on a phone, under the
  // very tab it was meant to be lighting. A frame whose rect has not changed
  // costs one getBoundingClientRect and no render at all, so the loop is quiet
  // the moment the page settles, and this is also what handles a resize, a
  // rotation and a header that rearranges itself on the way down to a phone.
  useEffect(() => {
    if (!open) {
      return;
    }
    let frame = 0;
    let held: string | null = null;
    const from = performance.now();

    const look = () => {
      // The window itself, or the bench's frame when one was handed in.
      // Measured from a box rather than from the guide's own wrapper, so the
      // looking can start before a single pixel of the guide is drawn.
      const frameNode = stage === "frame" ? (scope?.current ?? null) : null;
      const origin =
        frameNode === null
          ? {
              left: 0,
              top: 0,
              width: window.innerWidth,
              height: window.innerHeight,
            }
          : frameNode.getBoundingClientRect();

      {
        const next = spotFor(
          step.anchor,
          scope?.current ?? document.body,
          origin,
        );
        // Nothing found, and it may still be on its way: the bottom bar mounts
        // a moment after the page does and wakes a moment after that. Say
        // nothing rather than say the wrong thing.
        const waiting = next === null && performance.now() - from < PATIENCE;
        if (!waiting && same(next) !== held) {
          held = same(next);
          setRoom({ width: origin.width, height: origin.height });
          setSpot(next);
        }
      }
      frame = requestAnimationFrame(look);
    };

    look();
    frame = requestAnimationFrame(look);
    return () => cancelAnimationFrame(frame);
  }, [open, scope, stage, step.anchor]);

  const forward = () => {
    const after = nextStep(index);
    if (after === null) {
      onClose("done");
    } else {
      setIndex(after);
    }
  };

  // Nothing is drawn before the walk has looked. The card has two homes, one
  // under the light and one at the bottom of the screen, and painting it in the
  // second while the first was still being measured moved it across the window a
  // frame later: one layout shift of 0.174 on the home page, the whole of that
  // page's score, for a card that had simply been drawn too early.
  const measured = room !== null;
  const width = room?.width ?? 0;
  const height = room?.height ?? 0;

  // Under the light when there is room, over it when there is not, and never
  // off the side of the screen. With nothing lit the card goes to the bottom
  // middle, where a sheet on a phone would be.
  //
  // The placement is carried as a transform rather than as top and left. The
  // card follows the light, and the light follows a bottom bar that slides up
  // from its own height as it arrives, so a card placed with top moved with it
  // and the browser counted every frame of that as the page shifting under the
  // reader: 0.015 on a phone. A transform moves nothing as far as layout is
  // concerned, which is why the spotlight itself never cost anything.
  const below = spot !== null && spot.y + spot.height + 190 < height;
  const cardWidth = Math.min(CARD, Math.max(240, width - 32));
  const anchored =
    spot === null
      ? {
          bottom: "calc(24px + env(safe-area-inset-bottom))",
          left: Math.max(16, width / 2 - cardWidth / 2),
        }
      : { top: 0, left: 0 };
  const carried =
    spot === null
      ? { x: 0, y: 0 }
      : {
          x: Math.min(
            Math.max(16, spot.x - 12),
            Math.max(16, width - cardWidth - 16),
          ),
          y: below ? spot.y + spot.height + 26 : Math.max(16, spot.y - 210),
        };

  const counter = t("step", {
    shown: String(index + 1).padStart(2, "0"),
    total: String(guideSteps.length).padStart(2, "0"),
  });

  return (
    <>
      {/* The bottom bar is asleep while the film plays and wakes when a guide
          is open, which it learns from this mark. The mark has to go up before
          the walk has measured anything, or the two wait for each other: the
          bar stays inert, the walk finds no tab, and a visitor on a phone is
          told the thing is not on this screen while it sits right under the
          card. GuideGround carries the same mark once it is up. */}
      {open && !measured ? <span data-guide-open hidden /> : null}

      <GuideGround
        open={open && measured}
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
                : {
                    opacity: 1,
                    x: spot.x,
                    y: spot.y,
                    width: spot.width,
                    height: spot.height,
                  }
            }
            exit={{ opacity: 0 }}
            transition={
              reduced
                ? { duration: 0.2 }
                : {
                    type: "spring",
                    stiffness: 260,
                    damping: 32,
                    opacity: { duration: 0.35 },
                  }
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
              style={{
                left: spot.x + 16,
                top: spot.y + spot.height,
                height: 26,
              }}
            />
          ) : null}

          <motion.div
            className="pointer-events-auto absolute"
            style={{ ...anchored, width: cardWidth }}
            animate={carried}
            transition={
              reduced
                ? { duration: 0.2 }
                : { type: "spring", stiffness: 260, damping: 32 }
            }
          >
            <motion.div
              key={step.id}
              initial={reduced ? { opacity: 0 } : { opacity: 0, y: 14 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{
                duration: reduced ? 0.2 : 0.5,
                ease: [0.16, 1, 0.3, 1],
              }}
              className="rounded-[8px] border border-line bg-[color:var(--bg-raised)] p-5 shadow-[0_24px_60px_rgb(0_0_0/0.5)]"
            >
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-accent">
                    {counter}
                  </p>
                  <h3 className="mt-2 max-w-[16ch] font-display text-[1.15rem] font-semibold leading-[1.1] tracking-[-0.03em]">
                    {t(`steps.${step.id}.title`)}
                  </h3>
                </div>
                <GuideMarkDrawing mark={step.mark} reduced={reduced} />
              </div>

              <p className="mt-3 text-[13px] leading-relaxed text-text-muted">
                {t(`steps.${step.id}.line`)}
              </p>

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
                <span
                  aria-hidden
                  className="transition-transform duration-200 group-hover:translate-x-1"
                >
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
                    <span
                      aria-hidden
                      className="transition-transform duration-200 group-hover:translate-x-1"
                    >
                      &rarr;
                    </span>
                  </button>
                </span>
              </div>
            </motion.div>
          </motion.div>
        </div>
      </GuideGround>
    </>
  );
}
