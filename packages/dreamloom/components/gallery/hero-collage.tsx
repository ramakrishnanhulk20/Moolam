"use client";

import { motion, useReducedMotion, useScroll, useTransform } from "framer-motion";
import { useState } from "react";
import { useGallery } from "./gallery-data";
import { PassportBadge } from "./passport-badge";

/** Where each of the three pictures lands, and how far it drifts as the page scrolls. */
const PLACES = [
  { className: "top-0 right-[6%] w-[58%]", badge: "top-3 right-3", tilt: 6, drift: -70, bob: 7 },
  { className: "top-[30%] left-0 w-[50%]", badge: "bottom-3 left-3", tilt: -7, drift: -30, bob: 8.5 },
  { className: "bottom-0 right-0 w-[46%]", badge: "bottom-3 left-3", tilt: 3, drift: -110, bob: 6.2 },
] as const;

/**
 * The three newest pictures, tossed beside the prompt box so the first screen
 * shows what the loom makes. They are the gallery's own real pictures, so the
 * space stays empty until the gallery has answered, and on a phone it is
 * skipped so the prompt box owns the screen.
 */
export function HeroCollage() {
  const { view } = useGallery();
  const still = useReducedMotion() ?? false;
  const { scrollY } = useScroll();
  const drift = [
    useTransform(scrollY, [0, 900], [0, still ? 0 : PLACES[0].drift]),
    useTransform(scrollY, [0, 900], [0, still ? 0 : PLACES[1].drift]),
    useTransform(scrollY, [0, 900], [0, still ? 0 : PLACES[2].drift]),
  ];

  const pictures =
    view.state === "ready" ? view.pictures.filter((picture) => picture.imageUrl !== null).slice(0, 3) : [];

  return (
    <div aria-hidden={pictures.length === 0} className="relative hidden min-h-[30rem] lg:block">
      {pictures.length === 3 &&
        pictures.map((picture, index) => {
          const place = PLACES[index];
          return (
            <motion.div
              key={picture.passportId}
              style={{ y: drift[index] }}
              whileHover={{ zIndex: 10 }}
              className={`absolute ${place.className}`}
            >
              <motion.figure
                initial={{ opacity: 0, scale: 0.8, rotate: place.tilt * 3, y: 40 }}
                animate={{ opacity: 1, scale: 1, rotate: place.tilt, y: 0 }}
                transition={{ type: "spring", stiffness: 90, damping: 14, delay: 0.15 + index * 0.14 }}
                whileHover={{ scale: 1.04, rotate: 0 }}
                className="relative"
              >
                <motion.div
                  animate={still ? undefined : { y: [0, -10, 0] }}
                  transition={{ duration: place.bob, repeat: Infinity, ease: "easeInOut" }}
                  className="rounded-[1.75rem] bg-card p-2 shadow-[0_40px_80px_-30px_rgba(23,18,43,0.45)] ring-1 ring-ink/5"
                >
                  <div className="relative aspect-square overflow-hidden rounded-[1.35rem] bg-mist">
                    <FadeInImage
                      src={picture.imageUrl ?? undefined}
                      alt={picture.prompt ?? picture.title ?? "A picture from the Dreamloom gallery"}
                    />
                    <PassportBadge href={picture.passportUrl} className={`absolute ${place.badge}`} />
                  </div>
                </motion.div>
              </motion.figure>
            </motion.div>
          );
        })}
    </div>
  );
}

function FadeInImage({ src, alt }: { src: string | undefined; alt: string }) {
  const [loaded, setLoaded] = useState(false);
  return (
    <img
      src={src}
      alt={alt}
      onLoad={() => setLoaded(true)}
      className={`absolute inset-0 size-full object-cover transition-opacity duration-700 ${loaded ? "opacity-100" : "opacity-0"}`}
    />
  );
}
