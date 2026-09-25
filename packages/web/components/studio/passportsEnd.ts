/**
 * The column counts of the studio's passport grid, from sm up: two, then three
 * from lg, then four from xl. A phone's one column is never short. These must
 * match the grid's own classes in YourPassports.tsx.
 */
export const PASSPORT_COLUMNS = { sm: 2, lg: 3, xl: 4 } as const;

export type PassportEnd = { sm: number; lg: number; xl: number };

/**
 * How many cells the short last row leaves empty at each column count. Zero
 * means the row is full there.
 *
 * The grid draws its hairlines by showing the line colour through a one pixel
 * gap, so an empty cell shows as a solid grey box. The closing cell takes
 * exactly these cells instead. This is Explore's rule (components/explore/end.ts)
 * with this grid's columns: CSS grid has no "rest of this row" that auto
 * placement honours, so the count is worked out from the real number of cards,
 * and again every time Load more adds some.
 */
export function passportEnd(count: number): PassportEnd {
  const left = (columns: number) => {
    const over = count % columns;
    return over === 0 ? 0 : columns - over;
  };
  return { sm: left(PASSPORT_COLUMNS.sm), lg: left(PASSPORT_COLUMNS.lg), xl: left(PASSPORT_COLUMNS.xl) };
}

// Written out in full so Tailwind finds every class it has to generate.
const SM = ["sm:hidden", "sm:block sm:col-span-1"];
const LG = ["lg:hidden", "lg:block lg:col-span-1", "lg:block lg:col-span-2"];
const XL = ["xl:hidden", "xl:block xl:col-span-1", "xl:block xl:col-span-2", "xl:block xl:col-span-3"];

/** The classes that show the closing cell over exactly the empty cells, and hide it where the row is full. */
export function passportEndClasses(end: PassportEnd): string {
  return `hidden ${SM[end.sm]} ${LG[end.lg]} ${XL[end.xl]}`;
}

/** True when the closing cell shows at one column count or more. */
export function hasPassportEnd(end: PassportEnd): boolean {
  return end.sm + end.lg + end.xl > 0;
}
