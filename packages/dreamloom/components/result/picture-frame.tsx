"use client";

import { AnimatePresence, motion, useReducedMotion, useScroll, useTransform } from "framer-motion";
import { useState } from "react";
import { PassportBadge } from "@/components/gallery/passport-badge";
import { imagePath } from "./picture-api";

/**
 * The woven picture, large, in the home screen's card. While a co-sign is open the card wears the
 * prompt box's turning ring, so the wait reads as the loom still working. When the passport lands,
 * Moolam's badge is stamped onto the corner: the one moment on this page built to be remembered.
 */
export function PictureFrame({
  id,
  prompt,
  passportHref,
  waiting,
}: {
  id: string;
  prompt: string;
  passportHref: string | null;
  waiting: boolean;
}) {
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const still = useReducedMotion() ?? false;
  const { scrollY } = useScroll();
  const drift = useTransform(scrollY, [0, 700], [0, still ? 0 : -40]);

  return (
    <motion.div style={{ y: drift }} className="relative">
      <motion.figure
        initial={{ opacity: 0, y: 48, rotate: -5, scale: 0.94 }}
        animate={{ opacity: 1, y: 0, rotate: -1.5, scale: 1 }}
        transition={{ type: "spring", stiffness: 90, damping: 16, delay: 0.1 }}
        whileHover={still ? undefined : { rotate: 0, scale: 1.01 }}
        className="relative"
      >
        <div
          data-busy={waiting}
          className={`rounded-[calc(1.75rem+3px)] p-[3px] transition-[background] duration-500 ${waiting ? "weave-ring" : "bg-transparent"}`}
        >
          <div className="rounded-[1.75rem] bg-card p-2 shadow-[0_40px_90px_-35px_rgba(23,18,43,0.5)] ring-1 ring-ink/5 sm:p-2.5">
            <div className="relative aspect-square overflow-hidden rounded-[1.35rem] bg-mist">
              {!loaded && !failed && <div aria-hidden className="shimmer absolute inset-0" />}
              {failed ? (
                <div className="absolute inset-0 flex items-end bg-[radial-gradient(120%_90%_at_20%_10%,#e2dcff_0%,#f6f4ff_55%,#ffe9d9_100%)] p-5">
                  <p className="max-w-[22rem] text-base font-medium text-ink-soft">
                    The picture did not load. Reload the page to try again; everything else here still works.
                  </p>
                </div>
              ) : (
                <img
                  src={imagePath(id)}
                  alt={prompt}
                  decoding="async"
                  onLoad={() => setLoaded(true)}
                  onError={() => setFailed(true)}
                  className={`absolute inset-0 size-full object-cover transition duration-700 ease-out ${loaded ? "scale-100 opacity-100" : "scale-[1.04] opacity-0"}`}
                />
              )}
              {/* A soft grain and a low scrim give the still some depth and keep the badge readable on a bright picture. */}
              <div
                aria-hidden
                className="pointer-events-none absolute inset-0 opacity-[0.12] mix-blend-overlay"
                style={{
                  backgroundImage:
                    "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E\")",
                }}
              />
              <div
                aria-hidden
                className="pointer-events-none absolute inset-x-0 bottom-0 h-1/3 bg-gradient-to-t from-ink/40 to-transparent"
              />
              <AnimatePresence>
                {passportHref !== null && (
                  <motion.div
                    key="stamp"
                    initial={still ? { opacity: 0 } : { opacity: 0, scale: 2.6, rotate: -18, y: -40 }}
                    animate={{ opacity: 1, scale: 1, rotate: -3, y: 0 }}
                    transition={{ type: "spring", stiffness: 260, damping: 17, delay: 0.25 }}
                    className="absolute bottom-3 left-3 origin-bottom-left sm:bottom-4 sm:left-4"
                  >
                    {!still && (
                      <motion.span
                        aria-hidden
                        initial={{ opacity: 0.7, scale: 0.6 }}
                        animate={{ opacity: 0, scale: 2.4 }}
                        transition={{ duration: 0.9, ease: "easeOut", delay: 0.4 }}
                        className="pointer-events-none absolute inset-0 rounded-full ring-4 ring-sun"
                      />
                    )}
                    <div className="scale-[1.18] origin-bottom-left sm:scale-[1.3]">
                      <PassportBadge href={passportHref} />
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </div>
        </div>
      </motion.figure>
    </motion.div>
  );
}
