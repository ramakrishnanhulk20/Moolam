"use client";

import { useTranslations } from "next-intl";
import type { StoryBeat } from "@/components/story/LandingStory";
import { CloseCard } from "@/components/story/CloseCard";
import { TryPanel } from "@/components/story/TryPanel";
import type { StoryData } from "@/components/story/data";
import { degradeSteps } from "@/components/hero/still";

/**
 * The same eight beats with the camera taken out.
 *
 * This is what a reader who has asked for less motion sees, and what anyone
 * whose browser cannot open a WebGL context sees. Every caption, every live
 * figure and the working drop panel are here: only the flight is missing.
 */
export function StillStory({
  data,
  beats,
  noWebgl = false,
}: {
  data: StoryData;
  beats: StoryBeat[];
  /** True only when a context could not be opened, never for reduced motion. */
  noWebgl?: boolean;
}) {
  const t = useTranslations("story");
  const steps = degradeSteps();
  const picture = data.focal?.picture ?? null;

  return (
    <div className="grain relative w-full bg-bg">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(58% 50% at 74% 20%, rgba(255,176,32,0.14), transparent 62%)," +
            "radial-gradient(48% 55% at 12% 72%, rgba(255,176,32,0.05), transparent 66%)",
        }}
      />

      <div className="relative mx-auto flex w-full max-w-[100rem] flex-col gap-24 px-5 pb-24 pt-24 sm:px-8 lg:gap-32 lg:px-14">
        {noWebgl && (
          <p className="max-w-[52ch] border-l-2 border-l-accent/60 bg-accent-soft px-4 py-3 text-sm leading-relaxed text-text-muted">
            {t("noWebgl")}
          </p>
        )}

        <section>
          <p className="flex items-center gap-3 font-mono text-[11px] uppercase tracking-[0.24em] text-accent">
            <span className="motif h-[9px] w-[9px]" />
            {t("kicker")}
          </p>
          <h1 className="mt-6 font-display text-[clamp(3rem,9vw,8rem)] font-semibold uppercase leading-[0.95] tracking-[-0.045em]">
            {t("title")}
          </h1>
          <p className="mt-6 max-w-[34ch] text-[clamp(1rem,1.5vw,1.35rem)] leading-relaxed text-text-muted">
            {t("line")}
          </p>
        </section>

        {beats.map((entry) => (
          <section key={entry.key} className={entry.align === "end" ? "text-end" : ""}>
            {entry.body}
            {entry.key === "sealed" && picture !== null && <Still src={picture} />}
            {entry.key === "shared" && <Frames />}
            {entry.key === "verified" && (
              <ul className="mt-8 max-w-[34rem] border-t border-line">
                {steps.map((step) => (
                  <li key={step.transform} className="flex items-baseline justify-between border-b border-line py-2.5">
                    <span className="font-mono text-[12px] uppercase tracking-[0.08em] text-text">{step.transform}</span>
                    <span className="font-mono text-[13px] tabular-nums text-accent">{step.confidence.toFixed(2)}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        ))}

        <section>
          <TryPanel onPreview={() => undefined} pinned={false} />
        </section>

        <section className="border-t border-line pt-16">
          <CloseCard data={data} pinned={false} />
        </section>
      </div>
    </div>
  );
}

function Still({ src }: { src: string }) {
  return (
    <div className="scrim grain relative mt-8 aspect-[4/3] w-full max-w-[34rem] overflow-hidden border border-line">
      {/* The registered image, served by the gateway its own passport points at,
          which is not a host a loader can be configured for. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={src} alt="" className="h-full w-full object-cover" />
    </div>
  );
}

/** The verifier's own crushed output, the same four files the copies carry in the scene. */
function Frames() {
  const frames = [
    { src: "/hero/frame-reencode-q60.jpg", label: "reencode-q60" },
    { src: "/hero/frame-reencode-q30.jpg", label: "reencode-q30" },
    { src: "/hero/frame-social-chain.jpg", label: "social-chain" },
    { src: "/hero/frame-resize-10.jpg", label: "resize-10" },
  ];

  return (
    <ul className="mt-8 grid grid-cols-2 gap-4 text-start lg:grid-cols-4">
      {frames.map((frame) => (
        <li key={frame.label}>
          <div className="grain relative aspect-[4/3] overflow-hidden border border-line bg-bg-sunken">
            {/* Produced by the verifier from the registered file, served from public/. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={frame.src} alt="" className="h-full w-full object-cover" />
          </div>
          <p className="mt-2 font-mono text-[11px] uppercase tracking-[0.08em] text-text-faint">{frame.label}</p>
        </li>
      ))}
    </ul>
  );
}
