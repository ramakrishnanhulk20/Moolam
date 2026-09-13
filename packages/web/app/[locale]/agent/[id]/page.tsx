import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import type { Hex } from "viem";
import { AgentPoster } from "@/components/agent/AgentPoster";
import { readCard } from "@/components/agent/card";
import { Signing } from "@/components/agent/Signing";
import { Standing } from "@/components/agent/Standing";
import { indexKnowsAgent } from "@/components/agent/known";
import { Works } from "@/components/agent/Works";
import { signedWorks, type SignedWork } from "@/components/agent/signed";
import { AgentNotFound } from "@/lib/chain/agents";
import { reason } from "@/lib/chain/client";
import { getAgent, getReputation, getReputationClients } from "@/lib/chain/registry";
import { generatorRecord, type GeneratorRecord } from "@/lib/data/passports";

/**
 * The tab carries the agent's own name when its card has one. The card is read
 * from the identity registry, the same read the page makes, and any failure
 * falls back to the number rather than costing the page its head.
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}): Promise<Metadata> {
  const { locale, id } = await params;
  const t = await getTranslations({ locale, namespace: "agent" });
  const numbered = `${t("title")} ${id}`;

  if (!/^[0-9]+$/.test(id)) {
    return { title: numbered };
  }

  try {
    const named = readCard((await getAgent(BigInt(id))).card)?.name?.trim();
    return { title: named === undefined || named === "" ? numbered : named };
  } catch {
    return { title: numbered };
  }
}

/**
 * One ERC-8004 agent: who owns it, what its card says, how it has held up, how
 * a passport gets its name on it, and every picture it has signed.
 *
 * The identity and the reputation are read from the two canonical registries on
 * Monad. The counts and the list come from the index, which is the only place
 * they exist. Nothing on this page is written here.
 */
export default async function AgentPage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { locale, id } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("agent");

  if (!/^[0-9]+$/.test(id)) {
    notFound();
  }

  const agentId = BigInt(id);

  let agent: { owner: Hex; uri: string; card: unknown | null };
  try {
    agent = await getAgent(agentId);
  } catch (error) {
    if (error instanceof AgentNotFound) {
      notFound();
    }
    return <Notice text={t("error", { reason: reason(error) })} tone="failed" />;
  }

  let reputation: { count: bigint; value: bigint; decimals: number } | null = null;
  let reputationError: string | null = null;
  try {
    reputation = await getReputation(agentId, await getReputationClients(agentId));
  } catch (error) {
    reputationError = reason(error);
  }

  let record: GeneratorRecord | null = null;
  let recordError: string | null = null;
  try {
    record = await generatorRecord(agentId);
  } catch (error) {
    recordError = reason(error);
  }

  if (!indexKnowsAgent(record, recordError)) {
    notFound();
  }

  let works: SignedWork[] = [];
  let worksError: string | null = null;
  try {
    works = await signedWorks(agentId);
  } catch (error) {
    worksError = reason(error);
  }

  const card = readCard(agent.card);

  return (
    <article>
      <AgentPoster agentId={agentId} owner={agent.owner} card={card} works={works} />

      <Standing
        reputation={reputation}
        reputationError={reputationError}
        record={record}
        recordError={recordError}
        locale={locale}
      />

      <Signing agentId={agentId} card={card} document={agent.card} uri={agent.uri} />

      <Works works={works} error={worksError} locale={locale} />
    </article>
  );
}

function Notice({ text, tone }: { text: string; tone?: "failed" }) {
  return (
    <div className="mx-auto w-full max-w-[1400px] px-5 py-24 sm:px-8">
      <p
        className={
          tone === "failed" ? "rise max-w-[52ch] text-base text-failed" : "rise max-w-[52ch] text-base text-text-muted"
        }
      >
        {text}
      </p>
    </div>
  );
}
