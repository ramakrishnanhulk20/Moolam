"use client";

import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { Picture } from "@/components/passport/Picture";
import { pictureSources } from "@/lib/images";
import { ChapterOpening } from "@/components/story/ChapterOpening";
import { CloseCard } from "@/components/story/CloseCard";
import { TryPanel, type TrySample } from "@/components/story/TryPanel";
import type { StoryData } from "@/components/story/data";
import { bitsApart, degradeSteps, type DegradeStep } from "@/components/story/measurements";
import type { BeatTable } from "@/components/story/beats";
import type { StoryBeat } from "@/components/story/words";
import { shortHex } from "@/lib/chain/client";

/**
 * The same beats with the camera taken out.
 *
 * This is what a reader who has asked for less motion sees, and what anyone
 * whose browser cannot open a WebGL context sees. Every caption, every live
 * figure and the working drop panel are here, each beat drawn finished: the
 * stamp down, the copy home, the mark on. Only the flight is missing. It plays
 * in whichever room the page is in: paper prints on Linen, or the film's glass
 * on black.
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
  const marks = useTranslations("mark.states");
  const steps = degradeSteps();
  const said = useCopyWords();
  const picture = data.focal?.picture ?? null;
  const lookalike = data.lookalike ?? null;
  const yourself = data.yourself ?? null;

  return (
    <div data-film-room className="grain relative w-full overflow-x-clip bg-bg" data-film="still">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(58% 50% at 74% 20%, color-mix(in srgb, var(--accent) 12%, transparent), transparent 62%)," +
            "radial-gradient(48% 55% at 12% 72%, color-mix(in srgb, var(--accent) 5%, transparent), transparent 66%)",
        }}
      />

      <div className="relative mx-auto flex w-full max-w-[100rem] flex-col gap-24 px-5 pb-24 pt-24 sm:px-8 lg:gap-32 lg:px-14">
        {noWebgl && (
          <p className="max-w-[52ch] border-l-2 border-l-accent/60 bg-accent-soft px-4 py-3 text-base leading-relaxed text-text-muted">
            {t("noWebgl")}
          </p>
        )}

        <section data-still-beat="opening">
          <ChapterOpening arrived />
        </section>

        {beats.map((entry) => (
          <section
            key={entry.key}
            data-still-beat={entry.key}
            className={table.beat[entry.key]?.align === "end" ? "text-end" : ""}
          >
            {entry.body}
            {entry.key === "imagined" && picture !== null && <Print src={picture} />}
            {entry.key === "sealed" && picture !== null && (
              <Print src={picture}>
                <span aria-hidden className="absolute bottom-[4%] right-[4%] block aspect-square w-[24%]">
                  <span className="absolute -inset-[30%] rounded-full bg-[radial-gradient(circle,color-mix(in_srgb,var(--accent)_22%,transparent),transparent_62%)]" />
                  <KolamSeal className="absolute inset-0 -rotate-[9deg]" />
                </span>
              </Print>
            )}
            {entry.key === "shared" && <Frames steps={steps} />}
            {entry.key === "verified" && (
              <>
                <ul data-still-ladder className="mt-8 max-w-[34rem] border-t border-line text-start">
                  {steps.map((step) => (
                    <li
                      key={step.transform}
                      className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 border-b border-line py-2.5"
                    >
                      <span className="text-sm text-text">{said.name(step.transform)}</span>
                      <span className="font-mono text-[12px] tabular-nums text-verified">{said.distance(step)}</span>
                    </li>
                  ))}
                </ul>
                {picture !== null && <Print src={picture} matched />}
              </>
            )}
            {entry.key === "checked" && picture !== null && (
              <Print src={picture} matched={data.check?.form === "network"}>
                {data.check?.form === "network" ? (
                  <span aria-hidden className="absolute bottom-[6%] left-[5%] -rotate-[3deg]">
                    <Tag word={t("checked.mark")} tone="text-verified border-verified" glyph="check" />
                  </span>
                ) : null}
              </Print>
            )}
            {entry.key === "lookalike" && lookalike !== null && (
              <div className="mt-8 grid max-w-[44rem] grid-cols-2 gap-5 text-start sm:gap-8">
                <Print src={lookalike.earlier.picture} bare>
                  <span aria-hidden className="absolute bottom-[5%] right-[5%] block aspect-square w-[28%]">
                    <KolamSeal className="absolute inset-0 -rotate-[9deg]" />
                  </span>
                </Print>
                <Print src={lookalike.later.picture} bare>
                  <span aria-hidden className="absolute right-[4%] top-[6%] -rotate-[5deg]">
                    <Tag word={marks("lookalike.word")} tone="text-lookalike border-lookalike" glyph="twin" />
                  </span>
                </Print>
              </div>
            )}
            {entry.key === "yourself" && yourself !== null && (
              <Print src={yourself.print.picture}>
                <span className="absolute inset-x-0 -bottom-9 block text-center font-mono text-[13px] tracking-[0.06em] text-accent">
                  {t("yourself.tag", { person: shortHex(yourself.print.creator, 6, 4) })}
                </span>
              </Print>
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

/** The kolam stamp as the page draws it: the site's knot inside a rubber stamp's double ring. */
function KolamSeal({ className = "" }: { className?: string }) {
  return (
    <span data-kolam-seal aria-hidden className={`pointer-events-none block text-accent ${className}`}>
      <svg viewBox="0 0 200 200" className="absolute inset-0 h-full w-full">
        <circle cx="100" cy="100" r="91" fill="none" stroke="currentColor" strokeWidth="5.6" />
        <circle cx="100" cy="100" r="79" fill="none" stroke="currentColor" strokeWidth="2" />
      </svg>
      <span className="absolute left-1/2 top-1/2 flex h-[60%] w-[60%] -translate-x-1/2 -translate-y-1/2">
        <span className="motif h-full w-full bg-accent" />
      </span>
    </span>
  );
}

/** A stamped word tag, the page's drawing of the scene's marks. */
function Tag({ word, tone, glyph }: { word: string; tone: string; glyph: "twin" | "check" }) {
  return (
    <span
      className={`inline-flex max-w-[16rem] items-center gap-2 rounded-[6px] border-[2.5px] bg-bg/85 px-2.5 py-1.5 font-mono text-[11px] font-bold uppercase leading-tight tracking-[0.1em] ${tone}`}
    >
      <svg viewBox="0 0 28 22" className="h-[1.2em] w-[1.5em] shrink-0" aria-hidden>
        {glyph === "twin" ? (
          <>
            <rect x="1.5" y="1.5" width="16" height="12" fill="none" stroke="currentColor" strokeWidth="2.2" />
            <rect x="9" y="8" width="17" height="12.5" fill="currentColor" />
          </>
        ) : (
          <path d="M4 12 L11 18 L24 4" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
        )}
      </svg>
      {word}
    </span>
  );
}

/**
 * One print: in light the picture on a paper border with a soft shadow, in
 * dark the film's glass with its faint pink edge. A matched print wears the
 * match colour round it, as the film's does once the copy is home.
 */
function Print({
  src,
  matched = false,
  bare = false,
  children,
}: {
  src: string;
  matched?: boolean;
  /** True inside a row of its own, where the print fills its cell rather than the column. */
  bare?: boolean;
  children?: ReactNode;
}) {
  return (
    <div
      data-still-print={matched ? "matched" : "plain"}
      className={`relative ${bare ? "" : "mt-8 w-full max-w-[34rem] [.text-end_&]:ms-auto"} ${
        matched
          ? "outline outline-[3px] outline-verified [html.dark_&]:outline-[1.5px]"
          : ""
      } bg-[#f1ece3] p-[3.5%] shadow-[0_22px_44px_-20px_rgb(58_51_38/0.55),0_2px_6px_rgb(58_51_38/0.16)] [html.dark_&]:bg-transparent [html.dark_&]:p-0 [html.dark_&]:shadow-[0_0_0_1px_rgb(255_183_197/0.34),0_0_38px_-8px_rgb(255_183_197/0.3)]`}
    >
      <div className="grain relative aspect-[4/3] w-full overflow-hidden bg-bg-sunken">
        {/* The registered image, read through the optimizer: the gateway serves
            this file once and every later view of the story is free. */}
        <Picture sources={pictureSources(src)} sizes="(min-width: 768px) 34rem, 100vw" className="object-cover" />
      </div>
      {children}
    </div>
  );
}

/**
 * The film's own words for each copy on the ladder, and its measure of it in
 * bits apart, so this page reads as the film does rather than printing the
 * verifier's file names (reencode-q30 and the rest) in every language.
 */
export function useCopyWords() {
  const t = useTranslations("story.verified");
  return {
    name: (transform: string) => (t.has(`copies.${transform}`) ? t(`copies.${transform}`) : transform),
    distance: (step: Pick<DegradeStep, "phashDistance">) =>
      t("similarity", {
        value: bitsApart(step),
        result: t("match"),
      }),
  };
}

/** The verifier's own crushed output, the same four files the copies carry in the scene. */
function Frames({ steps }: { steps: DegradeStep[] }) {
  const said = useCopyWords();
  const frames = [
    { src: "/hero/frame-reencode-q60.jpg", transform: "reencode-q60" },
    { src: "/hero/frame-reencode-q30.jpg", transform: "reencode-q30" },
    { src: "/hero/frame-social-chain.jpg", transform: "social-chain" },
    { src: "/hero/frame-resize-10.jpg", transform: "resize-10" },
  ];

  return (
    <ul data-still-frames className="mt-8 grid grid-cols-2 gap-4 text-start lg:grid-cols-4">
      {frames.map((frame) => {
        const step = steps.find((entry) => entry.transform === frame.transform);
        return (
          <li key={frame.transform}>
            <div className="grain relative aspect-[4/3] overflow-hidden border border-line bg-bg-sunken">
              {/* Produced by the verifier from the registered file, served from public/. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={frame.src} alt="" className="h-full w-full object-cover" />
            </div>
            <p className="mt-2 text-sm leading-snug text-text-muted">{said.name(frame.transform)}</p>
            {step === undefined ? null : (
              <p className="mt-1 font-mono text-[11px] tabular-nums text-verified">{said.distance(step)}</p>
            )}
          </li>
        );
      })}
    </ul>
  );
}
