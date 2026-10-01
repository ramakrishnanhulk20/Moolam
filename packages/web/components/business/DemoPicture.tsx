"use client";

import { Picture } from "@/components/passport/Picture";
import type { DemoPicture as DemoPictureData } from "./data";

/**
 * The plate drawn where the picture would be when it could not be read: the
 * kolam knot faint on the page's own ground. It claims nothing about any
 * picture, so it is safe to show whatever went wrong.
 */
export function PlainPlate() {
  return (
    <span
      data-demo-plain
      aria-hidden
      className="absolute inset-0 flex items-center justify-center bg-bg-sunken bg-[radial-gradient(ellipse_at_50%_35%,var(--accent-soft),transparent_70%)]"
    >
      <span className="motif h-[22%] w-[22%] opacity-40" />
    </span>
  );
}

/**
 * The demo's real Dreamloom picture, filling the box it is given and treated
 * like a film still with grain over it. The gateway list falls through in
 * order, and the plain plate is drawn when there is no picture at all or every
 * gateway refused it, so the box never shows a broken image.
 */
export function DemoPicture({
  picture,
  sizes,
  alt = "",
  className = "",
  priority = false,
}: {
  picture: DemoPictureData | null;
  sizes: string;
  alt?: string;
  className?: string;
  priority?: boolean;
}) {
  return (
    <span data-demo-picture={picture === null ? "plain" : picture.id} className={`relative block overflow-hidden ${className}`}>
      {picture === null ? (
        <PlainPlate />
      ) : (
        <Picture
          sources={picture.sources}
          sizes={sizes}
          alt={alt}
          priority={priority}
          className="object-cover"
          fallback={<PlainPlate />}
        />
      )}
      <span aria-hidden className="grain pointer-events-none absolute inset-0" />
    </span>
  );
}
