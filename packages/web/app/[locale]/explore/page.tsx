import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { Filters } from "@/components/explore/Filters";
import { Grid } from "@/components/explore/Grid";
import { Masthead } from "@/components/explore/Masthead";
import { heldPictureSplit, sheetPage, type PictureSplit } from "@/components/explore/plates";
import { readExploreSearch } from "@/components/explore/query";
import type { ExplorePlate } from "@/components/explore/sort";
import { reason } from "@/lib/chain/client";
import { heldRegistryCounts, type PassportCursor, type RegistryCounts } from "@/lib/data/passports";
import { holdExploreDefault } from "@/lib/data/prerender";

/**
 * The build has no page to make for this route, so its one hook into a build is
 * used to hold the view the page opens on instead of to list addresses. The
 * first visitor after a deploy is then handed that view rather than waiting on a
 * scan of the index and a gateway read for every row it walks past. No address
 * is returned, so nothing about how this route is served changes.
 */
export async function generateStaticParams(): Promise<{ locale: string }[]> {
  await holdExploreDefault();
  return [];
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "explore" });
  return { title: t("title"), description: t("lede") };
}

// The chips and the search term live in the address, so this page is built on
// the request. What it costs is held for a minute instead: the sheet, the three
// counts and the split line, each under the view it belongs to.
export const dynamic = "force-dynamic";

/**
 * The registry as a contact sheet: every passport on Monad, newest first, with
 * the chips that narrow it and the search that finds one.
 *
 * Nothing here is a sample. The rows, the counts and the marks all come from
 * the index. The sheet opens on the pictures, the seed cards the scripts wrote
 * are one chip away rather than hidden, and the line under the counts says how
 * the registry divides between the two.
 */
export default async function ExplorePage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const search = readExploreSearch(await searchParams);

  let plates: ExplorePlate[] = [];
  let cursor: PassportCursor | null = null;
  let gridError: string | null = null;
  let counts: RegistryCounts | null = null;
  let countsError: string | null = null;
  let split: PictureSplit | null = null;

  const [page, totals, divide] = await Promise.allSettled([
    sheetPage(search),
    heldRegistryCounts(),
    heldPictureSplit(),
  ]);

  if (page.status === "fulfilled") {
    plates = page.value.plates;
    cursor = page.value.cursor;
  } else {
    gridError = reason(page.reason);
  }

  if (divide.status === "fulfilled") {
    split = divide.value;
  }

  if (totals.status === "fulfilled") {
    counts = totals.value;
  } else {
    countsError = reason(totals.reason);
  }

  return (
    <div className="mx-auto w-full max-w-[1400px] px-5 py-16 sm:px-8 sm:py-24">
      <Masthead locale={locale} counts={counts} countsError={countsError} split={split} view={search.view} />
      <Filters search={search} />
      <Grid first={plates} cursor={cursor} search={search} indexError={gridError} />
    </div>
  );
}
