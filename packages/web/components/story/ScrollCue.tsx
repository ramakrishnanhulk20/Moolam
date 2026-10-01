"use client";

import { useTranslations } from "next-intl";
import { useEffect, useRef } from "react";
import { filmPlace } from "@/components/story/signals";

/**
 * How long after the film has reached the window a gesture starts to count.
 * The scroll that carried the reader down from the first screen above is still
 * landing for about this long, and it is not a reader who has read the cue.
 */
const SETTLE_MS = 700;

/**
 * The one instruction the first screen needs.
 *
 * Nine pages of story sit behind a title that fills the window, and someone who
 * does not scroll sees the first frame of a film and leaves. It goes the moment
 * anybody scrolls and never comes back, and the fade is written straight to the
 * node so this never re-renders while the scene is drawing.
 *
 * The film now sits under the home page's first screen, so the cue only starts
 * listening once the film has reached the window: the scroll that brought the
 * reader down to it would otherwise take it away before it was seen.
 */
export function ScrollCue() {
  const t = useTranslations("story");
  const node = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = node.current;
    if (el === null) {
      return;
    }

    let gone = false;
    let arrived: number | null = null;
    let timer = 0;
    let frame = 0;

    const remove = () => {
      window.removeEventListener("wheel", dismiss);
      window.removeEventListener("touchmove", dismiss);
      window.removeEventListener("scroll", dismiss);
      window.removeEventListener("keydown", onKey);
    };

    function dismiss() {
      if (gone || el === null || arrived === null || performance.now() - arrived < SETTLE_MS) {
        return;
      }
      gone = true;
      el.style.opacity = "0";
      remove();
    }

    function onKey(event: KeyboardEvent) {
      if (["ArrowDown", "PageDown", "End", " ", "Spacebar"].includes(event.key)) {
        dismiss();
      }
    }

    window.addEventListener("wheel", dismiss, { passive: true });
    window.addEventListener("touchmove", dismiss, { passive: true });
    window.addEventListener("scroll", dismiss, { passive: true });
    window.addEventListener("keydown", onKey);

    // The scroll may belong to the canvas, so the window may never report one.
    // Twelve seconds of reading the title is long enough for a hint to have
    // done its job either way, counted from the film reaching the window. The
    // box watched is the pinned stage: on the page's own scroll the film's
    // section is far taller than the window and never "here" by its top.
    const watch = () => {
      const box = el.closest<HTMLElement>("[data-film-stage]")?.getBoundingClientRect();
      const room = document.documentElement.scrollHeight - window.innerHeight;
      if (box === undefined || filmPlace(box.top, window.scrollY, room) === "here") {
        arrived = performance.now();
        timer = window.setTimeout(dismiss, 12_000);
        return;
      }
      frame = requestAnimationFrame(watch);
    };
    frame = requestAnimationFrame(watch);

    return () => {
      remove();
      cancelAnimationFrame(frame);
      window.clearTimeout(timer);
    };
  }, []);

  return (
    <div
      ref={node}
      aria-hidden
      className="film-cue pointer-events-none absolute inset-x-0 z-40 px-5 opacity-100 transition-opacity duration-700 sm:px-8 lg:px-14"
    >
      <div className="mx-auto flex w-full max-w-[100rem] items-center gap-3">
        <span className="font-mono text-[10px] uppercase tracking-[0.3em] text-accent/80">{t("scrollCue")}</span>
        <span className="relative block h-px w-16 overflow-hidden bg-line-strong">
          <span className="scroll-spark absolute inset-y-0 left-0 block w-6 bg-accent/80" />
        </span>
      </div>
    </div>
  );
}
