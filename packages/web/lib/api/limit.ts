import { NextResponse } from "next/server";

/** How many requests one caller may make to one route in a window, and how long the window is. */
export const PER_MINUTE = 60;
const WINDOW_SECONDS = 60;

/**
 * The most callers remembered at once, so a flood of addresses cannot grow this
 * process without bound. The oldest window leaves when a new caller arrives,
 * which at this size means a caller has to be quiet for a while before their
 * count is forgotten early.
 */
const CALLERS_MAX = 5_000;

type Window = { since: number; used: number };

const windows = new Map<string, Window>();

/**
 * The caller's address as the host reports it.
 *
 * Vercel writes the client address into x-forwarded-for on the way in, so the
 * first entry is the one this app is behind exactly one proxy for. Nothing here
 * trusts a header the caller can write when the host set one of its own: when
 * neither header is there, every such request shares one bucket, which is the
 * safe side to be wrong on.
 */
export function callerAddress(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  const first = forwarded?.split(",")[0]?.trim();
  if (first !== undefined && first !== "") {
    return first;
  }
  return request.headers.get("x-real-ip")?.trim() || "unknown";
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
): { ok: true } | { ok: false; retryAfter: number } {
  const key = `${route}:${address}`;
  const window = windows.get(key);

  if (window === undefined || now - window.since >= WINDOW_SECONDS * 1_000) {
    if (windows.size >= CALLERS_MAX) {
      const oldest = windows.keys().next();
      if (!oldest.done) {
        windows.delete(oldest.value);
      }
    }
    windows.set(key, { since: now, used: 1 });
    return { ok: true };
  }

  if (window.used >= PER_MINUTE) {
    return { ok: false, retryAfter: Math.max(1, Math.ceil((window.since + WINDOW_SECONDS * 1_000 - now) / 1_000)) };
  }

  window.used += 1;
  return { ok: true };
}

/** The answer a caller over the limit gets: the same shape as every other refusal on these routes. */
export function tooMany(retryAfter: number): NextResponse {
  return NextResponse.json(
    { error: "too many requests from here. Wait a moment and ask again." },
    { status: 429, headers: { "retry-after": String(retryAfter) } },
  );
}

/** Only for tests: the counters are process memory, so one test's flood is not another's. */
export function forgetCallers(): void {
  windows.clear();
}
