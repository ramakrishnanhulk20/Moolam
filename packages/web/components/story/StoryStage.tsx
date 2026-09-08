"use client";

import dynamic from "next/dynamic";
import type { StoryData } from "@/components/story/data";

/**
 * The story is browser only.
 *
 * It asks the browser for a WebGL context before it decides what to render, so
 * there is nothing sensible for a server render to produce and nothing for
 * React to hydrate against. Loading it this way means the two answers never
 * disagree.
 */
const LandingStory = dynamic(() => import("@/components/story/LandingStory").then((module) => module.LandingStory), {
  ssr: false,
  loading: () => <div className="h-[100svh] w-full bg-bg" />,
});

export function StoryStage({ data }: { data: StoryData }) {
  return (
    <div className="story" data-motif="seal">
      <LandingStory data={data} />
    </div>
  );
}
