import type { ReactNode } from "react";
import { TabMark } from "@/components/shell/TabMark";
import type { MarkName } from "./menu";

/**
 * One small mark per menu item, drawn with the tab bar's pen: square ends, one
 * weight of line, a filled square where something is the subject. The four
 * places the tab bar already draws reuse its marks, so a page reads the same
 * in the menu and under the thumb. The business page carries the site's own
 * knot, because it is the page that sells Moolam itself.
 */
export function ItemMark({ name, size = 20 }: { name: MarkName; size?: number }) {
  if (name === "verify" || name === "make" || name === "mine" || name === "explore") {
    return <TabMark name={name} size={size} />;
  }
  if (name === "business") {
    return (
      <span aria-hidden className="inline-flex items-center justify-center" style={{ width: size, height: size }}>
        <span className="motif h-[86%] w-[86%] bg-current" />
      </span>
    );
  }
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

const MARKS: Record<Exclude<MarkName, "verify" | "make" | "mine" | "explore" | "business">, ReactNode> = {
  // A page with its first line set heavier.
  docs: (
    <>
      <rect x="4.5" y="3.5" width="15" height="17" />
      <line x1="8" y1="8" x2="16" y2="8" strokeWidth={2.4} />
      <line x1="8" y1="12" x2="16" y2="12" />
      <line x1="8" y1="16" x2="13" y2="16" />
    </>
  ),
  // Two brackets round a filled square: code that carries a passport.
  kit: (
    <>
      <polyline points="7.5,4.5 3.5,4.5 3.5,19.5 7.5,19.5" />
      <polyline points="16.5,4.5 20.5,4.5 20.5,19.5 16.5,19.5" />
      <rect x="9" y="9" width="6" height="6" fill="currentColor" stroke="none" />
    </>
  ),
  // Two plates joined by one line: an agent talking to the registry.
  mcp: (
    <>
      <rect x="3.5" y="3.5" width="7" height="7" />
      <rect x="13.5" y="13.5" width="7" height="7" fill="currentColor" stroke="none" />
      <polyline points="10.5,7 17,7 17,13.5" />
    </>
  ),
  // A board: three bars of different heights, the first one leading.
  agents: (
    <>
      <rect x="4" y="5" width="4" height="15" fill="currentColor" stroke="none" />
      <rect x="10.5" y="9.5" width="3" height="10" />
      <rect x="16.5" y="13.5" width="3" height="6" />
    </>
  ),
  // A price tag cut square.
  pricing: (
    <>
      <polygon points="3.5,3.5 13,3.5 20.5,11 11,20.5 3.5,13" />
      <rect x="7" y="7" width="3" height="3" fill="currentColor" stroke="none" />
    </>
  ),
  // A frame with an arrow leaving it: this one opens another site.
  live: (
    <>
      <polyline points="11,4.5 4.5,4.5 4.5,19.5 19.5,19.5 19.5,13" />
      <line x1="11" y1="13" x2="20" y2="4" />
      <polyline points="14,4 20,4 20,10" />
    </>
  ),
  // A shield, square shouldered, with the answer inside.
  shield: (
    <>
      <path d="M4.5 4.5h15v7.5c0 4.2-3.3 7.1-7.5 8.5-4.2-1.4-7.5-4.3-7.5-8.5z" />
      <polyline points="8.5,12 11,14.5 15.5,9.5" />
    </>
  ),
};

/** The arrow a tile draws on hover: a line and its head, so the line can grow without the head stretching. */
export function Arrow({ external = false, className = "" }: { external?: boolean; className?: string }) {
  return (
    <svg
      aria-hidden
      width={16}
      height={16}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="square"
      className={className}
    >
      {external ? (
        <>
          <line x1="4" y1="12" x2="12" y2="4" />
          <polyline points="6,4 12,4 12,10" />
        </>
      ) : (
        <>
          <line x1="2" y1="8" x2="13" y2="8" />
          <polyline points="9,4 13,8 9,12" />
        </>
      )}
    </svg>
  );
}

/** The chevron on each side's trigger. It turns over when the side is open. */
export function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      aria-hidden
      width={10}
      height={10}
      viewBox="0 0 10 10"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="square"
      className={`transition-transform duration-200 ${open ? "rotate-180" : ""}`}
    >
      <polyline points="2,3.5 5,6.5 8,3.5" />
    </svg>
  );
}
