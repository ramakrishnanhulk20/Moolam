"use client";

import { useTranslations } from "next-intl";
import { useRef, useState } from "react";
import { DotField } from "@/components/motion/DotField";
import { Eyebrow, Motif } from "@/components/hero/Motif";
import type { DegradeStep } from "@/components/hero/still";
import { useIsReducedMotion } from "@/components/motion/useIsReducedMotion";
import { useScrubProgress } from "@/components/motion/useScrubProgress";
import { shortHex } from "@/lib/chain/client";

interface DegradeSequenceProps {
  steps: DegradeStep[];
  /** The registered image, live from the gateway the passport points at. */
  stillUrl: string | null;
  passportId: string;
  imageCid: string;
  /** Already formatted on the server so both languages read the same date. */
  measuredOn: string;
  exactConfidence: number;
}

/**
 * How a turned or flipped frame is placed so it still fits its box. A quarter
 * turn inside a landscape frame has to come down in size or it runs off both
 * ends.
 */
const ORIENTATION: Record<string, string> = {
  "rotate-90": "rotate(90deg) scale(0.72)",
  mirror: "scaleX(-1)",
};

/**
 * The signature moment: one registered image, crushed step by step, with the
 * verifier's own match figure beside it.
 *
 * Two things drive the section and they run at different speeds. Scroll position
 * goes onto the node as a custom property every frame, which the scan line and
 * the travel rail read through calc(), so nothing re-renders while you scroll.
 * Which step is current is a small whole number, so that one is React state with
 * a guard, and the frame swaps and the turn animate as CSS transitions.
 *
 * Every figure on screen was measured by posting the real transform to the
 * running verifier. Nothing is computed in the browser.
 */
export function DegradeSequence({
  steps,
  stillUrl,
  passportId,
  imageCid,
  measuredOn,
  exactConfidence,
}: DegradeSequenceProps) {
  const section = useRef<HTMLElement>(null);
  const [state, setState] = useState(0);
  const reduced = useIsReducedMotion();
  const t = useTranslations("hero.degrade");

  // State 0 is the file exactly as it was registered; the rest are the steps.
  const states = steps.length + 1;

  useScrubProgress(section, "--crush", { states, onState: setState });

  const step = state === 0 ? null : steps[state - 1];
  const confidence = step === null ? exactConfidence : step.confidence;
  const orientation = step === null ? "none" : (ORIENTATION[step.transform] ?? "none");

  const rows = [
    { key: "as-registered", label: t("asRegistered"), confidence: exactConfidence, detail: t("exactBytes") },
    ...steps.map((entry) => ({
      key: entry.transform,
      label: entry.transform,
      confidence: entry.confidence,
      detail: t("distance", { phash: entry.phashDistance ?? 0, blockhash: entry.blockhashDistance ?? 0 }),
    })),
  ];

  if (reduced) {
    return (
      <section className="border-t border-line bg-bg-sunken">
        <div className="mx-auto w-full max-w-[100rem] px-5 py-24 sm:px-8 lg:px-14">
          <Eyebrow>{t("kicker")}</Eyebrow>
          <h2 className="mt-6 max-w-[18ch] font-display text-[clamp(2.25rem,6vw,5rem)] font-bold leading-[1.02] tracking-[-0.03em]">
            {t("heading")}
          </h2>
          <ul className="mt-12 grid gap-6 sm:grid-cols-3">
            {[{ frame: stillUrl, label: t("asRegistered"), confidence: exactConfidence }, ...strip(steps)].map(
              (frame) => (
                <li key={frame.label}>
                  <div className="grain relative aspect-[4/3] overflow-hidden border border-line bg-bg">
                    {frame.frame === null ? null : (
                      // The registered file comes from an IPFS gateway chosen
                      // by the passport, not a host next/image can be told about.
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={frame.frame} alt="" className="h-full w-full object-cover" />
                    )}
                  </div>
                  <p className="mt-3 font-mono text-[11px] uppercase tracking-[0.05em] text-text-faint">
                    {frame.label}
                  </p>
                  <p className="font-mono text-lg text-accent">{format(frame.confidence)}</p>
                </li>
              ),
            )}
          </ul>
          <p className="mt-10 max-w-[62ch] text-sm text-text-muted">
            {t("provenance", { date: measuredOn, passport: shortHex(passportId, 10, 8) })}
          </p>
        </div>
      </section>
    );
  }

  return (
    <>
    <section ref={section} className="relative h-[280vh] border-t border-line bg-bg-sunken">
      {/* The header is sticky, so on the narrow widths where the content fills
          the frame it has to start below it or the heading loses its top. */}
      <div className="sticky top-0 flex h-[100svh] items-center overflow-hidden pt-[var(--chrome,5rem)] lg:pt-0">
        <DotField className="opacity-70" />

        <div className="relative mx-auto grid w-full max-w-[100rem] gap-x-12 gap-y-10 px-5 sm:px-8 lg:grid-cols-12 lg:items-center lg:px-14">
          <div className="lg:col-span-5">
            <Eyebrow>{t("kicker")}</Eyebrow>
            <h2 className="mt-5 max-w-[15ch] font-display text-[clamp(2rem,4.4vw,3.6rem)] font-bold leading-[1.02] tracking-[-0.03em]">
              {t("heading")}
            </h2>

            {/* The full ladder needs room the short side of a phone does not
                have, and the seal readout already names the current step. */}
            <ol className="mt-8 hidden space-y-0.5 lg:block">
              {rows.map((row, index) => {
                const active = index === state;
                return (
                  <li
                    key={row.key}
                    className="flex items-baseline gap-3 border-l-2 py-1.5 pl-3 transition-colors duration-300"
                    style={{
                      borderColor: active ? "var(--accent)" : "transparent",
                      opacity: active ? 1 : 0.34,
                    }}
                  >
                    <span className="w-[13ch] font-mono text-[12px] uppercase tracking-[0.05em] text-text">
                      {row.label}
                    </span>
                    <span className="font-mono text-[12px] text-accent">{format(row.confidence)}</span>
                    <span className="hidden font-mono text-[11px] text-text-faint sm:inline">{row.detail}</span>
                  </li>
                );
              })}
            </ol>

            <p className="mt-8 hidden max-w-[46ch] text-[13px] leading-relaxed text-text-faint lg:block">
              {t("provenance", { date: measuredOn, passport: shortHex(passportId, 10, 8) })}
            </p>
          </div>

          <div className="mt-8 lg:col-span-7 lg:mt-0 lg:-mr-[3vw]">
            {/* A size container, so the scan line below can travel the height of
                the frame with a transform instead of a per-frame layout. */}
            <div className="relative aspect-[4/3] w-full" style={{ containerType: "size" }}>
              <div
                className="grain absolute inset-0 overflow-hidden border border-line-strong bg-bg transition-transform duration-[900ms] ease-[cubic-bezier(0.16,1,0.3,1)]"
                // A blended grain over a surface that moves with the scroll costs a
                // full repaint every frame. Plain alpha looks the same at this
                // opacity and stays on the compositor.
                style={{ transform: orientation, ["--grain-blend" as string]: "normal" }}
              >
                {stillUrl === null ? null : (
                  // Same gateway reason as the poster still above.
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={stillUrl} alt="" className="absolute inset-0 h-full w-full object-cover" />
                )}

                {steps.map((entry, index) =>
                  entry.frame === null ? null : (
                    // These frames are the verifier's own output, served from
                    // public/, so there is nothing for a loader to optimise.
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      key={entry.transform}
                      src={entry.frame}
                      alt=""
                      className="absolute inset-0 h-full w-full object-cover transition-opacity duration-[550ms] ease-out"
                      style={{ opacity: index < state ? 1 : 0, zIndex: index + 1 }}
                    />
                  ),
                )}

                <div
                  aria-hidden
                  className="absolute inset-x-0 top-0 z-20 h-px bg-accent/70"
                  style={{ transform: "translateY(calc(var(--crush, 0) * 100cqh))" }}
                />
              </div>

              <div className="pointer-events-none absolute bottom-0 left-0 z-30 flex translate-y-1/3 items-end gap-4 bg-bg/92 py-4 pr-6 sm:pl-6">
                <span className="relative flex h-12 w-12 items-center justify-center border border-accent sm:h-14 sm:w-14">
                  <Motif size={20} />
                  <span
                    aria-hidden
                    className="absolute inset-0 animate-pulse border border-accent/40"
                    style={{ animationDuration: "2.6s" }}
                  />
                </span>
                <span>
                  <span className="block font-mono text-[11px] uppercase tracking-[0.05em] text-text-faint">
                    {step === null ? t("asRegistered") : step.transform}
                  </span>
                  <span className="block font-display text-[clamp(2.5rem,6vw,4.5rem)] font-bold leading-[0.9] tracking-[-0.045em] text-accent">
                    {format(confidence)}
                  </span>
                </span>
                <span className="hidden pb-2 font-mono text-[11px] uppercase tracking-[0.05em] text-text-faint sm:block">
                  {t("match")}
                </span>
              </div>
            </div>

            <div className="mt-16 flex items-center gap-2 sm:mt-14">
              {rows.map((row, index) => (
                <span
                  key={row.key}
                  className="h-px flex-1 transition-colors duration-300"
                  style={{ background: index <= state ? "var(--accent)" : "var(--line)" }}
                />
              ))}
              <span className="ml-3 font-mono text-[11px] uppercase tracking-[0.05em] text-text-faint">
                {shortHex(imageCid, 6, 4)}
              </span>
            </div>
          </div>
        </div>
      </div>
    </section>

    {/* Where the numbers came from, for the widths that could not carry it
        inside the pinned frame. */}
    <div className="border-t border-line bg-bg-sunken px-5 py-10 sm:px-8 lg:hidden">
      <p className="max-w-[52ch] text-[13px] leading-relaxed text-text-faint">
        {t("provenance", { date: measuredOn, passport: shortHex(passportId, 10, 8) })}
      </p>
    </div>
    </>
  );
}

/** The two steps the reduced-motion strip shows beside the registered file. */
function strip(steps: DegradeStep[]) {
  return steps
    .filter((entry) => entry.frame !== null)
    .slice(-2)
    .map((entry) => ({ frame: entry.frame, label: entry.transform, confidence: entry.confidence }));
}

/** Two decimals, the way the verifier's own report writes a confidence. */
function format(confidence: number): string {
  return confidence.toFixed(2);
}
