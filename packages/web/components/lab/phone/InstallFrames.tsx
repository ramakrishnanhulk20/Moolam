"use client";

import { Reveal } from "@/components/lab/sponsors/Reveal";

/** Exactly what app/manifest.ts says, read on the request and handed down. */
export interface InstallShape {
  name: string;
  shortName: string;
  description: string;
  startUrl: string;
  display: string;
  themeColor: string;
  backgroundColor: string;
  /** The icon the manifest lists first, which is the one Android draws. */
  icon: string;
}

/**
 * What keeping Moolam on a home screen looks like, drawn from the manifest's
 * own values rather than from a designer's guess.
 *
 * Two still frames: the tile and its word on an Android home screen, and the
 * first second of a standalone launch, which is the manifest's background
 * colour with the icon on it and no browser bar anywhere. If the tab bar ships,
 * this is the screen it is really competing with, because an installed site
 * that still looks like a web page is the one nobody opens twice.
 */
export function InstallFrames({ install }: { install: InstallShape }) {
  return (
    <section className="mt-28">
      <Reveal>
        <p className="flex items-center gap-3 font-mono text-[11px] uppercase tracking-[0.24em] text-accent">
          <span className="motif h-[9px] w-[9px]" />
          Kept on a home screen
        </p>
      </Reveal>

      <Reveal delay={0.08}>
        <h2 className="mt-6 max-w-[18ch] font-display text-[clamp(2rem,5vw,3.6rem)] font-semibold uppercase leading-[0.9] tracking-[-0.04em]">
          The install shape
        </h2>
      </Reveal>

      <Reveal delay={0.14}>
        <p className="mt-6 max-w-[58ch] text-base leading-relaxed text-text-muted">
          Both frames are app/manifest.ts, read while this page rendered: {install.display} display, the ground{" "}
          {install.backgroundColor}, opening at {install.startUrl}.
        </p>
      </Reveal>

      <div className="mt-12 flex flex-wrap items-start gap-x-16 gap-y-12">
        <Reveal>
          <figure>
            <div
              className="relative flex h-[280px] w-[200px] flex-col items-center justify-start overflow-hidden border border-line-strong px-5 pt-10"
              style={{
                background: `radial-gradient(120% 90% at 50% 0%, ${install.themeColor}, #05050a 70%)`,
              }}
            >
              <div
                className="flex h-16 w-16 items-center justify-center rounded-[16px] border border-white/10"
                style={{ background: install.backgroundColor }}
              >
                {/* The icon route itself, drawn at any size, so the tile is
                    the real mark rather than a picture of one. */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={install.icon} alt="" width={40} height={40} />
              </div>
              <p className="mt-3 max-w-[12ch] text-center text-[12px] leading-tight text-white/90">
                {install.shortName}
              </p>
              <div className="mt-6 grid w-full grid-cols-4 gap-3 opacity-40">
                {Array.from({ length: 8 }).map((_, index) => (
                  <span key={index} className="aspect-square rounded-[10px] bg-white/20" />
                ))}
              </div>
            </div>
            <figcaption className="mt-5 max-w-[30ch] text-sm leading-relaxed text-text-muted">
              The tile and its word on an Android home screen. short_name is {install.shortName}, which is what fits
              under an icon.
            </figcaption>
          </figure>
        </Reveal>

        <Reveal delay={0.08}>
          <figure>
            <div
              className="flex h-[280px] w-[200px] flex-col items-center justify-center border border-line-strong"
              style={{ background: install.backgroundColor }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={install.icon} alt="" width={64} height={64} />
              <p className="mt-6 max-w-[16ch] text-center font-mono text-[10px] uppercase leading-relaxed tracking-[0.2em] text-white/70">
                {install.name}
              </p>
            </div>
            <figcaption className="mt-5 max-w-[30ch] text-sm leading-relaxed text-text-muted">
              The launch: no browser bar, no address, the manifest ground under it. The tab bar is the only navigation
              this screen has, which is the argument for drawing one.
            </figcaption>
          </figure>
        </Reveal>
      </div>
    </section>
  );
}
