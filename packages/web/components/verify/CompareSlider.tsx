"use client";

import { useTranslations } from "next-intl";
import { useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { Picture } from "@/components/passport/Picture";
import { pictureSources } from "@/lib/images";

/**
 * Where the handle goes for a key, or null for a key the slider leaves alone.
 * Shift takes bigger steps, the way a slider in the operating system does.
 */
export function wipeStep(at: number, key: string, shift: boolean): number | null {
  const step = shift ? 20 : 5;
  const moves: Record<string, number> = {
    ArrowLeft: at - step,
    ArrowDown: at - step,
    ArrowRight: at + step,
    ArrowUp: at + step,
    PageDown: at - 20,
    PageUp: at + 20,
    Home: 0,
    End: 100,
  };
  return key in moves ? Math.min(100, Math.max(0, moves[key])) : null;
}

/**
 * The reader's copy and the registered picture in one frame, the copy cut back
 * to a handle they drag across it.
 *
 * Nothing is measured here. The two pictures are laid over each other so a
 * reader can see for themselves what the verify service's figures on the card
 * describe; a fingerprint worked out in this browser would sample the picture
 * differently from the service and put a second, disagreeing number beside its
 * answer.
 */
export function CompareSlider({
  copy,
  registered,
  title,
  fallback,
}: {
  /** The reader's own file, as a blob address in this browser. */
  copy: string;
  /** The registered picture's pinned address. */
  registered: string;
  title: string;
  fallback: ReactNode;
}) {
  const t = useTranslations("verify.compare");
  const [at, setAt] = useState(50);
  const box = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  const follow = (event: PointerEvent<HTMLDivElement>) => {
    const frame = box.current?.getBoundingClientRect();
    if (frame === undefined || frame.width === 0) {
      return;
    }
    const fromLeft = ((event.clientX - frame.left) / frame.width) * 100;
    setAt(Math.min(100, Math.max(0, fromLeft)));
  };

  const keys = (event: KeyboardEvent<HTMLDivElement>) => {
    const next = wipeStep(at, event.key, event.shiftKey);
    if (next !== null) {
      event.preventDefault();
      setAt(next);
    }
  };

  // Drawn left to right in every language: the handle is a position across a
  // picture, and a picture does not mirror for a right-to-left reader.
  return (
    <div
      ref={box}
      dir="ltr"
      data-compare-wipe
      className="grain relative aspect-[16/9] cursor-ew-resize touch-none select-none overflow-hidden border-b border-line bg-bg-sunken"
      onPointerDown={(event) => {
        dragging.current = true;
        event.currentTarget.setPointerCapture?.(event.pointerId);
        follow(event);
      }}
      onPointerMove={(event) => {
        if (dragging.current) {
          follow(event);
        }
      }}
      onPointerUp={() => {
        dragging.current = false;
      }}
      onPointerCancel={() => {
        dragging.current = false;
      }}
    >
      <Picture
        sources={pictureSources(registered)}
        sizes="(min-width: 1024px) 46vw, 100vw"
        alt={`${title}. ${t("registered")}`}
        className="object-cover"
        fallback={fallback}
      />
      <span className="absolute inset-0" style={{ clipPath: `inset(0 ${100 - at}% 0 0)` }}>
        {/* The reader's file is a blob address in this browser, so there is
            nothing for the optimizer to fetch. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={copy} alt={t("yours")} draggable={false} className="absolute inset-0 h-full w-full object-cover" />
      </span>

      <Tag side="left">{t("yours")}</Tag>
      <Tag side="right">{t("registered")}</Tag>
      <span className="pointer-events-none absolute bottom-3 left-1/2 z-10 -translate-x-1/2 rounded-[4px] bg-[#08080a]/70 px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.18em] text-[#f4f2ee]/85">
        {t("drag")}
      </span>

      <div
        role="slider"
        tabIndex={0}
        aria-label={t("label")}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(at)}
        aria-valuetext={`${Math.round(at)}%`}
        onKeyDown={keys}
        className="group absolute inset-y-0 z-20 w-11 -translate-x-1/2 outline-none"
        style={{ left: `${at}%` }}
      >
        <span className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-[#f4f2ee]/90 shadow-[0_0_12px_rgba(0,0,0,0.6)]" />
        <span className="absolute left-1/2 top-1/2 flex h-11 w-7 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-[8px] border border-[#f4f2ee]/80 bg-[#08080a]/85 transition-transform duration-200 group-hover:scale-110 group-focus-visible:ring-2 group-focus-visible:ring-accent motion-reduce:transition-none">
          <span className="motif h-[9px] w-[9px]" />
        </span>
      </div>
    </div>
  );
}

/** The picture labels sit on the picture itself, so they keep their own dark ground in either theme. */
function Tag({ side, children }: { side: "left" | "right"; children: ReactNode }) {
  return (
    <span
      className={`pointer-events-none absolute top-3 z-10 max-w-[45%] truncate rounded-[4px] bg-[#08080a]/80 px-2 py-1 font-mono text-[10px] uppercase tracking-[0.18em] text-[#f4f2ee] ${
        side === "left" ? "left-3" : "right-3"
      }`}
    >
      {children}
    </span>
  );
}
