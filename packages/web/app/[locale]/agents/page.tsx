import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { Board } from "@/components/agents/Board";
import { roster, type AgentRow } from "@/components/agents/roster";
import { reason } from "@/lib/chain/client";
import { generatorStandings } from "@/lib/data/passports";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "agents" });
  return { title: t("title"), description: t("lede") };
}

// The counts move every time an agent signs a picture or a re-check lands, so
// the page is read on the request rather than at build time.
export const dynamic = "force-dynamic";

/**
 * Every generator the registry has seen, with the standing the index keeps for
 * it and the name its own ERC-8004 card carries.
 *
 * Two sources, each doing what only it can: the index adds up the passports and
 * the re-checks, the identity registry on Monad says who the agent is.
 */
export default async function AgentsPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);

  let agents: AgentRow[] = [];
  let error: string | null = null;

  try {
    agents = await roster(await generatorStandings());
  } catch (problem) {
    error = reason(problem);
  }

  return <Board agents={agents} error={error} locale={locale} />;
}
