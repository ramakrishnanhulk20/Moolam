import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { setRequestLocale } from "next-intl/server";
import { Masthead } from "@/components/docs/Masthead";
import { OnThisPage } from "@/components/docs/OnThisPage";
import { PrevNext } from "@/components/docs/PrevNext";
import { slugFromSegments, segmentsFromSlug } from "@/lib/docs/links";
import { navPages, neighbours, sectionOf } from "@/lib/docs/nav";
import { readPage } from "@/lib/docs/pages";
import { renderPage } from "@/lib/docs/render";

type Params = { locale: string; slug?: string[] };

/** Every page in the tree, built with the site. Anything else is a 404. */
export function generateStaticParams() {
  return navPages().map((page) => ({ slug: segmentsFromSlug(page.slug) }));
}

export const dynamicParams = false;

export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
  const { slug } = await params;
  const page = readPage(slugFromSegments(slug));
  if (page === null) {
    return {};
  }
  const { heading, text } = await renderPage(page.slug, page.body);
  return {
    title: (heading ?? page.title) === "Moolam" ? "Documentation | Moolam" : `${heading ?? page.title} | Moolam`,
    description: text.slice(0, 155).trim(),
  };
}

export default async function DocsPage({ params }: { params: Promise<Params> }) {
  const { locale, slug } = await params;
  setRequestLocale(locale);

  const page = readPage(slugFromSegments(slug));
  if (page === null) {
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
