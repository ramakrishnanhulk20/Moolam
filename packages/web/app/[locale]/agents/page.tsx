import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { AgentsSheet } from "@/components/agents/Sheet";
import { holdAgentsRoster } from "@/lib/data/prerender";
import { routing } from "@/lib/i18n/routing";

// The board is drawn on every visit (components/agents/Sheet.tsx): a page made
// once a minute was handed out stale to the first visitor after a quiet spell.
// Its reads stay held for a minute and are read again as soon as a new passport
// is registered (components/agents/fresh.ts).

/**
 * The ten languages, listed while the site is built. The roster read here warms
 * the build's own cache only; the running site reads its own on the first visit.
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
