"use client";

import { motion } from "framer-motion";
import { useTranslations } from "next-intl";
import { shortHex } from "@/lib/chain/client";
import { pictureSources } from "@/lib/images";
import { Picture } from "@/components/passport/Picture";
import type { TrySample } from "@/lib/data/samples";

/**
 * Three registered pictures, for a reader with nothing of their own to drop.
 *
 * A judge opens this page with no Moolam picture on their laptop, so "Choose an
 * image" is a dead end for them. These are the same pictures the home panel
 * offers, read from the registry, and pressing one runs the real check on the
 * real pinned bytes: the plate fetches the file from the gateway and hands it
 * to the same path a dropped file takes.
 */
export function Samples({
  samples,
  onPick,
  busy,
  compact = false,
}: {
  samples: TrySample[];
  onPick: (sample: TrySample) => void;
  busy: boolean;
  /** Under the compact opening the row sits closer to the drop box, so it is in the first screen. */
  compact?: boolean;
}) {
  const t = useTranslations("verify");
  const common = useTranslations("common");

  // An index that could not be reached hands back nothing. The page then reads
  // exactly as it did before rather than showing three empty frames.
  if (samples.length === 0) {
    return null;
  }

  return (
    <motion.div
      data-verify-samples
      initial={{ opacity: 0, y: 20 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, amount: 0.3 }}
      transition={{ duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
      className={compact ? "mt-5" : "mt-8"}
    >
      <p className="flex items-center gap-3 font-mono text-[10px] uppercase tracking-[0.24em] text-text-faint">
        <span className="motif h-[8px] w-[8px] opacity-50" />
        {t("samples")}
      </p>

      <ul className="mt-4 grid grid-cols-3 gap-3 sm:gap-4">
        {samples.map((sample, index) => (
          <motion.li
            key={sample.id}
            initial={{ opacity: 0, y: 14 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, amount: 0.3 }}
            transition={{ duration: 0.6, delay: 0.06 * index, ease: [0.16, 1, 0.3, 1] }}
          >
            <button
              type="button"
              onClick={() => onPick(sample)}
              disabled={busy}
              title={sample.title ?? shortHex(sample.id, 10, 8)}
              className="group block w-full text-start transition-opacity duration-200 disabled:opacity-50"
            >
              {/* The box is reserved before the picture arrives, so nothing on
                  the page moves when it does. */}
              <span className="grain relative block aspect-[4/3] w-full overflow-hidden border border-line transition-colors duration-200 group-hover:border-accent group-focus-visible:border-accent">
                <Picture
                  sources={pictureSources(sample.url)}
                  alt={sample.title ?? common("registeredPicture")}
                  sizes="(min-width: 1024px) 14rem, 30vw"
                  className="object-cover opacity-85 transition duration-500 group-hover:scale-[1.06] group-hover:opacity-100"
                />
                <span className="scrim pointer-events-none absolute inset-0 opacity-70" />
              </span>
              <span className="mt-2 line-clamp-2 block text-[11px] leading-snug text-text-muted transition-colors duration-200 group-hover:text-accent group-focus-visible:text-accent sm:text-xs">
                {sample.title ?? shortHex(sample.id, 6, 4)}
              </span>
            </button>
          </motion.li>
        ))}
      </ul>
    </motion.div>
  );
}
