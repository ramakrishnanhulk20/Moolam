import { NextResponse, type NextRequest } from "next/server";
import { EXPLORE_KEYS, narrowsExplore } from "@/components/explore/query";
import { callerAddress, tooManyPage, withinLimit } from "@/lib/api/limit";

/**
 * One rule, for one route.
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
  const onView = /\/explore\/view\/?$/.test(request.nextUrl.pathname);
  if (!onView && !narrowsExplore(request.nextUrl.searchParams)) {
    return NextResponse.next();
  }

  // The router prefetches every chip a reader can see, fourteen of them on one
  // page view, and each prefetch reaches this rule like a press would. Counted,
  // four page views spent a reader's whole minute before they pressed anything,
  // and the press itself was refused; that is what Ram met on 22 September. A
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

// Only the Explore addresses reach this. Every other page on the site is served
// with nothing in front of it.
export const config = { matcher: ["/:locale/explore", "/:locale/explore/view"] };
