/**
 * The co-sign handle: 16 random bytes the verify service handed a platform
 * once, written as 32 lowercase hex characters. It is a capability, not an id
 * (P4): whoever holds it can open the record, so it rides in the link's
 * fragment, which a browser never sends to a server, an analytics beacon or a
 * Referer header, and this page reads it from there and nowhere else.
 */

const HANDLE = /^[0-9a-f]{32}$/;

/**
 * The handle in a location's fragment, or null when the fragment is not
 * exactly one handle. Only the fragment is read: a handle in the path or the
 * query string would already have reached a server log, so a link that puts it
 * there is treated as no link at all.
 */
export function handleFrom(hash: string): string | null {
  const body = hash.startsWith("#") ? hash.slice(1) : hash;
  return HANDLE.test(body) ? body : null;
}

/** The current page's handle. Called only in the browser, after the first paint. */
export function readHandle(): string | null {
  if (typeof window === "undefined") {
    return null;
  }
  return handleFrom(window.location.hash);
}

/**
 * An address with its fragment cut off, for anything that reports a page's
 * address somewhere else. A value that does not parse is cut at the first "#"
 * by hand, so a malformed address still never carries a handle out.
 */
export function withoutFragment(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    return parsed.toString();
  } catch {
    const at = url.indexOf("#");
    return at === -1 ? url : url.slice(0, at);
  }
}

/**
 * The beforeSend both Vercel's counter and Speed Insights are given, so neither
 * ever sees a co-sign handle (P4). Every page goes through it, because a
 * fragment on any page is nothing a visit counter needs.
 */
export function stripFragment<T extends { url: string }>(event: T): T {
  return { ...event, url: withoutFragment(event.url) };
}
