import type { MetadataRoute } from "next";
import { routing } from "@/lib/i18n/routing";
import messages from "@/messages/en.json";

/**
 * What a phone writes down when someone keeps this site on a home screen.
 *
 * Without it Android fell back to the apple icon and the document title, so an
 * installed Moolam had no name of its own, no colours and a browser bar over
 * it. The words are English because a manifest is one file for the whole
 * origin, and the start address is the default language for the same reason:
 * the locale a reader picks lives in the path, which the browser keeps anyway
 * when it installs from a page inside the site.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: `${messages.meta.title}: ${messages.header.tagline}`,
    short_name: messages.meta.title,
    description: messages.meta.home,
    start_url: `/${routing.defaultLocale}`,
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    // The film and every app screen open on the dark palette, so the splash and
    // the phone's own chrome start there rather than flashing white first.
    background_color: "#08080a",
    theme_color: "#08080a",
    icons: [
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
      { src: "/apple-icon.png", sizes: "180x180", type: "image/png", purpose: "any" },
      { src: "/favicon.ico", sizes: "48x48 32x32 16x16", type: "image/x-icon" },
    ],
  };
}
