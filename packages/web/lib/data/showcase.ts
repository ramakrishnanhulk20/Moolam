import type { Hex } from "viem";

/** One hand-picked picture, by its passport and the title its document carries. */
export interface ShowcasePick {
  id: Hex;
  title: string;
}

/**
 * The three pictures a judge is offered to try, in order (Ram, 1 October:
 * "Hand-pick a showcase set").
 *
 * Left to the newest, the row offered whatever was registered last, which on a
 * busy day was a game character or a seed card. These are three original
 * pictures chosen on purpose. Each is held to the title it was picked under, so
 * a different document behind the same id never slips in under a chosen name.
 * The list carries nothing server side, so the film's own panel can offer the
 * same three.
 */
export const SHOWCASE: readonly ShowcasePick[] = [
  { id: "0xcdb25d3755452efa3b746f168cf9cefd3a1b693ab2b81d260a2d64f13d771638", title: "Monsoon Fishing Nets Drying" },
  { id: "0xc7f3f3f00252519e5bef4f59c48285e2bbefe4c6ecf8625b9d8f6bc9e23256c4", title: "A human standing alone in the moon." },
  { id: "0x0c45b008db6a6b74b203e63e7659fc86c60c2598d762e0280c4ae12fc57e0e2e", title: "Marina Beach Kite Sellers at Dusk" },
];
