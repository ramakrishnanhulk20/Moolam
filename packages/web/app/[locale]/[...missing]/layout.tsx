import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import type { ReactNode } from "react";

/**
 * The words in the tab and in a link preview for an address that is not a page.
 *
 * They live on a layout rather than on the page under it because the page's own
 * job is to answer 404, and Next drops a page's metadata the moment it does
 * that: the head fell back to the site's title and the site's description, so a
 * mistyped passport id unfurled in a chat as if it were a working page. A
 * layout in the same place is kept, because the not-found screen renders inside
 * it.
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "notFound" });
  // The heading already names Moolam, so the template is stepped around rather
  // than reading "Not on Moolam | Moolam". Next marks a 404 noindex itself.
  return { title: { absolute: t("title") }, description: t("lede") };
}

export default function MissingLayout({ children }: { children: ReactNode }) {
  return children;
}
