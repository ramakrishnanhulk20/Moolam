"use client";

import type { CSSProperties, ReactNode } from "react";
import { BottomBar, type BarShape } from "@/components/shell/BottomBar";
import { PhoneHeader } from "@/components/shell/PhoneHeader";
import { BAR_ROOM } from "@/components/shell/tabs";
import { RAISED_TABS, TABS } from "./words";

export interface Phone {
  label: string;
  width: number;
  height: number;
}

/** The two screens the drawings are measured on. */
export const PHONES: Phone[] = [
  { label: "375 x 812", width: 375, height: 812 },
  { label: "360 x 780", width: 360, height: 780 },
];

/**
 * A phone on a laptop: the real shell around a real page, at the real size.
 *
 * The transform on the box turns it into the containing block for anything
 * inside it that is position fixed, so the bar lands on the bottom of the frame
 * exactly as it lands on the bottom of a window, with no lab-only positioning
 * in the bar itself. --bar-safe hands the scroller the 34 px home indicator
 * strip a tall iPhone has and a laptop does not.
 *
 * What these two frames cannot do is the page's own layout. A media query reads
 * the window, never the box, so the page inside takes the laptop's layout and
 * is clipped rather than reflowed. The bar, the header, the safe strip and the
 * room left under the page are all true here; the page's own columns are not,
 * and the full bleed link under each frame is where those are measured. Framing
 * the route in an iframe, which would fix it, is refused by the site's own
 * x-frame-options header, and that header is worth more than this bench.
 */
export function PhoneFrame({
  shape,
  phone,
  route,
  film,
  children,
}: {
  shape: BarShape;
  phone: Phone;
  /** The route the framed page is standing on, which is what the bar lights. */
  route: string;
  /** True on the one page that carries the pinned film. */
  film: boolean;
  children: ReactNode;
}) {
  const frame: CSSProperties = {
    width: phone.width,
    height: phone.height,
    transform: "translateZ(0)",
    ["--bar-safe" as string]: "34px",
  };

  return (
    <div className="relative overflow-hidden border border-line-strong bg-bg" style={frame}>
      {/* data-lenis-prevent: Lenis drives the window on this page, and without
          it a wheel over the frame would scroll the bench instead of the phone. */}
      <div
        data-lenis-prevent
        data-phone-scroll
        className="h-full overflow-y-auto overflow-x-hidden"
        style={{ paddingBottom: BAR_ROOM }}
      >
        <PhoneHeader brand="Moolam" />
        {children}
      </div>

      <BottomBar
        tabs={shape === "raised" ? RAISED_TABS : TABS}
        label="Sections"
        shape={shape}
        at={route}
        film={film}
      />

      {/* The home indicator the safe strip is left for, drawn because a laptop
          has none of its own. */}
      <span
        aria-hidden
        className="pointer-events-none absolute bottom-[11px] left-1/2 h-[5px] w-[134px] -translate-x-1/2 rounded-full bg-text/35"
      />
    </div>
  );
}
