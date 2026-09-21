"use client";

import Image from "next/image";
import { useState, type ReactNode } from "react";
import { isOptimizable, nextSource } from "@/lib/images";

/**
 * One pinned picture, filling the box it is given.
 *
 * Two things happen here that a plain img cannot do. The picture goes through
 * Next's image optimizer, so the account's IPFS gateway is asked for the file
 * once and every later view is answered from the optimizer's cache. And a
 * gateway that will not serve the file drops to the next one in the list, with
 * the seal plate drawn only after every gateway has refused.
 *
 * The box around it must be positioned, since the picture is laid over it.
 *
 * `alt` is the picture's own name. On a registry whose whole subject is the
 * picture, an empty one tells a screen reader that the thing the page is about
 * is decoration, so every caller that draws a registered picture passes the
 * title it was registered under. The empty default is for the callers where the
 * picture really is decoration: a wall of repeated thumbnails behind a heading,
 * a plate in the film.
 */
export function Picture({
  sources,
  sizes,
  alt = "",
  className = "",
  quality = 70,
  priority = false,
  fallback = null,
}: {
  sources: string[];
  sizes: string;
  alt?: string;
  className?: string;
  quality?: number;
  priority?: boolean;
  fallback?: ReactNode;
}) {
  const first = sources[0] ?? null;
  const [held, setHeld] = useState<{ from: string | null; src: string | null }>({ from: first, src: first });

  // Read off the list it was given rather than from an effect, so a plate that
  // is handed a different passport never shows the picture before it.
  const src = held.from === first ? held.src : first;

  if (src === null) {
    return <>{fallback}</>;
  }

  return (
    <Image
      src={src}
      alt={alt}
      fill
      sizes={sizes}
      quality={quality}
      priority={priority}
      // A picture on a host the optimizer is not configured for would come back
      // as a 400 and turn into an empty plate, so it is drawn as it stands.
      unoptimized={!isOptimizable(src)}
      className={className}
      onError={() => setHeld({ from: first, src: nextSource(sources, src) })}
    />
  );
}
