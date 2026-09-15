"use client";

import { motion, useReducedMotion } from "framer-motion";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { Body, Eyebrow, Title } from "@/components/story/LandingStory";
import { Picture } from "@/components/passport/Picture";
import { pictureSources } from "@/lib/images";
import type { StoryData } from "@/components/story/data";

type Treatment = "current" | "scrim" | "plate";

const TREATMENTS: { id: Treatment; index: string; name: string; idea: string }[] = [
  {
    id: "current",
    index: "00",
    name: "Current",
    idea: "The words sit straight on the shot. When a plate drifts under them the last word of the kicker goes, the Verified label loses its ground, and the picture shows through the score card.",
  },
  {
    id: "scrim",
    index: "01",
    name: "Scrim",
    idea: "A soft dark pool behind the block that fades to nothing at its edges. No edge, no box: the shot is still one picture and the words always have something under them.",
  },
  {
    id: "plate",
    index: "02",
    name: "Plate",
    idea: "The words on a translucent card with the pink rule the site already uses. The hardest edge of the three and the most certain to read, at the cost of a box on the film.",
  },
];

/**
 * The caption treatments, side by side on the real plates and the real beats.
 *
 * Nothing links to this page and it never ships. The labels are English on
 * purpose, the same as the logo bench: this is a surface for Ram to pick on,
 * not a page anyone lands on.
 */
export function CaptionBench({ data }: { data: StoryData }) {
  const [drifting, setDrifting] = useState(true);
  const pictures = [...new Set(data.plates.map((plate) => plate.picture))].slice(0, 3);
  const focal = data.focal?.picture ?? pictures[0] ?? null;

  return (
    <div className="min-h-screen bg-bg px-5 pb-24 pt-24 sm:px-8 lg:px-14">
      <header className="mx-auto w-full max-w-[100rem]">
        <p className="flex items-center gap-3 font-mono text-[11px] uppercase tracking-[0.24em] text-accent">
          <span className="motif h-[9px] w-[9px]" />
          Caption bench
        </p>
        <h1 className="mt-6 max-w-[18ch] font-display text-[clamp(2.4rem,7vw,5rem)] font-semibold uppercase leading-[0.92] tracking-[-0.045em]">
          How the words hold when a plate slides under them
        </h1>
        <p className="mt-6 max-w-[62ch] text-base leading-relaxed text-text-muted">
          Three treatments on the film&apos;s own beats, with real registered pictures drifting behind them. Each pair is
          the same treatment on the film&apos;s dark ground and on the light theme the closing card hands the page back
          to. Pick one and it goes into the story.
        </p>
        <button
          type="button"
          onClick={() => setDrifting((on) => !on)}
          className="mt-7 rounded-[8px] border border-line px-5 py-3 font-mono text-[11px] uppercase tracking-[0.18em] text-text-muted transition-colors duration-200 hover:border-accent hover:text-accent"
        >
          {drifting ? "Park the plates under the words" : "Let the plates drift"}
        </button>
      </header>

      <div className="mx-auto mt-20 flex w-full max-w-[100rem] flex-col gap-24">
        {TREATMENTS.map((treatment) => (
          <section key={treatment.id}>
            <div className="flex flex-col gap-3 border-t border-line pt-5 sm:flex-row sm:items-baseline sm:gap-6">
              <p className="font-mono text-[11px] uppercase tracking-[0.24em] text-accent">{treatment.index}</p>
              <h2 className="font-display text-[clamp(1.8rem,3.4vw,2.8rem)] font-semibold leading-[1] tracking-[-0.04em]">
                {treatment.name}
              </h2>
              <p className="max-w-[58ch] text-sm leading-relaxed text-text-muted sm:ms-auto">{treatment.idea}</p>
            </div>

            {/* One frame per row, the width of the page: the caption type is sized
                off the window, so a half-width pane would show the words at twice
                the scale they have on the film and prove nothing. */}
            <div className="mt-8 flex flex-col gap-6">
              {(["dark", "light"] as const).map((surface) => (
                <figure key={surface}>
                  <Pane
                    treatment={treatment.id}
                    surface={surface}
                    pictures={pictures}
                    focal={focal}
                    drifting={drifting}
                    data={data}
                  />
                  <figcaption className="mt-3 font-mono text-[11px] uppercase tracking-[0.16em] text-text-faint">
                    {treatment.name} / {surface === "dark" ? "film ground" : "light theme"}
                  </figcaption>
                </figure>
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

/**
 * One treatment on one ground.
 *
 * The plates behind the words are real registered pictures off the index, and
 * the drift is what puts one of them under the caption at the worst moment,
 * which is the whole reason this bench exists.
 */
function Pane({
  treatment,
  surface,
  pictures,
  focal,
  drifting,
  data,
}: {
  treatment: Treatment;
  surface: "dark" | "light";
  pictures: string[];
  focal: string | null;
  drifting: boolean;
  data: StoryData;
}) {
  const reduced = useReducedMotion();
  const moving = drifting && reduced !== true;

  return (
    <div
      // Each pane carries its own palette, so the pair reads as a pair whichever
      // way the site's own toggle is set while Ram is looking at it.
      className={`grain relative isolate h-[34rem] overflow-hidden border border-line sm:h-[32rem] lg:h-[38.75rem] ${
        surface === "light" ? "light bg-bg text-text" : "dark text-text"
      }`}
      style={surface === "dark" ? { background: "#0B0B0C" } : undefined}
    >
      <Plates pictures={pictures} focal={focal} moving={moving} surface={surface} />

      {/* The film's own side scrim, so the bench is judging the treatment and not
          the absence of the gradient the real shot already has. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 z-10"
        style={{
          background:
            surface === "dark"
              ? "linear-gradient(90deg, rgba(11,11,12,0.72) 0%, rgba(11,11,12,0.1) 26%, rgba(11,11,12,0) 46%)"
              : "linear-gradient(90deg, rgba(242,239,233,0.72) 0%, rgba(242,239,233,0.1) 26%, rgba(242,239,233,0) 46%)",
        }}
      />

      <div className="absolute inset-0 z-20 flex items-center px-6 py-8 sm:px-8">
        <Caption treatment={treatment} data={data} />
      </div>
    </div>
  );
}

/** Real registered pictures, drifting across the words the way the field does. */
function Plates({
  pictures,
  focal,
  moving,
  surface,
}: {
  pictures: string[];
  focal: string | null;
  moving: boolean;
  surface: "dark" | "light";
}) {
  const shown = pictures.length === 0 && focal !== null ? [focal] : pictures;

  return (
    <div aria-hidden className="absolute inset-0">
      {shown.map((picture, index) => {
        const lane = index % 3;
        const top = ["8%", "33%", "58%"][lane];
        const size = [190, 250, 160][lane];
        // Pixels, not percentages: a percentage here would be of the plate
        // rather than of the pane, and the plate would never cross the words.
        const parked = [40, 90, 150][lane];

        return (
          <motion.div
            key={`${picture}-${index}`}
            className="absolute start-0"
            style={{ top, width: size, height: size * 0.72 }}
            initial={{ x: -280 }}
            animate={moving ? { x: [-280, 720] } : { x: parked }}
            transition={
              moving
                ? { duration: 17 + index * 4, repeat: Infinity, repeatType: "loop", ease: "linear", delay: index * 2.2 }
                : { duration: 0.8, ease: [0.16, 1, 0.3, 1] }
            }
          >
            <div
              className="relative h-full w-full overflow-hidden border"
              style={{
                borderColor: surface === "dark" ? "rgb(255 255 255 / 0.14)" : "rgb(11 11 12 / 0.12)",
                boxShadow: surface === "dark" ? "0 24px 60px rgb(0 0 0 / 0.45)" : "0 24px 60px rgb(11 11 12 / 0.18)",
              }}
            >
              {/* Registered images, read through the optimizer rather than
                  from the gateway on every view. */}
              <Picture sources={pictureSources(picture)} sizes="256px" className="object-cover" />
            </div>
          </motion.div>
        );
      })}
    </div>
  );
}

/**
 * The three places the words break today, in one block: the kicker whose last
 * word a plate eats, the Verified label with nothing under it, and the score
 * card a picture shows straight through.
 */
function Caption({ treatment, data }: { treatment: Treatment; data: StoryData }) {
  const t = useTranslations("story");
  const agentId = data.focal === null ? (data.agent?.id ?? null) : data.focal.agentId;
  const block = data.focal?.block ?? "";

  const words = (
    <>
      <Eyebrow>{t("kicker")}</Eyebrow>
      <Title className="max-w-[13ch]">{t("verified.title")}</Title>
      <Body className="max-w-[32ch]">{block === "" ? t("sealed.bodyNoBlock") : t("sealed.body", { block })}</Body>
      <div className="mt-6">
        <Eyebrow>{t("verified.kicker")}</Eyebrow>
      </div>
      <Score treatment={treatment} agentId={agentId} data={data} />
    </>
  );

  if (treatment === "plate") {
    return (
      <div className="relative w-full max-w-[27rem] border border-line border-l-2 border-l-accent bg-bg/80 p-5 backdrop-blur-md sm:p-6">
        {words}
      </div>
    );
  }

  if (treatment === "scrim") {
    return (
      <div className="relative w-full max-w-[27rem]">
        <div
          aria-hidden
          className="pointer-events-none absolute -inset-x-10 -inset-y-12"
          style={{
            background:
              "radial-gradient(72% 64% at 34% 50%, var(--scrim-from) 0%, var(--scrim-to) 76%)",
          }}
        />
        <div className="relative">{words}</div>
      </div>
    );
  }

  return <div className="relative w-full max-w-[27rem]">{words}</div>;
}

/** The trusted beat's standing card, the one a plate currently bleeds through. */
function Score({ treatment, agentId, data }: { treatment: Treatment; agentId: string | null; data: StoryData }) {
  const t = useTranslations("story");
  if (agentId === null) {
    return null;
  }

  return (
    <div
      className={`mt-6 w-full max-w-[22rem] border border-line p-4 ${
        treatment === "plate" ? "bg-transparent" : "bg-text/[0.04] backdrop-blur-sm"
      }`}
    >
      <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-accent">{t("trusted.agent", { agent: agentId })}</p>
      <p className="mt-2 font-display text-[clamp(1.8rem,3.4vw,2.6rem)] font-semibold leading-[0.95] tracking-[-0.04em] tabular-nums">
        {data.agent === null || data.agent.score === null ? t("trusted.noScore") : t("trusted.score", { score: data.agent.score })}
      </p>
      <p className="mt-2 font-mono text-[11px] uppercase tracking-[0.14em] text-text-faint">
        {t("trusted.counts", { rechecks: data.agent?.rechecks ?? 0, passports: data.agent?.passports ?? 0 })}
      </p>
    </div>
  );
}
