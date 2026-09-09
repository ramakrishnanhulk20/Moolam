import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { StoryStage } from "@/components/story/StoryStage";
import { storyData } from "@/components/story/data";

// Every plate, every figure and both counts are read on the request. A
// prerendered copy would show whatever was true when the build ran, which is
// not what live means to anyone looking at it.
export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "story" });

  // The card itself is app/opengraph-image.tsx, which Next attaches to every
  // route under it along with these two lines. Setting openGraph by hand here
  // would replace that whole block and take the picture with it.
  return { title: t("title"), description: t("line") };
}

/**
 * The first thing anybody sees: eight beats of one image getting a passport,
 * flown as a camera move through the live registry.
 *
 * A reader who has asked for less motion, or a browser that cannot open a 3D
 * context, gets the same eight beats stacked down a still page with the same
 * live figures. The story decides which of the two in the browser, so this page
 * renders neither on the server.
 */
export default async function HomePage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);

  const data = await storyData();

  // The story owns the whole window. The app header floats over its first
  // screen rather than pushing it down, which is what makes the opening frame
  // read as a shot rather than as a section under a navigation bar.
  return (
    <div className="-mt-[73px]">
      <StoryStage data={data} />
    </div>
  );
}
