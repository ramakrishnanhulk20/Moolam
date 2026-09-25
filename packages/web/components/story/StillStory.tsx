"use client";

import { useTranslations } from "next-intl";
import { useEffect, useRef, type ReactNode } from "react";
import type { StoryBeat } from "@/components/story/LandingStory";
import { Picture } from "@/components/passport/Picture";
import { pictureSources } from "@/lib/images";
import { ChapterOpening } from "@/components/story/ChapterOpening";
import { CloseCard } from "@/components/story/CloseCard";
import { TryPanel, type TrySample } from "@/components/story/TryPanel";
import { progress } from "@/components/story/signals";
import type { StoryData } from "@/components/story/data";
import { ACCENT_RGB } from "@/components/story/palette";
import { degradeSteps } from "@/components/story/measurements";
import type { BeatTable } from "@/components/story/beats";

/**
 * The same eight beats with the camera taken out.
 *
 * This is what a reader who has asked for less motion sees, and what anyone
 * whose browser cannot open a WebGL context sees. Every caption, every live
 * figure and the working drop panel are here: only the flight is missing.
 * It opens on the same chapter title the film does and ends on the page's one
 * final call.
 */
export function StillStory({
  data,
  table,
  beats,
  samples = [],
  noWebgl = false,
}: {
  data: StoryData;
  /** The cut being told, which is where each chapter's side comes from. */
  table: BeatTable;
  beats: StoryBeat[];
  samples?: TrySample[];
  /** True only when a context could not be opened, never for reduced motion. */
  noWebgl?: boolean;
}) {
  const t = useTranslations("story");
  const steps = degradeSteps();
  const picture = data.focal?.picture ?? null;

  return (
    <div className="grain relative w-full bg-bg" data-story="still">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            `radial-gradient(58% 50% at 74% 20%, rgba(${ACCENT_RGB}, 0.14), transparent 62%),` +
            `radial-gradient(48% 55% at 12% 72%, rgba(${ACCENT_RGB}, 0.05), transparent 66%)`,
        }}
      />

      <div className="relative mx-auto flex w-full max-w-[100rem] flex-col gap-24 px-5 pb-24 pt-24 sm:px-8 lg:gap-32 lg:px-14">
        {noWebgl && (
          <p className="max-w-[52ch] border-l-2 border-l-accent/60 bg-accent-soft px-4 py-3 text-sm leading-relaxed text-text-muted">
            {t("noWebgl")}
          </p>
        )}

        <section>
          <ChapterOpening arrived />
        </section>

        {beats.map((entry) => (
          <section key={entry.key} className={table.beat[entry.key]?.align === "end" ? "text-end" : ""}>
            {entry.key === "verified" ? <LadderDriver>{entry.body}</LadderDriver> : entry.body}
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
          <TryPanel onPreview={() => undefined} samples={samples} pinned={false} />
        </section>

        <section className="border-t border-line pt-16">
          <CloseCard data={data} pinned={false} />
        </section>
      </div>
    </div>
  );
}

/**
 * Runs the verified beat's readout off this page's own scroll.
 *
 * On the film the scene writes how far the verified beat has played from inside
 * its render loop. There is no scene here, so the readout would sit frozen on
 * whatever number it was swapped at. This publishes the same signal from the
 * section's way up the window, so the ladder ticks through the verifier's
 * figures as the reader passes it, on this page as on the other.
 */
function LadderDriver({ children }: { children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const node = box.current;
    if (node === null) {
      return;
    }

    const read = () => {
      const rect = node.getBoundingClientRect();
      const travel = window.innerHeight + rect.height;
      progress.verified = travel <= 0 ? 0 : Math.min(1, Math.max(0, (window.innerHeight - rect.top) / travel));
    };

    read();
    window.addEventListener("scroll", read, { passive: true });
    window.addEventListener("resize", read);
    return () => {
      window.removeEventListener("scroll", read);
      window.removeEventListener("resize", read);
    };
  }, []);

  return <div ref={box}>{children}</div>;
}

function Still({ src }: { src: string }) {
  return (
    <div className="scrim grain relative mt-8 aspect-[4/3] w-full max-w-[34rem] overflow-hidden border border-line">
      {/* The registered image, read through the optimizer: the gateway serves
          this file once and every later view of the story is free. */}
      <Picture sources={pictureSources(src)} sizes="(min-width: 768px) 34rem, 100vw" className="object-cover" />
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
