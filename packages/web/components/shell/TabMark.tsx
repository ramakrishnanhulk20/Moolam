import type { ReactNode } from "react";
import type { TabKey } from "./tabs";

/**
 * The five marks, drawn here rather than pulled from an icon pack.
 *
 * Every one of them is built out of the site's own motif, the seal: square
 * corners, one weight of line, a filled square where something is the subject.
 * A rounded consumer icon set beside the passport plates would read as a
 * different product, and a pack would want a licence or a credit line.
 */
export function TabMark({ name, size = 22 }: { name: TabKey; size?: number }) {
  return (
    <svg
      aria-hidden
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="square"
      strokeLinejoin="miter"
      shapeRendering="geometricPrecision"
    >
      {MARKS[name]}
    </svg>
  );
}

const MARKS: Record<TabKey, ReactNode> = {
  // The seal itself: the mark on the favicon, the social card and every kicker.
  home: (
    <>
      <rect x="3.5" y="3.5" width="17" height="17" />
      <rect x="9.5" y="9.5" width="5" height="5" fill="currentColor" stroke="none" />
    </>
  ),
  // The contact sheet: four plates, one of them the picture being read.
  explore: (
    <>
      <rect x="3.5" y="3.5" width="7" height="7" fill="currentColor" stroke="none" />
      <rect x="13.5" y="3.5" width="7" height="7" />
      <rect x="3.5" y="13.5" width="7" height="7" />
      <rect x="13.5" y="13.5" width="7" height="7" />
    </>
  ),
  // A plate with the answer written across it.
  verify: (
    <>
      <rect x="3.5" y="3.5" width="17" height="17" />
      <polyline points="7.5,12.5 10.8,15.8 16.5,8.7" />
    </>
  ),
  // The frame of a picture that does not exist yet.
  make: (
    <>
      <rect x="3.5" y="3.5" width="17" height="17" />
      <line x1="12" y1="8" x2="12" y2="16" />
      <line x1="8" y1="12" x2="16" y2="12" />
    </>
  ),
  // A stack: the pictures this account has already registered.
  mine: (
    <>
      <polyline points="7.5,6.5 20.5,6.5 20.5,19.5" />
      <rect x="3.5" y="9.5" width="13" height="11" />
    </>
  ),
};
