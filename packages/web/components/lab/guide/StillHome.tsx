"use client";

import Image from "next/image";
import { motion } from "framer-motion";
import { useIsReducedMotion } from "@/components/motion/useIsReducedMotion";

/**
 * A stand-in for the home page, so the guide can be judged over the thing it
 * will actually cover.
 *
 * It is not the film. The film is a WebGL canvas that runs a camera through a
 * field of glass plates, and putting a second one on the bench would fight the
 * first for the graphics card while Ram is looking at both. This is its first
 * screen drawn flat, with the same words, the same header and a few plates that
 * keep drifting, which is all the guide needs behind it: something moving, to
 * prove the blur is doing its job.
 *
 * The header items carry the anchors the walk lights up. Those same attributes
 * go on the real header when this rolls in.
 */
export function StillHome({ width, returning }: { width: "desktop" | "phone"; returning: boolean }) {
  const reduced = useIsReducedMotion();
  const phone = width === "phone";

  const nav = [
    { label: "Home", anchor: null },
    { label: "Explore", anchor: null },
    { label: "Agents", anchor: null },
    { label: "Docs", anchor: null },
    { label: "Verify an image", anchor: "verify" },
    { label: "Register an image", anchor: "studio" },
    ...(returning ? [{ label: "My pictures", anchor: "mine" }] : []),
  ];

  return (
    <div className="absolute inset-0 overflow-hidden bg-bg text-text">
      {/* The plates, drifting. Six squares is enough to show through a blur. */}
      <div aria-hidden className="pointer-events-none absolute inset-0">
        {PLATES.map((plate, at) => (
          <motion.span
            key={plate.left}
            className="absolute border border-line-strong/60 bg-bg-raised/70"
            style={{
              left: `${plate.left}%`,
              top: `${plate.top}%`,
              width: plate.size,
              height: plate.size * 1.25,
              rotate: plate.tilt,
            }}
            animate={reduced ? undefined : { y: [0, -18, 0], opacity: [0.5, 0.85, 0.5] }}
            transition={{ duration: 9 + at * 1.7, repeat: Infinity, ease: "easeInOut" }}
          />
        ))}
      </div>

      <div className="absolute inset-0 bg-[radial-gradient(90%_70%_at_70%_20%,var(--accent-soft),transparent_60%)]" />

      <header className="relative border-b border-line bg-bg/85 backdrop-blur-md">
        <div className={`flex items-center gap-x-6 px-5 ${phone ? "h-[55px]" : "h-[63px] sm:px-8"}`}>
          <span className="-my-[18px] flex items-center">
            <Image
              src="/brand/seal-o/lockup-horizontal-dark.svg"
              alt="Moolam"
              width={132}
              height={52}
              unoptimized
              className="hidden dark:block"
            />
            <Image
              src="/brand/seal-o/lockup-horizontal-light.svg"
              alt="Moolam"
              width={132}
              height={52}
              unoptimized
              className="block dark:hidden"
            />
          </span>

          {phone ? (
            <button
              type="button"
              data-guide-anchor="menu"
              tabIndex={-1}
              className="ml-auto rounded-[8px] border border-line px-3 py-2 font-mono text-[10px] uppercase tracking-[0.18em] text-text-muted"
            >
              Menu
            </button>
          ) : (
            <>
              <span className="hidden text-xs uppercase tracking-[0.24em] text-text-faint lg:inline">
                Passports for generated images
              </span>
              <nav className="ml-auto flex items-center gap-5 text-sm">
                {nav.map((item) => (
                  <span
                    key={item.label}
                    data-guide-anchor={item.anchor ?? undefined}
                    className="whitespace-nowrap text-text-muted"
                  >
                    {item.label}
                  </span>
                ))}
              </nav>
            </>
          )}
        </div>
      </header>

      {/* The film's first beat, in the same words it uses. */}
      <div className={`relative flex h-full flex-col justify-center px-5 ${phone ? "pb-24" : "pb-16 sm:px-8 lg:px-14"}`}>
        <p className="flex items-center gap-3 font-mono text-[10px] uppercase tracking-[0.24em] text-accent">
          <span className="motif h-[9px] w-[9px]" />
          Live on Monad mainnet
        </p>
        <h1 className="mt-4 font-display text-[clamp(3rem,10vw,9rem)] font-semibold uppercase leading-[0.85] tracking-[-0.055em]">
          Moolam
        </h1>
        <p className="mt-4 max-w-[28ch] text-base leading-relaxed text-text-muted sm:text-lg">
          Every image gets a passport.
        </p>
        <p className="mt-10 font-mono text-[10px] uppercase tracking-[0.24em] text-text-faint">Scroll</p>
      </div>
    </div>
  );
}

const PLATES = [
  { left: 8, top: 34, size: 90, tilt: -8 },
  { left: 62, top: 22, size: 140, tilt: 6 },
  { left: 78, top: 58, size: 96, tilt: -4 },
  { left: 44, top: 64, size: 72, tilt: 10 },
  { left: 88, top: 30, size: 60, tilt: -12 },
  { left: 30, top: 18, size: 54, tilt: 4 },
];
