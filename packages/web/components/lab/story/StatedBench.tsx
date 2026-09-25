"use client";

import { useState } from "react";
import { StoryStage } from "@/components/story/StoryStage";
import type { StoryData } from "@/components/story/data";
import type { StoryVariant } from "@/components/story/beats";
import { statedBlock, storyCut } from "@/components/story/stated";

/**
 * The film with the stated beat in it, and the film without, on one machine.
 *
 * The bench opens on the stated cut, which the home page's chapter cut is built on. The
 * control swaps the whole film, which is why it carries a key: the two cuts are
 * nine and ten pages of scroll, and the scroller has to be built again for the
 * new length rather than reinterpreting the old one. Nothing links to this page
 * and it never ships, so its own words are English.
 */

/** Why the beat cannot be told, in the one place that has to say it out loud. */
const WHY_NOT = {
  noPassport: "No passport could be read just now, so there is no statement to tell this beat with.",
  readFailed: "The consent register did not answer",
  silence: "Nobody has written a statement for this passport, so there is nothing to show.",
  nothingStated: "The statement on this passport speaks about none of the four uses, so there is nothing to draw.",
} as const;

const CUT = {
  stated: "Stated cut",
  classic: "Classic cut",
  toStated: "Play the stated cut",
  toClassic: "Back to the classic cut",
} as const;

export function StatedBench({ data }: { data: StoryData }) {
  const [variant, setVariant] = useState<StoryVariant>("stated");
  const block = statedBlock(data);
  const why =
    block === null
      ? null
      : `${block === "readFailed" ? `${WHY_NOT.readFailed}: ${data.statementError}.` : WHY_NOT[block]} This is the classic film.`;
  // A cut with a beat about a statement nobody wrote is not a cut of this film,
  // so the bench says why in one line and plays the film exactly as it ships.
  const playing = storyCut(variant, data);

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
          {playing === "stated" ? CUT.stated : CUT.classic}
        </span>
        <button
          type="button"
          data-bench-cut={playing}
          onClick={() => setVariant((now) => (now === "stated" ? "classic" : "stated"))}
          className="rounded-[8px] border border-line bg-bg/80 px-4 py-2 font-mono text-[11px] uppercase tracking-[0.18em] text-text-muted backdrop-blur-sm transition-colors duration-200 hover:border-accent hover:text-accent"
        >
          {playing === "stated" ? CUT.toClassic : CUT.toStated}
        </button>
      </div>
    </>
  );
}
