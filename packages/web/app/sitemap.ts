import type { MetadataRoute } from "next";
import { pageHref } from "@/lib/docs/links";
import { navPages } from "@/lib/docs/nav";
import { latestPassports } from "@/lib/data/passports";
import { routing } from "@/lib/i18n/routing";
import { siteUrl } from "./robots";

/** One record page: a passport or an agent, with the date the index knows for it. */
export interface RecordPage {
  path: string;
  lastModified?: Date;
}

/** How many of the newest records the sitemap carries. */
const HOW_MANY = 200;

/**
 * The whole map, built from paths rather than from anything live, so a test can
 * pin the shape without a chain or an index behind it.
 *
 * The fixed pages exist in every language and are listed that way. The records
 * are listed once, under the default language: the same passport in ten
 * languages is ten URLs of one picture and one block number, which is exactly
 * what a crawler counts as duplication.
 */
export function sitemapEntries(input: {
  origin: string;
  locales: readonly string[];
  defaultLocale: string;
  pagePaths: readonly string[];
  records: readonly RecordPage[];
}): MetadataRoute.Sitemap {
  const origin = input.origin.replace(/\/+$/, "");
  const url = (locale: string, path: string) => `${origin}/${locale}${path === "/" ? "" : path}`;

  const pages = input.locales.flatMap((locale) =>
    input.pagePaths.map((path) => ({
      url: url(locale, path),
      priority: path === "/" ? 1 : 0.8,
      alternates: {
        languages: Object.fromEntries(input.locales.map((other) => [other, url(other, path)])),
      },
    })),
  );

  const records = input.records.map((record) => ({
    url: url(input.defaultLocale, record.path),
    priority: 0.6,
    ...(record.lastModified === undefined ? {} : { lastModified: record.lastModified }),
  }));

  return [...pages, ...records];
}

/** The five app pages plus every docs page the tree names, in tree order. */
export function pagePaths(): string[] {
  return ["/", "/explore", "/agents", "/verify", "/studio", ...navPages().map((page) => pageHref(page.slug))];
}

/**
 * The newest passports the index knows, and the agents that signed them.
 *
 * An index that will not answer costs the record pages, never the sitemap: the
 * fixed pages are the ones a crawler has to find, and they are built from the
 * routing table rather than from any read.
 */
async function records(): Promise<RecordPage[]> {
  try {
    const { passports } = await latestPassports(HOW_MANY);
    const agents = new Map<string, Date>();

    const pages = passports.map((passport) => {
      const when = new Date(Number(passport.registeredAt) * 1000);
      const agent = passport.agentId.toString();
      if (agent !== "0" && !agents.has(agent)) {
        agents.set(agent, when);
      }
      return { path: `/passport/${passport.id}`, lastModified: when };
    });

    return [
      ...pages,
      ...[...agents].map(([agent, when]) => ({ path: `/agent/${agent}`, lastModified: when })),
    ];
  } catch {
    return [];
  }
}

// The record half is read on the request, so a crawler that comes back next
// week is given next week's passports rather than the ones the build saw.
export const dynamic = "force-dynamic";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  return sitemapEntries({
    origin: siteUrl(),
    locales: routing.locales,
    defaultLocale: routing.defaultLocale,
    pagePaths: pagePaths(),
    records: await records(),
  });
}
