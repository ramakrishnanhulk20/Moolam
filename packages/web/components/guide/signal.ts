/**
 * The shout that opens the guide, and nothing else.
 *
 * It lives alone because the footer's entry is in the layout, which every route
 * renders. Reading this name from the guide's own module would put the whole
 * walk, its drawings and framer-motion into the scripts of every page on the
 * site for the sake of one string.
 */
export const GUIDE_OPEN_EVENT = "moolam:guide:open";

/** Asks whichever page is carrying the guide to open it. */
export function tellGuideToOpen(): void {
  window.dispatchEvent(new Event(GUIDE_OPEN_EVENT));
}
