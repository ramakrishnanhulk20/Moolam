import type { Metadata } from "next";
import { setRequestLocale } from "next-intl/server";
import { ExploreSheet, exploreMetadata } from "@/components/explore/Sheet";
import { DEFAULT_SEARCH } from "@/components/explore/query";
import { holdExploreDefault } from "@/lib/data/prerender";
import { routing } from "@/lib/i18n/routing";

// A minute is the window every read on this page is already held for, so the
// page is made once and refreshed a minute at a time behind whoever asks for
// it. A picture registered now is on the sheet on the next request after that.
export const revalidate = 60;

/**
 * The opening view is made in all ten languages while the site is built, so the
 * first visitor after a deploy is handed the sheet rather than waiting on a scan
 * of the index and a gateway read for every row it walks past. What a build
 * writes into its data cache does not travel to the running site; a page it made
 * does.
 *
 * The chips and the search term live in the address, and an address with a query
 * in it is drawn on the request by the sibling route instead.
 */
export async function generateStaticParams(): Promise<{ locale: string }[]> {
  await holdExploreDefault();
  return routing.locales.map((locale) => ({ locale }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  return await exploreMetadata(locale);
}

export default async function ExplorePage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);

  return <ExploreSheet locale={locale} search={DEFAULT_SEARCH} stored />;
}
