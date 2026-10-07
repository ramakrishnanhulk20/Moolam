import type { MetadataRoute } from "next";

/** Where this app answers in public, for the sitemap, robots and every social card. */
export const DEFAULT_SITE_URL = "https://moolam.site";

/**
 * The public origin, without a trailing slash.
 *
 * Vercel gives every deployment its own hostname, so a card or a sitemap built
 * from the request would name a preview URL that outlives nothing. This is the
 * one address the product is published at, and it is a variable so a custom
 * domain is one setting rather than a code change.
 */
export function siteUrl(): string {
  const named = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  const chosen = named === undefined || named === "" ? DEFAULT_SITE_URL : named;
  return chosen.replace(/\/+$/, "");
}

/**
 * Everything is open to crawlers except the routes that are not pages of their
 * own: the search endpoint, which answers JSON, the inner route a narrowed
 * Explore address is handed to, which a reader only ever sees as /explore, the
 * page of one person's own pictures, which says nothing to anyone who is not
 * signed in, and the co-sign and connect pages, which exist for one person
 * holding one link from a platform.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow: ["/docs-search", "/*/explore/view", "/*/mine", "/*/cosign", "/*/connect"],
      },
    ],
    sitemap: `${siteUrl()}/sitemap.xml`,
  };
}
