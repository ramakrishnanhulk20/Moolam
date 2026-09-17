import { notFound } from "next/navigation";
import { setRequestLocale } from "next-intl/server";
import { HeroBench } from "@/components/lab/hero/HeroBench";
import { storyData } from "@/components/story/data";

// The field is read on the request, like the film's own. A prerendered copy
// would show whichever pictures were registered when the build ran, and the
// count is the whole point of this bench.
export const dynamic = "force-dynamic";

/**
 * The hero bench: the first screen with the two buttons in each of the two
 * places they could go. Nothing links here and the flag that opens it is only
 * set on this machine, so the route is a 404 everywhere else.
 */
export default async function HeroLabPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (process.env.NEXT_PUBLIC_LAB_PAGES !== "1") {
    notFound();
  }

  const { locale } = await params;
  setRequestLocale(locale);

  const asked = platesAsked(searchParams === undefined ? undefined : (await searchParams).plates);
  const data = await storyData();

  return (
    <HeroBench
      data={asked === null ? data : { ...data, plates: data.plates.slice(0, asked) }}
      asked={asked}
    />
  );
}

/**
 * How many plates the bench should show, from the address.
 *
 * The registry grows while the bench is open, so the two counts worth looking
 * at are the eight real pictures on chain today and the thirteen there will be
 * once the writes land. Anything else leaves the field at whatever the index
 * actually holds.
 */
function platesAsked(asked: string | string[] | undefined): number | null {
  if (typeof asked !== "string") {
    return null;
  }
  const count = Number.parseInt(asked, 10);
  return Number.isFinite(count) && count > 0 ? count : null;
}
