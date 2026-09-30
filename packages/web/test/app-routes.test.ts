import { afterEach, describe, expect, it, vi } from "vitest";

// The sitemap reads the locale table, and next-intl's navigation helpers reach
// for next/navigation, which only resolves inside the bundler.
vi.mock("@/lib/i18n/routing", () => ({
  routing: { locales: ["en", "ta", "ja"], defaultLocale: "en" },
}));

const { default: robots, siteUrl, DEFAULT_SITE_URL } = await import("@/app/robots");
const { pagePaths, sitemapEntries } = await import("@/app/sitemap");

afterEach(() => {
  delete process.env.NEXT_PUBLIC_SITE_URL;
});

describe("where this app says it lives", () => {
  it("falls back to the published domain", () => {
    expect(siteUrl()).toBe(DEFAULT_SITE_URL);
  });

  it("takes the variable when it is set, without a trailing slash", () => {
    process.env.NEXT_PUBLIC_SITE_URL = "https://moolam.xyz/";
    expect(siteUrl()).toBe("https://moolam.xyz");
  });
});

describe("what robots.txt says", () => {
  const rule = () => {
    const only = robots().rules;
    return Array.isArray(only) ? only[0] : only;
  };

  it("opens the site and closes the routes that are not pages for a crawler", () => {
    expect(rule().allow).toBe("/");
    expect(rule().disallow).toEqual(["/docs-search", "/*/explore/view", "/*/mine", "/*/cosign", "/*/connect"]);
  });

  it("names the sitemap on the public domain", () => {
    expect(robots().sitemap).toBe(`${DEFAULT_SITE_URL}/sitemap.xml`);
  });
});

describe("what the sitemap lists", () => {
  const when = new Date("2026-09-09T09:17:19.000Z");
  const map = sitemapEntries({
    origin: "https://moolam.vercel.app/",
    locales: ["en", "ta"],
    defaultLocale: "en",
    pagePaths: ["/", "/verify", "/studio", "/docs", "/docs/api/events"],
    records: [
      { path: `/passport/0x${"1a".repeat(32)}`, lastModified: when },
      { path: "/agent/10248", lastModified: when },
    ],
  });
  const urls = map.map((entry) => entry.url);

  it("carries every fixed page in every language", () => {
    expect(urls).toContain("https://moolam.vercel.app/en");
    expect(urls).toContain("https://moolam.vercel.app/ta");
    expect(urls).toContain("https://moolam.vercel.app/en/verify");
    expect(urls).toContain("https://moolam.vercel.app/ta/studio");
    expect(urls).toContain("https://moolam.vercel.app/en/docs");
    expect(urls).toContain("https://moolam.vercel.app/ta/docs/api/events");
  });

  it("gives the home page the top priority and the records the lowest", () => {
    expect(map.find((entry) => entry.url === "https://moolam.vercel.app/en")?.priority).toBe(1);
    expect(map.find((entry) => entry.url.includes("/verify"))?.priority).toBe(0.8);
    expect(map.find((entry) => entry.url.includes("/agent/"))?.priority).toBe(0.6);
  });

  it("lists a record once, in the default language, with the date the index knows", () => {
    const records = urls.filter((url) => url.includes("/passport/") || url.includes("/agent/"));
    expect(records).toEqual([
      `https://moolam.vercel.app/en/passport/0x${"1a".repeat(32)}`,
      "https://moolam.vercel.app/en/agent/10248",
    ]);
    expect(map.find((entry) => entry.url.includes("/agent/"))?.lastModified).toBe(when);
  });

  it("points a crawler at the same page in the other languages", () => {
    const home = map.find((entry) => entry.url === "https://moolam.vercel.app/en");
    expect(home?.alternates?.languages).toEqual({
      en: "https://moolam.vercel.app/en",
      ta: "https://moolam.vercel.app/ta",
    });
  });

  it("offers no /lab address", () => {
    expect(urls.some((url) => url.includes("/lab"))).toBe(false);
  });
});

describe("the pages the sitemap builds itself from", () => {
  it("starts with the five app pages and then every docs page in the tree", () => {
    const paths = pagePaths();
    expect(paths.slice(0, 6)).toEqual(["/", "/explore", "/agents", "/verify", "/studio", "/docs"]);
    expect(paths).toContain("/docs/developers/architecture");
    expect(paths.length).toBeGreaterThan(20);
  });
});
