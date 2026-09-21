"use client";

import { useState } from "react";
import { StoryStage } from "@/components/story/StoryStage";
import type { StoryData } from "@/components/story/data";
import type { StoryVariant } from "@/components/story/beats";
import { STATED_COPY, statedWhyNot } from "@/components/story/statedCopy";

/**
 * The film with the stated beat in it, and the film without, on one machine.
 *
 * The bench opens on the stated cut. The control swaps the whole film, which is
 * why it carries a key: the two cuts are nine and ten pages of scroll, and the
 * scroller has to be built again for the new length rather than reinterpreting
 * the old one. Nothing links to this page and it never ships, so its own words
 * are English.
 */
export function StatedBench({ data }: { data: StoryData }) {
  const [variant, setVariant] = useState<StoryVariant>("stated");
  const why = statedWhyNot(data);
  // A cut with a beat about a statement nobody wrote is not a cut of this film,
  // so the bench says why in one line and plays the film exactly as it ships.
  const playing: StoryVariant = variant === "stated" && why === null ? "stated" : "classic";

  return (
    <>
      {why !== null && (
        <p className="mx-auto w-full max-w-[100rem] px-5 pt-24 text-sm leading-relaxed text-text-muted sm:px-8 lg:px-14">
          {why}
        </p>
      )}

      <div className="-mt-[73px]">
        <StoryStage key={playing} data={data} variant={playing} />
      </div>

      {/* On a phone the control sits at the foot of the screen: the top of the
          shot is the one part of the film a bench control must not cover. */}
      <div className="fixed bottom-5 end-5 z-50 flex items-center gap-3 sm:bottom-auto sm:top-[calc(var(--header-h)+0.75rem)]">
        <span className="font-mono text-[11px] uppercase tracking-[0.18em] text-text-faint">
          {playing === "stated" ? STATED_COPY.bench.stated : STATED_COPY.bench.classic}
        </span>
        <button
          type="button"
          data-bench-cut={playing}
          onClick={() => setVariant((now) => (now === "stated" ? "classic" : "stated"))}
          className="rounded-[8px] border border-line bg-bg/80 px-4 py-2 font-mono text-[11px] uppercase tracking-[0.18em] text-text-muted backdrop-blur-sm transition-colors duration-200 hover:border-accent hover:text-accent"
        >
          {playing === "stated" ? STATED_COPY.bench.toClassic : STATED_COPY.bench.toStated}
        </button>
      </div>
    </>
  );
}
