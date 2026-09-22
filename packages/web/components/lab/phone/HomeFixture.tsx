"use client";

import { useMemo } from "react";
import { beatTable } from "@/components/story/beats";
import { StillStory } from "@/components/story/StillStory";
import type { StoryData } from "@/components/story/data";
import { pickSamples } from "@/lib/data/samples";

/**
 * The home page as the still cut of the film, which is what a reader who asks
 * for less motion is given and the only cut that can be framed at this size:
 * the flown cut pins itself to the whole window, not to a box on a bench.
 *
 * The eight captions belong to the film's own layer and are not rebuilt here.
 * What is framed is what this order is about: the first screen, the drop panel,
 * and the closing card with its two calls, all of them above the bar.
 */
export function HomeFixture({ data }: { data: StoryData }) {
  const samples = useMemo(() => pickSamples(data.plates), [data.plates]);
  const table = useMemo(() => beatTable("classic"), []);

  // The film is dark whatever the app theme says, and the closing card hands
  // the page back: both of those live on the story class, so the frame gets the
  // same wrapper the home page gets.
  return (
    <div className="story" data-motif="seal">
      <StillStory data={data} table={table} beats={[]} samples={samples} />
    </div>
  );
}
