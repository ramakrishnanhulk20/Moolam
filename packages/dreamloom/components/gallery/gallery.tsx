"use client";

import { motion } from "framer-motion";
import { useState } from "react";
import type { GalleryPicture } from "@/lib/gallery";
import { useGallery } from "./gallery-data";
import { PassportBadge } from "./passport-badge";

/**
 * The frames a card is cropped to, walked in turn. Most pictures arrive square,
 * and a wall of equal squares reads as a spreadsheet; varying the crop is what
 * makes the columns fall like a real masonry wall.
 */
const FRAMES = ["aspect-[4/5]", "aspect-square", "aspect-[3/4]", "aspect-[5/4]", "aspect-square", "aspect-[4/5]"];

export function Gallery() {
  const { view, reload } = useGallery();

  return (
    <section id="gallery" className="relative mx-auto max-w-[88rem] scroll-mt-6 px-4 pb-24 sm:px-10">
      <div className="mb-8 flex flex-col gap-4 sm:mb-12 lg:flex-row lg:items-end lg:justify-between">
        <motion.h2
          initial={{ opacity: 0, y: 32 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-80px" }}
          transition={{ duration: 0.8, ease: [0.22, 1, 0.36, 1] }}
          className="font-display text-[clamp(2.4rem,6.5vw,5.75rem)] leading-[0.92] font-extrabold tracking-[-0.045em] text-ink"
          style={{ fontVariationSettings: '"opsz" 96, "wdth" 88' }}
        >
          Fresh off <span className="text-daybreak">the loom</span>
        </motion.h2>
        <p className="max-w-[26rem] text-base text-ink-soft lg:pb-3 lg:text-right">
          The newest pictures, read from Moolam&apos;s public index. Tap a badge to open that picture&apos;s passport.
        </p>
      </div>

      {view.state === "loading" && <Loading />}
      {view.state === "unavailable" && <Unavailable onRetry={reload} />}
      {view.state === "ready" && view.pictures.length === 0 && <Empty />}
      {view.state === "ready" && view.pictures.length > 0 && (
        <div className="columns-2 gap-3 sm:gap-5 md:columns-3 xl:columns-4">
          {view.pictures.map((picture, index) => (
            <PictureCard
              key={picture.passportId}
              picture={picture}
              frame={FRAMES[index % FRAMES.length]}
              order={index}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function PictureCard({ picture, frame, order }: { picture: GalleryPicture; frame: string; order: number }) {
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const words = picture.prompt ?? picture.title;
  const drawable = picture.imageUrl !== null && !failed;

  // The entry lives on a wrapper so its transform never fights the card's own hover lift.
  return (
    <motion.div
      initial={{ opacity: 0, y: 40, rotate: order % 2 === 0 ? -2 : 2 }}
      whileInView={{ opacity: 1, y: 0, rotate: 0 }}
      viewport={{ once: true, margin: "-40px" }}
      transition={{ type: "spring", stiffness: 120, damping: 18, delay: (order % 4) * 0.07 }}
      className="mb-3 break-inside-avoid sm:mb-5"
    >
      <article className="group rounded-[1.5rem] bg-card p-1.5 shadow-[0_2px_0_rgba(23,18,43,0.04),0_10px_30px_-18px_rgba(23,18,43,0.35)] ring-1 ring-ink/5 transition duration-300 ease-out hover:-translate-y-1.5 hover:shadow-[0_24px_50px_-20px_rgba(90,59,255,0.45)] sm:p-2">
        <div className={`relative overflow-hidden rounded-[1.15rem] bg-mist ${frame}`}>
          {drawable ? (
            <img
              src={picture.imageUrl ?? undefined}
              alt={words ?? "A picture from the Dreamloom gallery"}
              loading="lazy"
              decoding="async"
              onLoad={() => setLoaded(true)}
              onError={() => setFailed(true)}
              className={`absolute inset-0 size-full object-cover transition duration-500 ease-out group-hover:scale-[1.05] ${loaded ? "opacity-100" : "opacity-0"}`}
            />
          ) : picture.unpublished ? (
            <div className="absolute inset-0 flex flex-col items-start justify-start gap-2 bg-[radial-gradient(120%_90%_at_20%_10%,#e2dcff_0%,#f6f4ff_55%,#ffe9d9_100%)] p-3 sm:p-5">
              <Lock />
              <p className="font-display text-base leading-tight font-bold text-ink sm:text-lg">Kept private</p>
              <p className="hidden text-sm leading-snug text-ink-soft sm:block">
                Its creator never published the picture. The passport is public.
              </p>
            </div>
          ) : (
            <div className="absolute inset-0 flex items-start p-3 sm:p-5">
              <p className="text-xs leading-snug font-medium text-ink-soft sm:text-sm">
                The picture did not load from its gateway. Its passport is still there.
              </p>
            </div>
          )}
          {drawable && (
            <div
              aria-hidden
              className="pointer-events-none absolute inset-x-0 bottom-0 h-1/3 bg-gradient-to-t from-ink/45 to-transparent"
            />
          )}
          <PassportBadge href={picture.passportUrl} className="absolute bottom-2 left-2 sm:bottom-3 sm:left-3" />
        </div>
        {words !== null && (
          <p className="line-clamp-2 px-1.5 pt-2.5 pb-1 text-sm leading-snug text-ink-soft sm:px-2 sm:text-[0.95rem]">
            {words}
          </p>
        )}
      </article>
    </motion.div>
  );
}

function Lock() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      className="size-7 text-violet sm:size-8"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="4.5" y="10.5" width="15" height="10" rx="3" />
      <path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" />
    </svg>
  );
}

function Loading() {
  return (
    <div role="status">
      <p className="mb-5 text-base font-semibold text-ink-soft">
        Reading the newest pictures from Moolam&apos;s index...
      </p>
      <div aria-hidden className="columns-2 gap-3 sm:gap-5 md:columns-3 xl:columns-4">
        {FRAMES.concat(FRAMES.slice(0, 2)).map((frame, index) => (
          <div key={index} className="mb-3 break-inside-avoid rounded-[1.5rem] bg-card p-1.5 sm:mb-5 sm:p-2">
            <div className={`shimmer rounded-[1.15rem] ${frame}`} />
          </div>
        ))}
      </div>
    </div>
  );
}

function Unavailable({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="rounded-[2rem] border-2 border-dashed border-ink/15 bg-card/70 px-6 py-12 sm:px-12 sm:py-16">
      <p className="font-display text-2xl font-bold text-ink sm:text-3xl">The gallery is unavailable right now.</p>
      <p className="mt-3 max-w-[40rem] text-base text-ink-soft">
        Moolam&apos;s index did not answer, so there is nothing to show rather than an empty wall that looks real. It is
        asked again at most once a minute.
      </p>
      <button
        type="button"
        onClick={onRetry}
        className="mt-6 cursor-pointer rounded-full bg-ink px-6 py-3 text-base font-semibold text-white transition hover:-translate-y-0.5 hover:bg-violet focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-violet"
      >
        Try again
      </button>
    </div>
  );
}

function Empty() {
  return (
    <div className="rounded-[2rem] bg-card/70 px-6 py-12 sm:px-12 sm:py-16">
      <p className="font-display text-2xl font-bold text-ink sm:text-3xl">No pictures on the loom yet.</p>
      <p className="mt-3 max-w-[40rem] text-base text-ink-soft">
        Moolam&apos;s index answered and holds no pictures from Dreamloom so far. The first one woven and registered
        here shows up within a minute.
      </p>
    </div>
  );
}
