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
  if (!narrowsExplore(request.nextUrl.searchParams)) {
    return NextResponse.next();
  }

  const rate = withinLimit("explore", callerAddress(request));
  if (!rate.ok) {
    return tooManyPage(rate.retryAfter);
  }

  const narrowed = request.nextUrl.clone();
  narrowed.pathname = `${narrowed.pathname.replace(/\/+$/, "")}/view`;

  // A campaign tag or a tracking parameter riding along would otherwise be a
  // cache entry of its own for a sheet the page draws identically, so the only
  // keys that reach the route are the ones it can read.
  for (const key of [...narrowed.searchParams.keys()]) {
    if (!(EXPLORE_KEYS as readonly string[]).includes(key)) {
      narrowed.searchParams.delete(key);
    }
  }

  return NextResponse.rewrite(narrowed);
}

// Only the Explore addresses reach this. Every other page on the site is served
// with nothing in front of it.
export const config = { matcher: "/:locale/explore" };
