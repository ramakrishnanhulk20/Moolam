"use client";

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
}: {
  samples: TrySample[];
  onPick: (sample: TrySample) => void;
  busy: boolean;
}) {
  const t = useTranslations("verify");
  const common = useTranslations("common");

  // An index that could not be reached hands back nothing. The page then reads
  // exactly as it did before rather than showing three empty frames.
  if (samples.length === 0) {
    return null;
  }

  // The plates rise with the CSS rise, not a motion component, so they are in
  // the server's HTML and visible before the script runs, which is when a judge
  // on a slow phone is looking for something to press. The drop box around them
  // already rises, so only the plates are staggered.
  return (
    <div data-verify-samples className="mt-5">
      <p className="flex items-center gap-3 font-mono text-[10px] uppercase tracking-[0.24em] text-text-faint">
        <span className="motif h-[8px] w-[8px] opacity-50" />
        {t("samples")}
      </p>

      <ul className="mt-4 grid grid-cols-3 gap-3 sm:gap-4">
        {samples.map((sample, index) => (
          <li key={sample.id} className="rise" style={{ animationDelay: `${320 + 60 * index}ms` }}>
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
          </li>
        ))}
      </ul>
    </div>
  );
}
