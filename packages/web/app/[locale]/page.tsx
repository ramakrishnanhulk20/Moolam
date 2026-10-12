import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { FirstVisitGuide } from "@/components/guide/FirstVisitGuide";
import { Board } from "@/components/home/Board";
import { FilmGate } from "@/components/home/FilmGate";
import { firstScreenData, holdFirstScreen } from "@/components/home/read";
import { StoryStage } from "@/components/story/StoryStage";
import { heldStory } from "@/components/story/data";
import { routing } from "@/lib/i18n/routing";

// Every plate, every figure and both counts are read from the registry, and the
// page is rebuilt from that read a minute at a time rather than on every
// request. The index itself only catches up on that cadence, so nobody is
// shown a figure older than the index could have given them, and nobody waits
// behind twenty six upstream calls to see the first frame.
export const revalidate = 600;

/**
 * The ten home pages are drawn when the site is built, and rebuilt a minute at
 * a time after that. Without the list the route was drawn on every request,
 * which is not what the minute above says.
 *
 * The first screen's copy is made here, once, before any of the ten are drawn:
 * see holdFirstScreen. A visitor never waits for it: if the hold is empty
 * after a deploy, the background rebuild makes it once (components/home/read.ts).
 */
export async function generateStaticParams(): Promise<{ locale: string }[]> {
  await holdFirstScreen();
  return routing.locales.map((locale) => ({ locale }));
}

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "story" });
  const meta = await getTranslations({ locale, namespace: "meta" });

  // The card itself is app/opengraph-image.tsx, which Next attaches to every
  // route under it along with these two lines. Setting openGraph by hand here
  // would replace that whole block and take the picture with it.
  // The home page is the one page whose title is the brand on its own, so it
  // steps around the template rather than reading "Moolam | Moolam".
  // The film's tagline is five words, which is a poster line and not a search
  // result. The description is the longer sentence that says what Moolam is and
  // names the chain it runs on.
  return { title: { absolute: t("title") }, description: meta("home") };
}

/**
 * The first thing anybody sees: what Moolam is and why it matters, the check
 * itself, and one live finding, all on the first screen and all in the
 * server's markup. Under it, the film told as a chapter: one image getting a
 * passport, flown as a camera move through the live registry. It opens on a
 * chapter title rather than a poster, because the screen above has already
 * named the product and offered both actions, and it ends on the page's one
 * final call.
 *
 * One of its beats is the holder's own word on AI use, read from the consent
 * register on Monad for the passport the film is told on. Nobody invents it: a
 * passport with no statement, or a register that would not answer this minute,
 * plays the chapter without that beat. The chapter is timed by the stated cut's
 * table and falls back the way the stated cut does.
 *
 * A reader who has asked for less motion, or a browser that cannot open a 3D
 * context, gets the same beats stacked down a still page with the same live
 * figures. The story decides which of the two in the browser, so this page
 * renders neither on the server: only the first screen, and the film's box.
 */
export default async function HomePage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);

  const [data, first] = await Promise.all([heldStory(), firstScreenData()]);

  return (
    <>
      <Board finding={first.finding} copy={first.copy} samples={first.samples} loose={first.loose} />
      {/* The film's code and its first pictures wait for the reader to move
          toward it, so nothing of it competes with the screen above. */}
      <FilmGate>
        <StoryStage data={data} variant="chapter" />
      </FilmGate>
      {/* The one screen a first visitor always lands on, so the one place the
          guide is offered from. It draws nothing on the server and nothing for
          a device that has already been here, and it is the ear for the
          footer's "show the guide again". */}
      <FirstVisitGuide />
    </>
  );
}
