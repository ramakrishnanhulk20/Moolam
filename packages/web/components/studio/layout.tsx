"use client";

import { createContext, useContext, type ReactNode } from "react";

/**
 * How the signed in studio sits on a laptop: the picture on the left, the
 * details and the button on the right. StudioScreen always sets it, so on
 * /studio it is simply how the studio lays out from lg.
 *
 * Every class it adds is an lg: class, so below lg the screen is the one
 * column it always was and a phone or a tablet never sees a difference.
 *
 * A context rather than a prop because the panels it changes sit under the
 * dynamic loaders in LiveStudio. Drawn outside the studio (the account's grid
 * on /mine) the same parts keep their one column.
 */
const Wide = createContext(false);

export function WideLayout({ children }: { children: ReactNode }) {
  return <Wide.Provider value>{children}</Wide.Provider>;
}

export function useWide(): boolean {
  return useContext(Wide);
}

/**
 * The two columns, even halves. The picture is still the largest thing on the
 * screen, and the form beside it needs the width: every line it wraps pushes
 * the button further down the first screen.
 */
export const WIDE_COLUMNS =
  "lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:items-start lg:gap-x-10 xl:gap-x-14";

/**
 * The picture column holds still while the form beside it scrolls, pinned just
 * under the header, so the thing being registered never leaves the screen.
 */
export const WIDE_STAGE = "lg:sticky lg:top-[calc(var(--studio-top,var(--header-h))+1.25rem)]";

/** How far down the screen the box may start before a press moves the page, under the wide layout on a laptop. */
export const WIDE_REACH = 1 / 2;

/** The width the wide layout starts at: Tailwind's lg. */
export const LAPTOP = "(min-width: 64rem)";

/**
 * The height the picture is drawn at on a laptop, the same before a file, with
 * one, and through the run. It is the screen's height less what sits above it
 * and the title field under it, so on a 900 px laptop the picture and its name
 * both end inside the first screen, and a taller screen gets a taller picture.
 */
export const WIDE_PICTURE = "lg:h-[clamp(13rem,calc(100vh-40rem),34rem)]";

/**
 * The panel's own heading under the wide layout: a card's heading on one line,
 * because the page's name above is already the display title.
 */
export const WIDE_CARD_HEADING = "lg:mt-3 lg:max-w-none lg:truncate lg:text-[1.35rem] lg:leading-[1.2]";

/**
 * Where each part of a folded or finished panel sits on a laptop. The markup
 * keeps today's one column order, so a phone reads it unchanged, and the grid
 * places the parts: the picture down the left, the band and the run on the
 * right, the done screen's ways on under them, and the receipt across both.
 */
export const WIDE_FACE = `${WIDE_COLUMNS} lg:grid-rows-[auto_auto_auto]`;
export const AT_LEFT = "lg:col-start-1 lg:row-span-2 lg:row-start-1";
export const AT_RIGHT = "lg:col-start-2 lg:row-start-1";
export const UNDER_RIGHT = "lg:col-start-2 lg:row-start-2";
export const ACROSS = "lg:col-span-2 lg:col-start-1 lg:row-start-3";

/** The extra classes a wide layout adds, with the leading space, or nothing, so the stacked markup is today's to the byte. */
export function wideOnly(wide: boolean, classes: string): string {
  return wide ? ` ${classes}` : "";
}

/**
 * A column of the wide layout, or nothing at all in the stacked one, so the
 * stacked screen gains no wrapper it did not have before.
 */
export function WideColumn({
  wide,
  name,
  className,
  children,
}: {
  wide: boolean;
  name: "picture" | "details";
  className?: string;
  children: ReactNode;
}) {
  return wide ? (
    <div data-studio-column={name} className={className}>
      {children}
    </div>
  ) : (
    <>{children}</>
  );
}
