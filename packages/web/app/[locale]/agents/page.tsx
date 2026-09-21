import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { AgentsSheet } from "@/components/agents/Sheet";
import { holdAgentsRoster } from "@/lib/data/prerender";
import { routing } from "@/lib/i18n/routing";

// A minute is the window the roster read is already held for, so the board is
// made once and refreshed a minute at a time behind whoever asks for it. An
// agent that signs a picture now is on the board on the next request after that.
export const revalidate = 60;

/**
 * The board is made in all ten languages while the site is built, so the first
 * visitor after a deploy is handed the roster rather than waiting on a query to
 * the index and a card read on Monad for every agent it lists. What a build
 * writes into its data cache does not travel to the running site; a page it made
 * does.
 *
 * This page reads nothing out of the address, so every visitor asks for the same
 * board and there is no sibling route drawn on the request.
 */
export async function generateStaticParams(): Promise<{ locale: string }[]> {
  await holdAgentsRoster();
  return routing.locales.map((locale) => ({ locale }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "agents" });
  return { title: t("title"), description: t("lede") };
}

export default async function AgentsPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);

  return <AgentsSheet locale={locale} />;
}
