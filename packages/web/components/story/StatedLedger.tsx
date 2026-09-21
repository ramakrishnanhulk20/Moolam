"use client";

import { useTranslations } from "next-intl";
import { useEffect, useRef } from "react";
import { UseMark } from "@/components/consent/Marks";
import { USE_TONES } from "@/components/consent/tones";
import { USE_FIELDS, type Consent, type UseField } from "@/lib/chain/consent";
import { captionCue, clamp01, span, type Beat } from "@/components/story/beats";
import { plateEdge, progress } from "@/components/story/signals";

/**
 * The register arriving on the picture, drawn rather than described.
 *
 * A thin rule runs along the plate's lower edge from the day the picture was
 * registered to today, a notch drops on the day the holder wrote their
 * statement, and the four use marks stamp in beside it. It is the consent
 * card's own language on the film's ground: the same rule, the same notch, and
 * the same four shapes out of components/consent/Marks.tsx.
 *
 * It is drawn in the document and not in the scene. The marks are hairlines a
 * few pixels across and the labels are dates: as a canvas texture on a mesh
 * they would be soft at any pixel density and cost an upload every frame. So
 * the scene publishes where the plate is (signals.plateEdge) and this reads it
 * from its own animation frame, which is how the captions over the film already
 * work. React never renders per frame, and every write below is a transform or
 * an opacity, so a frame of this costs no layout.
 */

/** One statement, ready to draw: no bigints, no chain types, nothing left to format. */
export interface LedgerView {
  consent: Consent;
  /** Where the statement sits on the rule, 0 at the registration day and 1 at today. */
  notch: number;
  /** Already in the reader's own language, formatted by whoever had the formatter. */
  registered: string;
  writtenShort: string;
}

/**
 * How far the drawing has got, from how far the beat has played.
 *
 * The rule draws first, the notch lands the moment the rule reaches the day it
 * belongs to, and the four marks stamp one after another once the rule is home.
 * Pure, so the order can be checked without a browser.
 */
export function ledgerShape(played: number, notch: number): { drawn: number; landed: number; marks: number[] } {
  const along = span(played, 0, 0.45);
  const drawn = 1 - Math.pow(1 - along, 3);
  return {
    drawn,
    landed: clamp01((drawn - notch) / 0.06),
    // The last one is down well before the words start to leave, so the four
    // of them are a picture to look at rather than a thing that was happening.
    marks: [0, 1, 2, 3].map((at) => clamp01((played - (0.48 + at * 0.08)) / 0.1)),
  };
}

/**
 * The four marks and their names, in the order the contract stores them.
 *
 * The names are the passport card's own short ones, read out of
 * passport.consent.usesShort, so the film and the card a judge opens next
 * cannot call the same use two different things in the same language.
 */
function marksOf(consent: Consent, name: (field: UseField) => string) {
  return USE_FIELDS.map((field) => ({
    field,
    state: consent[field],
    tone: USE_TONES[consent[field]],
    name: name(field),
  }));
}

/** The rule's own width before it is scaled to the frame, so no frame ever changes a layout. */
const BASE = 1000;

/** How far apart the four marks stand on the film, wide enough for the longest name under them. */
const PITCH = 118;

const ROW = PITCH * 3 + 26;

const LABEL = "font-mono text-[10px] uppercase leading-none tracking-[0.18em]";

/**
 * The rule as it lies on the film, following the plate.
 *
 * The line it lies on is the plate's own lower edge, tilt and all, taken from
 * the two corners the scene projects. Its two ends are the frame's rather than
 * the plate's: this is a close shot, the picture runs off the side of the
 * screen, and a rule whose "registered" end was off screen would be a timeline
 * with one date on it. So the geometry comes from the picture and the extent
 * comes from the frame, and both ends are always readable.
 */
export function PlateLedger({ view, beat, fade }: { view: LedgerView; beat: Beat; fade: number }) {
  const root = useRef<HTMLDivElement>(null);
  const rail = useRef<HTMLDivElement>(null);
  const scrim = useRef<HTMLDivElement>(null);
  const guide = useRef<HTMLDivElement>(null);
  const drawn = useRef<HTMLDivElement>(null);
  const head = useRef<HTMLDivElement>(null);
  const today = useRef<HTMLSpanElement>(null);
  const notch = useRef<HTMLDivElement>(null);
  const written = useRef<HTMLSpanElement>(null);
  const stamps = useRef<(HTMLDivElement | null)[]>([]);
  const t = useTranslations("story.stated");
  const names = useTranslations("passport.consent.usesShort");
  const uses = marksOf(view.consent, names);

  useEffect(() => {
    const box = root.current;
    if (box === null) {
      return;
    }

    // The frame's size is read on a resize and never inside the loop: one
    // measurement taken between two writes is a forced reflow every frame.
    let width = box.clientWidth;
    let height = box.clientHeight;
    const watch = new ResizeObserver(() => {
      width = box.clientWidth;
      height = box.clientHeight;
    });
    watch.observe(box);

    let frame = 0;
    let wasShown = -1;

    const { write, fade9 } = writer();

    const loop = () => {
      const shown = plateEdge.shown ? captionCue(progress.scroll, beat, fade).shown : 0;
      if (shown !== wasShown) {
        wasShown = shown;
        box.style.opacity = String(shown);
      }

      // Nothing below is worth a write while the beat is off screen, and on a
      // phone the ledger stacks with the words instead: this element is
      // display:none there and has no box at all.
      if (shown <= 0.001 || width === 0) {
        frame = requestAnimationFrame(loop);
        return;
      }

      const leftX = ((plateEdge.leftX + 1) / 2) * width;
      const leftY = ((1 - plateEdge.leftY) / 2) * height;
      const rightX = ((plateEdge.rightX + 1) / 2) * width;
      const rightY = ((1 - plateEdge.rightY) / 2) * height;

      const slope = rightX - leftX > 1 ? (rightY - leftY) / (rightX - leftX) : 0;
      const from = width * 0.06;
      const to = Math.min(width * 0.54, Math.max(from + 280, rightX - 24));
      const length = to - from;
      // A plate that has drifted out of the lower half of the frame would hang
      // the rule off the top of the shot, so the line it lies on is held in the
      // band a reader is looking for it in.
      const y = Math.min(Math.max(leftY + (from - leftX) * slope, height * 0.46), height * 0.84);
      const angle = (Math.atan(slope) * 180) / Math.PI;

      const shape = ledgerShape(progress.stated, view.notch);
      const notchAt = length * view.notch;
      const row = notchAt + 20 + ROW > length ? notchAt - 20 - ROW : notchAt + 20;

      write(rail.current, `translate3d(${from.toFixed(1)}px, ${y.toFixed(1)}px, 0) rotate(${angle.toFixed(2)}deg)`);
      write(scrim.current, `scaleX(${((length + 80) / BASE).toFixed(4)})`);
      write(guide.current, `scaleX(${(length / BASE).toFixed(4)})`);
      write(drawn.current, `scaleX(${((length * shape.drawn) / BASE).toFixed(4)})`);
      write(head.current, `translate3d(${(length * shape.drawn).toFixed(1)}px, 0, 0)`);
      write(today.current, `translate3d(${length.toFixed(1)}px, 0, 0)`);
      write(notch.current, `translate3d(${notchAt.toFixed(1)}px, 0, 0) scaleY(${(0.3 + shape.landed * 0.7).toFixed(3)})`);
      fade9(notch.current, shape.landed);
      // The day sits on the side the marks did not take, so it can never land
      // on the first mark, and above the rule, where it can never land on the
      // registration day at the other end of a short life.
      write(written.current, row > notchAt ? "translateX(calc(-100% - 8px))" : "translateX(8px)");

      for (const [at, node] of stamps.current.entries()) {
        const on = shape.marks[at];
        // A stamp lands: it comes down out of the frame and settles, rather
        // than fading up where it will end.
        write(node, `translate3d(${(row + at * PITCH).toFixed(1)}px, 0, 0) scale(${(1 + Math.pow(1 - on, 2) * 0.8).toFixed(3)})`);
        fade9(node, on);
      }

      frame = requestAnimationFrame(loop);
    };

    frame = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(frame);
      watch.disconnect();
    };
  }, [beat, fade, view.notch]);

  return (
    <div
      ref={root}
      aria-hidden
      data-stated-ledger="pinned"
      className="pointer-events-none absolute inset-0 z-20 hidden sm:block"
      style={{ opacity: 0 }}
    >
      <div ref={rail} className="absolute left-0 top-0 h-0 w-0 origin-top-left will-change-transform">
        {/* The dark pool the dates read over. A hairline on a bright sky is a
            hairline nobody sees. It fades to nothing at both ends, so this is
            still one shot rather than a shot with a panel laid on it. */}
        <div
          ref={scrim}
          className="absolute -left-10 origin-left will-change-transform"
          style={{
            top: "-104px",
            width: `${BASE}px`,
            height: "168px",
            background:
              "linear-gradient(90deg, rgba(11,11,12,0) 0%, rgba(11,11,12,0.66) 13%, rgba(11,11,12,0.66) 86%, rgba(11,11,12,0) 100%)",
          }}
        />

        <div
          ref={guide}
          data-rule="guide"
          className="absolute left-0 top-0 h-px origin-left bg-white/25 will-change-transform"
          style={{ width: `${BASE}px` }}
        />
        <div
          ref={drawn}
          data-rule="drawn"
          className="absolute left-0 top-0 h-[1.5px] origin-left bg-pending will-change-transform"
          style={{ width: `${BASE}px` }}
        />
        <div ref={head} className="absolute left-0 top-[-2px] h-[5px] w-[4px] bg-pending will-change-transform" />

        <span className={`absolute left-0 top-[11px] whitespace-nowrap text-white/65 ${LABEL}`}>
          {t("registered", { when: view.registered })}
        </span>
        {/* The far end of the rule is today, so the word ends where the rule
            does whatever its length: a fixed pull to the left fitted the
            English word and hung a longer one off the end of the shot. */}
        <span ref={today} className="absolute left-0 top-[11px] origin-left will-change-transform">
          <span className={`block -translate-x-full whitespace-nowrap text-white/65 ${LABEL}`}>{t("today")}</span>
        </span>

        <div ref={notch} data-rule="notch" className="absolute left-0 top-0 h-0 w-0 origin-center will-change-transform">
          <div className="absolute left-0 top-[-14px] h-[26px] w-[1.5px] bg-pending" />
          <span ref={written} className={`absolute left-0 top-[-28px] whitespace-nowrap text-pending will-change-transform ${LABEL}`}>
            {view.writtenShort}
          </span>
        </div>

        {uses.map((use, at) => (
          <div
            key={use.field}
            ref={(node) => {
              stamps.current[at] = node;
            }}
            data-stated-mark={use.field}
            data-stated-use={use.state}
            className="absolute left-0 origin-bottom will-change-transform"
            style={{ top: "-72px", opacity: 0 }}
          >
            <span className={`block ${use.tone}`}>
              <UseMark state={use.state} className="h-6 w-6" />
            </span>
            <span className="mt-2 block whitespace-nowrap font-mono text-[9px] uppercase leading-none tracking-[0.16em] text-white/75">
              {use.name}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Writes a transform or an opacity, and only when it has really changed.
 *
 * Without this the rule, its scrim and the date beside the notch were rewritten
 * sixty times a second for a camera that had barely moved. A repainted gradient
 * and a repainted line of text cost more than everything else in this beat put
 * together: it measured 4.7 ms a frame against the seal beat's 4.2, and 4.0
 * with the writes skipped.
 */
function writer() {
  const lastTransform = new WeakMap<HTMLElement, string>();
  const lastOpacity = new WeakMap<HTMLElement, string>();

  return {
    write(node: HTMLElement | null, transform: string) {
      if (node === null || lastTransform.get(node) === transform) {
        return;
      }
      lastTransform.set(node, transform);
      node.style.transform = transform;
    },
    fade9(node: HTMLElement | null, value: number) {
      const next = value.toFixed(3);
      if (node === null || lastOpacity.get(node) === next) {
        return;
      }
      lastOpacity.set(node, next);
      node.style.opacity = next;
    },
  };
}

/**
 * The same drawing stacked with the words, for a phone and for the still page.
 *
 * On a phone the shot is the top 45 percent of the window and the words own
 * everything below it, so a rule pinned to the picture would be a rule on top
 * of the picture. Here it is a block at the head of the words instead, and it
 * is the same rule with the same notch and the same four marks.
 *
 * `driven` follows the beat's own scroll the way the pinned one does. The still
 * page has no beat to follow, so there it draws itself finished.
 */
export function InlineLedger({
  view,
  driven = false,
  className = "",
}: {
  view: LedgerView;
  driven?: boolean;
  className?: string;
}) {
  const drawn = useRef<HTMLDivElement>(null);
  const notch = useRef<HTMLDivElement>(null);
  const stamps = useRef<(HTMLDivElement | null)[]>([]);
  const t = useTranslations("story.stated");
  const names = useTranslations("passport.consent.usesShort");
  const uses = marksOf(view.consent, names);
  const at = `${(view.notch * 100).toFixed(2)}%`;

  useEffect(() => {
    if (!driven) {
      return;
    }
    let frame = 0;
    const { write, fade9 } = writer();

    const loop = () => {
      const shape = ledgerShape(progress.stated, view.notch);
      write(drawn.current, `scaleX(${shape.drawn.toFixed(4)})`);
      fade9(notch.current, shape.landed);
      for (const [index, node] of stamps.current.entries()) {
        fade9(node, shape.marks[index]);
      }
      frame = requestAnimationFrame(loop);
    };

    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, [driven, view.notch]);

  return (
    <div aria-hidden data-stated-ledger="inline" className={`w-full max-w-[22rem] ${className}`}>
      {/* The two ends of the rule, each pinned to its own side and allowed to
          wrap: the registration line is a date in the reader's language and in
          Tamil or German it is half again as long as the English one. */}
      <div className="flex items-baseline justify-between gap-3 font-mono text-[9px] uppercase leading-[1.4] tracking-[0.16em] text-text-faint">
        <span className="text-start">{t("registered", { when: view.registered })}</span>
        <span className="shrink-0 text-end">{t("today")}</span>
      </div>

      <div className="relative mt-2.5 h-px w-full bg-white/25">
        <div
          ref={drawn}
          data-rule="drawn"
          className="absolute inset-0 origin-left bg-pending"
          style={{ transform: driven ? "scaleX(0)" : "scaleX(1)" }}
        />
        <div
          ref={notch}
          className="absolute top-0 h-0 w-0"
          style={{ left: at, opacity: driven ? 0 : 1 }}
        >
          <div className="absolute left-0 top-[-9px] h-[19px] w-[1.5px] bg-pending" />
          <span
            className="absolute left-0 top-[14px] whitespace-nowrap font-mono text-[9px] uppercase leading-none tracking-[0.14em] text-pending"
            style={{ transform: view.notch > 0.78 ? "translateX(-100%)" : "translateX(-50%)" }}
          >
            {view.writtenShort}
          </span>
        </div>
      </div>

      {/* The gap clears the written day hanging under the rule and no more:
          on a phone this block, the caption above it and the readout below it
          all have to stand inside the half screen the words are given. */}
      <div className="mt-7 grid grid-cols-4 gap-2">
        {uses.map((use, index) => (
          <div
            key={use.field}
            ref={(node) => {
              stamps.current[index] = node;
            }}
            data-stated-mark={use.field}
            data-stated-use={use.state}
            style={{ opacity: driven ? 0 : 1 }}
          >
            <span className={`block ${use.tone}`}>
              <UseMark state={use.state} className="h-5 w-5" />
            </span>
            <span className="mt-2 block font-mono text-[8px] uppercase leading-[1.3] tracking-[0.12em] text-text-faint">
              {use.name}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
