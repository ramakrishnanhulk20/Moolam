import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { StoryStage } from "@/components/story/StoryStage";
import { heldStory } from "@/components/story/data";

// Every plate, every figure and both counts are read from the registry, and the
// page is rebuilt from that read a minute at a time rather than on every
// request. The index itself only catches up on that cadence, so nobody is
// shown a figure older than the index could have given them, and nobody waits
// behind twenty six upstream calls to see the first frame.
export const revalidate = 60;

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "story" });

  // The card itself is app/opengraph-image.tsx, which Next attaches to every
  // route under it along with these two lines. Setting openGraph by hand here
  // would replace that whole block and take the picture with it.
  // The home page is the one page whose title is the brand on its own, so it
  // steps around the template rather than reading "Moolam | Moolam".
  return { title: { absolute: t("title") }, description: t("line") };
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

  const data = await heldStory();

  // The story owns the whole window. The app header floats over its first
  // screen rather than pushing it down, which is what makes the opening frame
  // read as a shot rather than as a section under a navigation bar.
  return (
    <div className="-mt-[73px]">
      <StoryStage data={data} />
    </div>
  );
}
