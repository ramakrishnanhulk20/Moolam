import { notFound } from "next/navigation";
import { setRequestLocale } from "next-intl/server";
import { FirstVisitGuide } from "@/components/guide/FirstVisitGuide";
import { Board } from "@/components/home/Board";
import { FilmGate } from "@/components/home/FilmGate";
import { firstScreenData } from "@/components/home/read";
import { StoryStage } from "@/components/story/StoryStage";
import { heldStory } from "@/components/story/data";

// Read on the request, so the counts on the closing card and the first
// screen's finding are today's, the same reads the home page makes.
export const dynamic = "force-dynamic";

/**
 * The home page with the film told as a chapter: the real first screen, then
 * the film opening on a chapter title and ending on the page's one final call.
 * It is here for Ram to look at before it replaces the film on the home page.
 * Nothing outside the lab index links here and the flag that opens it is only
 * set on this machine, so the route is a 404 everywhere else.
 */
export default async function HomeChapterLabPage({ params }: { params: Promise<{ locale: string }> }) {
  if (process.env.NEXT_PUBLIC_LAB_PAGES !== "1") {
    notFound();
  }

  const { locale } = await params;
  setRequestLocale(locale);

  const [data, first] = await Promise.all([heldStory(), firstScreenData()]);

  return (
    <>
      <Board finding={first.finding} copy={first.copy} samples={first.samples} loose={first.loose} />
      <FilmGate>
        <StoryStage data={data} variant="chapter" />
      </FilmGate>
      <FirstVisitGuide />
    </>
  );
}
