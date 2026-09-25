/**
 * Where the walk's card goes, worked out from boxes that have already been
 * measured on the page.
 *
 * Nothing here reads the page, so the rule can be tested against the numbers a
 * real phone and a real laptop reported without a browser in the room.
 */

/** A box in the stage's own coordinates. */
export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Placement {
  x: number;
  y: number;
  width: number;
  /** True when the card hangs straight under the light, which is when the hairline joins the two. */
  below: boolean;
}

/** The widest the card is drawn, on a screen with room for it. */
export const CARD = 320;

/** The gap between the light and the card, which the hairline spans. */
export const HANG = 26;

/** The nearest the card comes to an edge of the screen. */
const EDGE = 16;

/** The nearest the card comes to anything it has been told to leave clear. */
const CLEAR = 12;

/** How wide the card is on a stage this wide: its own width, or the screen less its margins. */
export function cardWidth(stageWidth: number): number {
  return Math.min(CARD, Math.max(240, stageWidth - EDGE * 2));
}

export function overlaps(a: Box, b: Box): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

function grown(box: Box, by: number): Box {
  return { x: box.x - by, y: box.y - by, width: box.width + by * 2, height: box.height + by * 2 };
}

/**
 * Under the light when there is room, over it when there is not, and never off
 * the side of the screen. With nothing lit the card goes to the bottom middle,
 * where a sheet on a phone would be.
 *
 * The card's own measured height decides "room", so it never hangs off the
 * bottom of the screen and never lies over the top of the thing it is lighting.
 *
 * Then one rule over all of those: the card never lies on anything it has been
 * told to keep clear, which on the home page is the hero's two calls. A first
 * visitor who is shown what the site does and then cannot press the button
 * that does it has been guided away from the thing. When the first choice
 * would cover them, the card goes to whichever side of them is nearest to
 * where it wanted to be, still on the screen and still off the light. The
 * light itself never moves: it stays on the step's own anchor.
 */
export function placeCard({
  stage,
  spot,
  height,
  safeBottom = 0,
  keepClear = [],
}: {
  stage: { width: number; height: number };
  spot: Box | null;
  /** The card's own measured height at the width it will be drawn at. */
  height: number;
  /** The phone's home indicator strip, which the card is kept above. */
  safeBottom?: number;
  /** Boxes the card must not cover, in the stage's coordinates. */
  keepClear?: Box[];
}): Placement {
  const width = cardWidth(stage.width);
  const floor = stage.height - safeBottom - EDGE - height;

  let x: number;
  let y: number;
  let below = false;
  if (spot === null) {
    x = Math.max(EDGE, stage.width / 2 - width / 2);
    y = stage.height - safeBottom - 24 - height;
  } else {
    x = Math.min(Math.max(EDGE, spot.x - 12), Math.max(EDGE, stage.width - width - EDGE));
    const under = spot.y + spot.height + HANG;
    below = under <= floor;
    y = below ? under : Math.max(EDGE, spot.y - EDGE - height);
  }

  const blocked = keepClear.map((box) => grown(box, CLEAR));
  const at = (top: number): Box => ({ x, y: top, width, height });
  if (blocked.some((box) => overlaps(at(y), box))) {
    const fits = (top: number) =>
      top >= EDGE &&
      top <= floor &&
      !blocked.some((box) => overlaps(at(top), box)) &&
      (spot === null || !overlaps(at(top), spot));
    const wanted = y;
    const sides = blocked
      .flatMap((box) => [box.y - height, box.y + box.height])
      .filter(fits)
      .sort((one, two) => Math.abs(one - wanted) - Math.abs(two - wanted));
    if (sides.length > 0) {
      y = sides[0];
      below = false;
    }
  }

  return { x: Math.round(x), y: Math.round(y), width, below };
}
