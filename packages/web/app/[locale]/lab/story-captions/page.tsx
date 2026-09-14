import { notFound } from "next/navigation";
import { setRequestLocale } from "next-intl/server";
import { CaptionBench } from "@/components/story/CaptionBench";
import { storyData } from "@/components/story/data";

// The bench reads the same live record the film does, so the plates drifting
// under the words are the pictures the story actually flies through.
export const dynamic = "force-dynamic";

/**
 * The caption bench. The current treatment and two candidates, on the real
 * plates and the real beats, each on the film's dark ground and on the light
 * theme. Nothing links here and the flag that opens it is only set on this
 * machine, so the route is a 404 everywhere else.
 */
export default async function CaptionLabPage({ params }: { params: Promise<{ locale: string }> }) {
  if (process.env.NEXT_PUBLIC_LAB_PAGES !== "1") {
    notFound();
  }

  const { locale } = await params;
  setRequestLocale(locale);

  const data = await storyData();

  return <CaptionBench data={data} />;
}
