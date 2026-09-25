/**
 * The column counts of the Explore grid, narrowest screen first: two on a
 * phone, three from `sm`, four from `xl`. These must match the grid's own
 * classes in Grid.tsx, which name the same three breakpoints.
 */
export const GRID_COLUMNS = { base: 2, sm: 3, xl: 4 } as const;

export type EndSpans = { base: number; sm: number; xl: number };

/**
 * How many cells the short last row leaves empty at each column count. Zero
 * means the row is full there and nothing follows the last plate.
 *
 * The grid draws its hairlines by showing the line colour through a one pixel
 * gap, so an empty cell would show as a solid grey box. The end card takes
 * exactly these cells instead. CSS grid has no rule for "the rest of this row"
 * that auto placement honours, so the count is worked out from the real number
 * of plates, and it is recomputed every time "Load more" adds some.
 */
export function endSpans(count: number): EndSpans {
  const left = (columns: number) => {
    const over = count % columns;
    return over === 0 ? 0 : columns - over;
  };
  return { base: left(GRID_COLUMNS.base), sm: left(GRID_COLUMNS.sm), xl: left(GRID_COLUMNS.xl) };
}

// Written out in full so Tailwind finds every class it has to generate.
const BASE = ["hidden", "flex col-span-1"];
const SM = ["sm:hidden", "sm:flex sm:col-span-1", "sm:flex sm:col-span-2"];
const XL = ["xl:hidden", "xl:flex xl:col-span-1", "xl:flex xl:col-span-2", "xl:flex xl:col-span-3"];

/** The classes that show the end card over exactly the empty cells, and hide it where the row is full. */
export function endClasses(spans: EndSpans): string {
  return `${BASE[spans.base]} ${SM[spans.sm]} ${XL[spans.xl]}`;
}

/** True when the end card shows at one column count or more. */
export function hasEnd(spans: EndSpans): boolean {
  return spans.base + spans.sm + spans.xl > 0;
}
