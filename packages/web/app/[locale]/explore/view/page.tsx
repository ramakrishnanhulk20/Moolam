import type { Metadata } from "next";
import { setRequestLocale } from "next-intl/server";
import { ExploreSheet, exploreMetadata } from "@/components/explore/Sheet";
import { readExploreSearch } from "@/components/explore/query";

// Every chip, every search term and every agent link is a different sheet, so
// this one is drawn on the request. What it costs is still held for a minute
// under the view it belongs to, so a chip a second reader presses is already
// read.
export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  return await exploreMetadata(locale);
}

/**
 * Explore, narrowed by what the address says.
 *
 * Nobody types this path and no link on the site points at it: the rule in
 * proxy.ts hands it every /explore address that names a chip, a search term or
 * an agent, and the reader's address bar keeps saying /explore. So a filtered
 * view can still be copied out of the address bar and opened by somebody else,
 * and the page a bare /explore gets can still be made when the site is built.
 */
export default async function NarrowedExplorePage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const search = readExploreSearch(await searchParams);

  return <ExploreSheet locale={locale} search={search} stored={false} />;
}
