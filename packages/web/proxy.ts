import { NextResponse, type NextRequest } from "next/server";
import { EXPLORE_KEYS, narrowsExplore } from "@/components/explore/query";
import { callerAddress, tooManyPage, withinLimit } from "@/lib/api/limit";

/** A passport or agent address: the language, which of the two, and the id. */
const ID_PAGE = /^\/([^/]+)\/(passport|agent)\/([^/]+)\/?$/;

/** The ids the two pages read, the same tests each page runs before it asks the chain anything. */
const WELL_FORMED: Record<"passport" | "agent", RegExp> = {
  passport: /^0x[0-9a-fA-F]{64}$/,
  agent: /^[0-9]{1,20}$/,
};

/**
 * Where a passport or agent address is drawn, or null when the address is
 * neither.
 *
 * Both pages open under a loading screen, and a loading screen sends the page's
 * first bytes with a 200 before the page can say the id is nonsense; a not-found
 * thrown after that only adds a noindex tag. So an id that cannot name anything
 * is sent here, before any page starts, to an address under the same language
 * that no route claims, and the catch-all there answers with a real 404. A
 * well-formed id is handed back as it came.
 */
export function idPageTarget(pathname: string): string | null {
  const match = ID_PAGE.exec(pathname);
  if (match === null) {
    return null;
  }
  const [, locale, route, id] = match as unknown as [string, string, "passport" | "agent", string];
  return WELL_FORMED[route].test(id) ? pathname : `/${locale}/no-such-${route}`;
}

/**
 * The Explore rule, for one route.
 *
 * An Explore address that names a chip, a search term or an agent is handed to
 * the sibling route that reads the query and draws it on the request. Every
 * other Explore address falls through to the page the build made.
 *
 * It is a rewrite rather than a redirect, so the address bar never changes:
 * every link written before this route split in two still works, still reads
 * back as the view it was copied from, and still opens for whoever it was sent
 * to.
 *
 * One caller gets sixty narrowed views a minute. The narrowed route is drawn on
 * the request and every one of them asks the index, which the whole site shares
 * a budget on, so an open loop here starves Explore for everybody else. The
 * bare page is never counted: it is built ahead of time and costs nothing.
 */
export default function proxy(request: NextRequest): NextResponse {
  const idTarget = idPageTarget(request.nextUrl.pathname);
  if (idTarget !== null) {
    if (idTarget === request.nextUrl.pathname) {
      return NextResponse.next();
    }
    const missing = request.nextUrl.clone();
    missing.pathname = idTarget;
    return NextResponse.rewrite(missing);
  }

  const onView = /\/explore\/view\/?$/.test(request.nextUrl.pathname);
  if (!onView && !narrowsExplore(request.nextUrl.searchParams)) {
    return NextResponse.next();
  }

  // The router prefetches every chip a reader can see, fourteen of them on one
  // page view, and each prefetch reaches this rule like a press would. Counted,
  // four page views spent a reader's whole minute before they pressed anything,
  // and the press itself was refused; that is what happened on 22 September. A
  // prefetch is not a press, so it is let through uncounted, and the chips no
  // longer ask for one in any case.
  const prefetch =
    request.headers.get("next-router-prefetch") === "1" || request.headers.get("purpose") === "prefetch";
  if (!prefetch) {
    const rate = withinLimit("explore", callerAddress(request));
    if (!rate.ok) {
      return tooManyPage(rate.retryAfter);
    }
  }

  // The chips link to the view route directly. An older link, or one typed by
  // hand, still names the bare page with a query, and is handed to the same
  // route so it keeps working.
  const narrowed = request.nextUrl.clone();
  if (!onView) {
    narrowed.pathname = `${narrowed.pathname.replace(/\/+$/, "")}/view`;
  }

  // A campaign tag or a tracking parameter riding along would otherwise be a
  // cache entry of its own for a sheet the page draws identically, so the only
  // keys that reach the route are the ones it can read.
  for (const key of [...narrowed.searchParams.keys()]) {
    if (!(EXPLORE_KEYS as readonly string[]).includes(key)) {
      narrowed.searchParams.delete(key);
    }
  }

  if (onView && narrowed.search === request.nextUrl.search) {
    return NextResponse.next();
  }
  return NextResponse.rewrite(narrowed);
}

// Only the Explore, passport and agent addresses reach this. Every other page on
// the site is served with nothing in front of it.
export const config = {
  matcher: ["/:locale/explore", "/:locale/explore/view", "/:locale/passport/:id", "/:locale/agent/:id"],
};
