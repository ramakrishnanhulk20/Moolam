/**
 * Whether this browser has already been offered the first-visit guide, and the
 * one rule that decides if it is offered at all.
 *
 * Nothing here touches React, so a page can ask the question without pulling
 * the guide's drawings into its own scripts.
 */

/** The mark a device carries once the guide has been shown and closed. */
export const GUIDE_SEEN_KEY = "moolam:guide:seen";

/**
 * The mark SessionMark writes on a device that has signed in to Moolam.
 *
 * Copied rather than imported: the real one lives in WalletProvider, which is a
 * client module that brings React and the wallet's own loading rules with it,
 * and the guide is read on every page. The two strings are held together by a
 * test that reads WalletProvider's source, so they cannot drift.
 */
export const RETURNING_KEY = "moolam:wallet:returning";

/** Reads one key, answering null when the browser refuses site storage. */
function read(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

/**
 * Whether the guide has already been shown on this device.
 *
 * A browser that refuses storage counts as "seen". It is the opposite of the
 * wallet's rule on purpose: there the cost of guessing wrong is a hidden panel,
 * here it is a guide that reappears over the home page on every single load,
 * because the closing write would fail too. Quiet is the better failure.
 */
export function guideSeen(): boolean {
  try {
    return window.localStorage.getItem(GUIDE_SEEN_KEY) === "1";
  } catch {
    return true;
  }
}

/** Remembers that this device has been offered the guide. Does nothing if storage refuses. */
export function markGuideSeen(): void {
  try {
    window.localStorage.setItem(GUIDE_SEEN_KEY, "1");
  } catch {
    // Nothing to tell the reader: the guide closes either way, it just cannot
    // promise it will stay closed on a browser that keeps nothing.
  }
}

/** Forgets it, so the guide can be asked for again from the footer. */
export function forgetGuideSeen(): void {
  try {
    window.localStorage.removeItem(GUIDE_SEEN_KEY);
  } catch {
    // Same as above: the entry still opens the guide on the spot.
  }
}

/** Whether this device has ever signed in here. */
export function signedInBefore(): boolean {
  return read(RETURNING_KEY) === "1";
}

/** Everything the rule below needs, gathered in one place so it can be tested without a browser. */
export interface GuideReading {
  seen: boolean;
  /** The device has signed in to Moolam before, so it is nobody's first visit. */
  returning: boolean;
  /** The path being read, locale and all. The bench and the rest of /lab never get the guide. */
  path: string;
}

/** True only on a bench page, which is where this guide is being drawn while it is still a draft. */
export function onLabPage(path: string): boolean {
  return /(^|\/)lab(\/|$)/.test(path);
}

/**
 * The whole rule in one line: a first visit, on a device that has never signed
 * in, on a real page.
 */
export function guideShouldShow(reading: GuideReading): boolean {
  return !reading.seen && !reading.returning && !onLabPage(reading.path);
}

/** The same question asked of the browser this code is running in. */
export function guideShouldShowHere(path: string): boolean {
  return guideShouldShow({ seen: guideSeen(), returning: signedInBefore(), path });
}
