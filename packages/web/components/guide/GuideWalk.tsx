"use client";

import { motion } from "framer-motion";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState, type RefObject } from "react";
import { useIsReducedMotion } from "@/components/motion/useIsReducedMotion";
import { Link } from "@/lib/i18n/routing";
import { GuideGround, type GuideClose, type GuideStage } from "./GuideGround";
import { GuideMarkDrawing } from "./marks";
import { HANG, cardWidth, placeCard, type Box, type Placement } from "./place";
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

/** What the walk has measured: the stage, the light, and where the card goes once it can be placed. */
interface View {
  room: { width: number; height: number };
  spot: Spot | null;
  place: Placement | null;
}

/** The phone's home indicator strip, read off the padding the wrapper asks CSS for. */
function safeBottom(node: HTMLElement | null): number {
  return node === null ? 0 : Number.parseFloat(window.getComputedStyle(node).paddingBottom) || 0;
}

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

/**
 * The calls the card keeps off, where a reader can see them, measured against
 * the stage: the first screen's drop and its Make one, and the film's own two
 * once the film is showing.
 *
 * A call the film has faded out while being scrolled is left out: the card
 * only has to stay off what a visitor could actually press. Opacity is asked
 * of the browser where it can answer, and a browser that cannot is taken at
 * its word that the call is there.
 */
export function heroCalls(root: ParentNode, origin: Stage): Box[] {
  return [...root.querySelectorAll<HTMLElement>("[data-hero-call]")]
    .filter(onScreen)
    .filter((node) => typeof node.checkVisibility !== "function" || node.checkVisibility({ opacityProperty: true }))
    .map((node) => {
      const box = node.getBoundingClientRect();
      return {
        x: Math.round(box.left - origin.left),
        y: Math.round(box.top - origin.top),
        width: Math.round(box.width),
        height: Math.round(box.height),
      };
    });
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
  // null until the walk has looked at least once. Nothing may be drawn before
  // that: see the note on measured below.
  const [view, setView] = useState<View | null>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const holder = useRef<HTMLDivElement>(null);

  const step = guideSteps[index];

  // The walk always starts at the beginning, however it was last left. Adjusted
  // while rendering rather than in an effect, so the first frame after an open
  // is already step one instead of a flash of whatever it was closed on.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setView(null);
      if (index !== 0) {
        setIndex(0);
      }
    }
  }

  // Measuring is the one thing that cannot be done while rendering: the step has
  // to be on the screen before its box can be read, and so does the card, whose
  // height decides where it can go.
  //
  // It keeps looking, every frame, because the thing being pointed at moves. The
  // bottom bar slides up from its own height when it arrives, so a single
  // measurement on open put the light 56 px below the tab on a phone, under the
  // very tab it was meant to be lighting. A frame where nothing has changed
  // costs a few box reads and no render at all, so the loop is quiet the moment
  // the page settles, and this is also what handles a resize, a rotation and a
  // header that rearranges itself on the way down to a phone.
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

      const root = scope?.current ?? document.body;
      const spot = spotFor(step.anchor, root, origin);
      // Nothing found, and it may still be on its way: the bottom bar mounts
      // a moment after the page does and wakes a moment after that. Say
      // nothing rather than say the wrong thing.
      const waiting = spot === null && performance.now() - from < PATIENCE;
      if (!waiting) {
        const room = { width: origin.width, height: origin.height };
        // The card is drawn unseen at its real width first, because its height
        // is what decides where it can go. Until it has been measured it has
        // no place, and a card with no place is not shown.
        const card = holder.current;
        const place =
          card === null
            ? null
            : placeCard({
                stage: room,
                spot,
                height: card.offsetHeight,
                safeBottom: safeBottom(wrap.current),
                keepClear: heroCalls(root, origin),
              });
        // One string for the whole view, so a frame where nothing moved
        // costs a comparison and no render.
        const next: View = { room, spot, place };
        const key = JSON.stringify(next);
        if (key !== held) {
          held = key;
          setView(next);
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
  const measured = view !== null;
  const spot = view?.spot ?? null;
  const place = view?.place ?? null;

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
        {/* The padding is never seen: it is how the loop learns the height of
            the phone's home indicator strip, which only CSS can read. */}
        <div
          ref={wrap}
          className="absolute inset-0"
          style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
        >
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
          {spot !== null && place !== null && place.below ? (
            <motion.span
              aria-hidden
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="absolute w-px bg-accent/50"
              style={{
                left: spot.x + 16,
                top: spot.y + spot.height,
                height: HANG,
              }}
            />
          ) : null}

          {/* The placement is carried as a transform rather than as top and
              left. The card follows the light, and the light follows a bottom
              bar that slides up from its own height as it arrives, so a card
              placed with top moved with it and the browser counted every frame
              of that as the page shifting under the reader: 0.015 on a phone.
              A transform moves nothing as far as layout is concerned.

              Until it has a place the card is drawn hidden, only so it can be
              measured. Once placed it is drawn afresh, already where it
              belongs. A motion element with no starting point of its own
              starts at nought, the top left corner of the screen, which is
              where the card used to be seen for a frame before it slid across
              the window to its anchor. */}
          <motion.div
            key={place === null ? "measuring" : "placed"}
            ref={holder}
            data-guide-card={place === null ? "measuring" : "placed"}
            className="pointer-events-auto absolute left-0 top-0"
            style={{
              width: place?.width ?? cardWidth(view?.room.width ?? 0),
              visibility: place === null ? "hidden" : undefined,
            }}
            initial={false}
            animate={place === null ? { x: 0, y: 0 } : { x: place.x, y: place.y }}
            transition={
              reduced
                ? { duration: 0.2 }
                : { type: "spring", stiffness: 260, damping: 32 }
            }
          >
            <GuideCard
              key={step.id}
              index={index}
              lit={spot !== null}
              reduced={reduced}
              onClose={onClose}
              onForward={forward}
            />
          </motion.div>
        </div>
      </GuideGround>
    </>
  );
}

/**
 * One step's card: what it is called, what it is for, the way there and the
 * ways on.
 *
 * Drawn on its own so it can be rendered without the walk around it, which is
 * how its ink is checked against both themes in a real browser.
 */
export function GuideCard({
  index,
  lit,
  reduced,
  onClose,
  onForward,
}: {
  index: number;
  /** False when the step's thing is not on this screen, which the card then says. */
  lit: boolean;
  reduced: boolean;
  onClose: (reason: GuideClose) => void;
  onForward: () => void;
}) {
  const t = useTranslations("guide");
  const step = guideSteps[index];
  const counter = t("step", {
    shown: String(index + 1).padStart(2, "0"),
    total: String(guideSteps.length).padStart(2, "0"),
  });

  return (
    <motion.div
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

      {!lit ? (
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
            onClick={onForward}
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
  );
}
