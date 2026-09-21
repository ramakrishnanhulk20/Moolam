import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { setRequestLocale } from "next-intl/server";
import { Masthead } from "@/components/docs/Masthead";
import { OnThisPage } from "@/components/docs/OnThisPage";
import { PrevNext } from "@/components/docs/PrevNext";
import { slugFromSegments, segmentsFromSlug } from "@/lib/docs/links";
import { draftsVisible } from "@/lib/docs/drafts";
import { isDraft, navPages, neighbours, sectionOf } from "@/lib/docs/nav";
import { readPage } from "@/lib/docs/pages";
import { renderPage } from "@/lib/docs/render";

type Params = { locale: string; slug?: string[] };

/**
 * Every released page in the tree, built with the site. Anything else is a 404,
 * and a draft page is released only where the lab flag is on: it is built and
 * reachable on that machine and nowhere else.
 */
export function generateStaticParams() {
  return navPages().map((page) => ({ slug: segmentsFromSlug(page.slug) }));
}

export const dynamicParams = false;

export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
  const { slug } = await params;
  const page = readPage(slugFromSegments(slug));
  if (page === null || (isDraft(page.slug) && !draftsVisible())) {
    return {};
  }
  const { heading, text } = await renderPage(page.slug, page.body);
  return {
    title: (heading ?? page.title) === "Moolam" ? "Documentation" : (heading ?? page.title),
    description: openingLines(text),
  };
}

/** What a search result has room for before it starts cutting the line itself. */
const DESCRIPTION_LIMIT = 155;

/**
 * The opening of a docs page, ended where a reader would end it.
 *
 * Cutting the prose at a character count stopped these lines mid-word: the docs
 * home read "a passport on Mon". So the last full stop inside the budget wins,
 * and a first sentence longer than the budget falls back to the last whole word.
 */
export function openingLines(text: string, limit = DESCRIPTION_LIMIT): string {
  const line = text.trim().replace(/\s+/g, " ");
  if (line.length <= limit) {
    return line;
  }

  const window = line.slice(0, limit);
  const sentence = Math.max(window.lastIndexOf(". "), window.lastIndexOf(". "));
  if (sentence > limit / 3) {
    return window.slice(0, sentence + 1);
  }

  // Three dots are part of the count, so the words stop three characters early.
  const words = line.slice(0, limit - 3);
  const lastSpace = words.lastIndexOf(" ");
  const kept = lastSpace > limit / 3 ? words.slice(0, lastSpace) : words;
  return `${kept.replace(/[\s,;:.-]+$/u, "")}...`;
}

export default async function DocsPage({ params }: { params: Promise<Params> }) {
  const { locale, slug } = await params;
  setRequestLocale(locale);

  const page = readPage(slugFromSegments(slug));
  // A page on disk that the tree does not release is not a page here: without
  // this, a draft could be read by anyone who guessed its address.
  if (page === null || (isDraft(page.slug) && !draftsVisible())) {
    notFound();
  }

  const { heading, headings, content } = await renderPage(page.slug, page.body);
  const { previous, next } = neighbours(page.slug);

  return (
    <div className="grid min-w-0 gap-x-12 pb-24 pt-12 xl:grid-cols-[minmax(0,1fr)_13rem]">
      <article data-docs-article className="min-w-0">
        <Masthead section={sectionOf(page.slug)} title={heading ?? page.title} />
        <OnThisPage headings={headings} variant="fold" />
        <div className="docs-prose">{content}</div>
        <PrevNext previous={previous} next={next} />
      </article>
      <OnThisPage headings={headings} variant="rail" />
    </div>
  );
}
