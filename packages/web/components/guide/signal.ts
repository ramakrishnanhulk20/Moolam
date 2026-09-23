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

/**
 * The note a press elsewhere leaves for the home page, which is the only page
 * that carries the walk. A shout cannot cross a navigation, so the footer on
 * another page writes this, goes home, and the guide reads it once on arrival.
 *
 * sessionStorage rather than localStorage: the request belongs to this tab and
 * this moment, and a note that outlived the tab could open the walk days later
 * on a visit nobody asked it for.
 */
export const GUIDE_ASKED_KEY = "moolam:guide:asked";

/**
 * Leaves the note. Answers false when the browser refuses storage, in which
 * case the reader still goes home and the walk opens only if it would anyway.
 */
export function askGuideAfterNavigation(): boolean {
  try {
    window.sessionStorage.setItem(GUIDE_ASKED_KEY, "1");
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether a note was waiting, removing it in the same breath so a reload of
 * the home page never opens the walk a second time.
 */
export function takeGuideRequest(): boolean {
  try {
    const asked = window.sessionStorage.getItem(GUIDE_ASKED_KEY) === "1";
    window.sessionStorage.removeItem(GUIDE_ASKED_KEY);
    return asked;
  } catch {
    return false;
  }
}
