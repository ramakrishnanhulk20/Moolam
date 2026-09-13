import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { Filters } from "@/components/explore/Filters";
import { Grid } from "@/components/explore/Grid";
import { Masthead } from "@/components/explore/Masthead";
import { buildPlates } from "@/components/explore/plates";
import { filterFor, readExploreSearch } from "@/components/explore/query";
import type { ExplorePlate } from "@/components/explore/sort";
import { reason } from "@/lib/chain/client";
import {
  explorePassports,
  registryCounts,
  type PassportCursor,
  type RegistryCounts,
} from "@/lib/data/passports";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "explore" });
  return { title: t("title"), description: t("lede") };
}

// Every visit reads the index, so a passport registered a minute ago is on the
// sheet a minute later.
export const dynamic = "force-dynamic";

/**
 * The registry as a contact sheet: every passport on Monad, newest first, with
 * the chips that narrow it and the search that finds one.
 *
 * Nothing here is a sample. The rows, the counts and the marks all come from
 * the index, and the seed pictures the scripts wrote are in the grid with
 * everybody else, sorted last and named as what they are.
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

  const [page, totals] = await Promise.allSettled([
    explorePassports({ filter: filterFor(search) }),
    registryCounts(),
  ]);

  if (page.status === "fulfilled") {
    plates = await buildPlates(page.value.passports);
    cursor = page.value.cursor;
  } else {
    gridError = reason(page.reason);
  }

  if (totals.status === "fulfilled") {
    counts = totals.value;
  } else {
    countsError = reason(totals.reason);
  }

  return (
    <div className="mx-auto w-full max-w-[1400px] px-5 py-16 sm:px-8 sm:py-24">
      <Masthead locale={locale} counts={counts} countsError={countsError} />
      <Filters search={search} />
      <Grid first={plates} cursor={cursor} search={search} indexError={gridError} />
    </div>
  );
}
