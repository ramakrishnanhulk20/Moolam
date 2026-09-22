import { notFound } from "next/navigation";
import { setRequestLocale } from "next-intl/server";
import type { ReactNode } from "react";
import manifest from "@/app/manifest";
import { HomeFixture } from "@/components/lab/phone/HomeFixture";
import type { InstallShape } from "@/components/lab/phone/InstallFrames";
import { MakeFixture } from "@/components/lab/phone/MakeFixture";
import { MineFixture } from "@/components/lab/phone/MineFixture";
import { PhoneBench } from "@/components/lab/phone/PhoneBench";
import { VerifyFixture } from "@/components/lab/phone/VerifyFixture";
import type { PageKey } from "@/components/lab/phone/words";
import { DEFAULT_SEARCH } from "@/components/explore/query";
import { ExploreSheet } from "@/components/explore/Sheet";
import { storyData } from "@/components/story/data";
import { offeredSamples } from "@/lib/data/offeredSamples";

// Every plate, figure and count inside the frames is read on the request. A
// prerendered copy would put whatever was true at build time behind a bar whose
// whole argument is that the real pages fit under it.
export const dynamic = "force-dynamic";

const KEYS: PageKey[] = ["home", "explore", "verify", "make", "mine"];

/**
 * The phone bench: the tab bar Ram asked for on 22 September, in two drawings,
 * with the real pages inside the frames.
 *
 * One render draws one page, named in the address, and hands the same rendered
 * page to both frames. Looking at the sheet therefore asks the index for the
 * sheet and for nothing else, and asks for it once.
 *
 * Nothing links here and the flag that opens it is only set on this machine.
 * The bench is English: no word of it goes into the ten message files until a
 * drawing is picked.
 */
export default async function PhoneLabPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (process.env.NEXT_PUBLIC_LAB_PAGES !== "1") {
    notFound();
  }

  const { locale } = await params;
  setRequestLocale(locale);

  const asked = await searchParams;
  const drawing = one(asked.full);
  const full = drawing === "a" || drawing === "b" ? drawing : null;
  const wanted = one(asked.page);
  const page = (KEYS as string[]).includes(wanted) ? (wanted as PageKey) : "home";
  const size = one(asked.size) === "1" ? 1 : 0;

  const app = manifest();
  const install: InstallShape = {
    name: String(app.name),
    shortName: String(app.short_name ?? app.name),
    description: String(app.description ?? ""),
    startUrl: String(app.start_url),
    display: String(app.display ?? "browser"),
    themeColor: String(app.theme_color ?? "#08080a"),
    backgroundColor: String(app.background_color ?? "#08080a"),
    icon: String(app.icons?.[0]?.src ?? "/icon.svg"),
  };

  return (
    <PhoneBench
      full={full}
      page={page}
      size={size}
      safe={one(asked.safe) === "1"}
      install={install}
      content={await framed(page, locale)}
    />
  );
}

/** The one page a full bleed frame was asked for, with its own live reads and no others. */
async function framed(page: PageKey, locale: string): Promise<ReactNode> {
  if (page === "home") {
    return <HomeFixture data={await storyData()} />;
  }
  if (page === "explore") {
    return <ExploreSheet locale={locale} search={DEFAULT_SEARCH} stored={false} />;
  }
  if (page === "verify") {
    const offered = await offeredSamples();
    return <VerifyFixture samples={offered.samples} />;
  }
  if (page === "make") {
    return <MakeFixture />;
  }
  return <MineFixture />;
}

function one(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? (value[0] ?? "") : (value ?? "")).trim();
}
