import { NextResponse } from "next/server";

/** How many requests one caller may make to one route in a window, and how long the window is. */
export const PER_MINUTE = 60;
const WINDOW_SECONDS = 60;

/**
 * The most callers remembered at once, so a flood of addresses cannot grow this
 * process without bound. The quietest caller leaves when a new one arrives, so a
 * caller has to stop asking before their count is forgotten early.
 */
const CALLERS_MAX = 5_000;

type Window = { since: number; used: number };

const windows = new Map<string, Window>();

/**
 * The headers the host writes the caller's address into, in the order they are
 * trusted.
 *
 * Vercel's own header is read first. Its documentation says x-vercel-forwarded-for
 * carries the same address as x-forwarded-for but survives a proxy placed on top
 * of Vercel, which is the one arrangement where x-forwarded-for holds somebody
 * else's value, and x-real-ip is that address again.
 */
const HOST_WRITTEN = ["x-vercel-forwarded-for", "x-real-ip"] as const;

/** Where every request lands when nothing in front of this app named its caller. */
export const SHARED_BUCKET = "unnamed";

/**
 * The caller's address, as the host reports it.
 *
 * x-forwarded-for is deliberately not read. Vercel overwrites it on the way in
 * and refuses to forward an external one, so on the deployed site it is safe but
 * adds nothing; anywhere else, including `next start` behind nothing and this
 * machine's dev server, a caller writes it themselves and would be handed a
 * fresh counter for every address they invent. When none of the trusted headers
 * is there, every such request shares one bucket instead. That counts a whole
 * office as one caller, which is the safe side to be wrong on.
 */
export function callerAddress(request: Request): string {
  for (const header of HOST_WRITTEN) {
    const written = request.headers.get(header)?.split(",")[0]?.trim();
    if (written !== undefined && written !== "") {
      return written;
    }
  }
  return SHARED_BUCKET;
}

/**
 * Whether this caller may make one more request to this route, and how long
 * they must wait when they may not.
 *
 * One fixed window per caller per route, held in this process's memory. It is
 * not a shared counter across instances and it is not meant to be: these two
 * routes read the chain through a paid endpoint, and the thing worth stopping
 * is one script in a loop, which a single instance sees all of.
 */
export function withinLimit(
  route: string,
  address: string,
  now: number = Date.now(),
  allowed: number = PER_MINUTE,
): { ok: true } | { ok: false; retryAfter: number } {
  const key = `${route}:${address}`;
  const window = windows.get(key);

  if (window === undefined || now - window.since >= WINDOW_SECONDS * 1_000) {
    windows.delete(key);
    if (windows.size >= CALLERS_MAX) {
      const quietest = windows.keys().next();
      if (!quietest.done) {
        windows.delete(quietest.value);
      }
    }
    windows.set(key, { since: now, used: 1 });
    return { ok: true };
  }

  // A Map hands its keys back in the order they were first set, and neither
  // raising a count nor refusing one moves a key. Without this delete and set,
  // the caller evicted when the table fills is the one who arrived earliest,
  // which is the flooder, and forgetting their window hands them a fresh sixty.
  // Touching a caller here moves them to the end, so what leaves is whoever has
  // been silent longest.
  windows.delete(key);
  windows.set(key, window);

  if (window.used >= allowed) {
    return { ok: false, retryAfter: Math.max(1, Math.ceil((window.since + WINDOW_SECONDS * 1_000 - now) / 1_000)) };
  }

  window.used += 1;
  return { ok: true };
}

/** What a caller over the limit is told, in the one place both the routes and the rule in front of them read it from. */
export const TOO_MANY = "too many requests from here. Wait a moment and ask again.";

/** The answer a caller over the limit gets: the same shape as every other refusal on these routes. */
export function tooMany(retryAfter: number): NextResponse {
  return NextResponse.json({ error: TOO_MANY }, { status: 429, headers: { "retry-after": String(retryAfter) } });
}

/**
 * The same refusal as a page, for an address a reader typed rather than a route
 * a script called. A JSON body would be downloaded rather than read.
 */
export function tooManyPage(retryAfter: number): NextResponse {
  const page = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>Too many requests</title></head><body style="margin:0;display:grid;place-items:center;min-height:100vh;background:#0b0b0c;color:#e7e7e8;font:16px/1.6 ui-sans-serif,system-ui,sans-serif"><main style="max-width:38ch;padding:24px"><p>${TOO_MANY}</p></main></body></html>`;

  return new NextResponse(page, {
    status: 429,
    headers: {
      "retry-after": String(retryAfter),
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

/** Only for tests: the counters are process memory, so one test's flood is not another's. */
export function forgetCallers(): void {
  windows.clear();
}
