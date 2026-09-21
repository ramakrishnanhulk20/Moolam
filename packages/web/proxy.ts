import { NextResponse, type NextRequest } from "next/server";
import { narrowsExplore } from "@/components/explore/query";

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
 */
export default function proxy(request: NextRequest): NextResponse {
  if (!narrowsExplore(request.nextUrl.searchParams)) {
    return NextResponse.next();
  }

  const narrowed = request.nextUrl.clone();
  narrowed.pathname = `${narrowed.pathname.replace(/\/+$/, "")}/view`;
  return NextResponse.rewrite(narrowed);
}

// Only the Explore addresses reach this. Every other page on the site is served
// with nothing in front of it.
export const config = { matcher: "/:locale/explore" };
