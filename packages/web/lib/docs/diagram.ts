/**
 * The smallest share of its drawn size a diagram is ever shown at in the page.
 *
 * Fitting the 2,868 px system overview into a 705 px frame shrank its 14 px
 * labels to about 3.5 px, which is a picture of text rather than text. At 0.6 a
 * label is still about 8 px and can be read without opening the drawing, so
 * below that the frame stops shrinking and scrolls sideways instead.
 */
export const DIAGRAM_SCALE_FLOOR = 0.6;

/** The size mermaid drew a diagram at, read from its viewBox, else its width and height. */
export function drawnSize(svg: string): { width: number; height: number } | null {
  const open = /<svg\b[^>]*>/i.exec(svg)?.[0];
  if (open === undefined) {
    return null;
  }
  const box = /\bviewBox\s*=\s*"([^"]+)"/i.exec(open)?.[1];
  if (box !== undefined) {
    const [, , width, height] = box.trim().split(/[\s,]+/).map(Number);
    if (width > 0 && height > 0) {
      return { width, height };
    }
  }
  const width = Number(/\bwidth\s*=\s*"([\d.]+)(?:px)?"/i.exec(open)?.[1]);
  const height = Number(/\bheight\s*=\s*"([\d.]+)(?:px)?"/i.exec(open)?.[1]);
  return width > 0 && height > 0 ? { width, height } : null;
}

/**
 * The scale a drawing is shown at in a frame with this much room: its own size
 * when it fits, the frame's width when that keeps it at the floor or above, and
 * the floor otherwise, with the rest reached by scrolling.
 */
export function diagramScale(natural: number, room: number, floor = DIAGRAM_SCALE_FLOOR): number {
  if (natural <= 0 || room <= 0) {
    return 1;
  }
  return Math.min(1, Math.max(floor, room / natural));
}

/**
 * The same rule as diagramScale, written as a width the browser settles itself,
 * so the drawing is the right size on its first paint and at every window width
 * without anything measuring it.
 */
export function diagramWidth(natural: number, floor = DIAGRAM_SCALE_FLOOR): string {
  const least = Math.round(natural * floor * 10) / 10;
  return `clamp(${least}px, 100%, ${natural}px)`;
}
