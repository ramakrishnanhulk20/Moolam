"use client";

import { useTranslations } from "next-intl";
import { useEffect, useRef } from "react";

/**
 * The one instruction the first screen needs.
 *
 * Nine pages of story sit behind a title that fills the window, and someone who
 * does not scroll sees the first frame of a film and leaves. It goes the moment
 * anybody scrolls and never comes back, and the fade is written straight to the
 * node so this never re-renders while the scene is drawing.
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

    const remove = () => {
      window.removeEventListener("wheel", dismiss);
      window.removeEventListener("touchmove", dismiss);
      window.removeEventListener("scroll", dismiss);
      window.removeEventListener("keydown", onKey);
    };

    function dismiss() {
      if (gone || el === null) {
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

    // The scroll belongs to the canvas, so the window may never report one.
    // Twelve seconds of reading the title is long enough for a hint to have
    // done its job either way.
    const timer = window.setTimeout(dismiss, 12_000);

    return () => {
      remove();
      window.clearTimeout(timer);
    };
  }, []);

  return (
    <div
      ref={node}
      aria-hidden
      className="pointer-events-none absolute inset-x-0 bottom-7 z-40 px-5 opacity-100 transition-opacity duration-700 sm:px-8 lg:px-14"
    >
      <div className="mx-auto flex w-full max-w-[100rem] items-center gap-3">
        <span className="font-mono text-[10px] uppercase tracking-[0.3em] text-accent/80">{t("scrollCue")}</span>
        <span className="relative block h-px w-16 overflow-hidden bg-white/15">
          <span className="scroll-spark absolute inset-y-0 left-0 block w-6 bg-accent/80" />
        </span>
      </div>
    </div>
  );
}
