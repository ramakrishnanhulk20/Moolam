/**
 * What a page does after the index would not answer it.
 *
 * Kept apart from the component that draws it so the schedule can be held to in
 * a test without a browser: the whole point of these numbers is that a page
 * which failed never turns into a page that asks again and again.
 */

/** The waits before the first, second and third try, in seconds. Three tries, then it stops. */
export const RETRY_WAITS = [5, 10, 20] as const;

/** How many automatic tries a failure is given. */
export const RETRY_LIMIT = RETRY_WAITS.length;

/**
 * Whether the index turned this read away for asking too often.
 *
 * The line comes from reason() in lib/chain/client.ts, which carries the
 * endpoint's own status: "the Envio endpoint answered 429".
 */
export function isRateLimited(said: string): boolean {
  return /(^|[^0-9])429([^0-9]|$)/.test(said) || /too many requests/i.test(said);
}

/**
 * The wait before the next try, or null once the page has stopped trying.
 *
 * A 429 is the index asking for room, so every wait after one is doubled: the
 * answer to being told there is no room is to take longer, never to come back
 * at the same pace.
 */
export function waitBefore(tried: number, rateLimited: boolean): number | null {
  if (tried < 0 || tried >= RETRY_LIMIT) {
    return null;
  }
  return RETRY_WAITS[tried] * (rateLimited ? 2 : 1);
}

/**
 * One second of the countdown.
 *
 * A tab nobody is looking at holds where it is rather than reaching the end and
 * firing a query into a page on a screen somebody closed an hour ago.
 */
export function tick(secondsLeft: number, visible: boolean): number {
  return visible ? Math.max(0, secondsLeft - 1) : secondsLeft;
}
