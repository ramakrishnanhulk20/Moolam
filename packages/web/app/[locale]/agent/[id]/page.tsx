import { getTranslations, setRequestLocale } from "next-intl/server";
import type { Hex } from "viem";
import { MONAD_EXPLORER, REPUTATION_REGISTRY, addresses, gatewayUrl, reason } from "@/lib/chain/client";
import { AgentNotFound } from "@/lib/chain/agents";
import { getAgent, getReputation, getReputationClients } from "@/lib/chain/registry";

export default async function AgentPage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { locale, id } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("agent");
  const common = await getTranslations("common");

  if (!/^[0-9]+$/.test(id)) {
    return <Notice text={t("notFound")} />;
  }

  const agentId = BigInt(id);

  let agent: { owner: Hex; uri: string; card: unknown | null };
  try {
    agent = await getAgent(agentId);
  } catch (error) {
    if (error instanceof AgentNotFound) {
      return <Notice text={t("notFound")} />;
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

  const card = agent.card as { name?: string; description?: string } | null;
  const score = reputation === null ? 0 : Number(reputation.value) / 10 ** reputation.decimals;

  return (
    <article className="mx-auto w-full max-w-[1400px] px-5 py-16 sm:px-8 sm:py-24">
      <header className="rise max-w-[62ch]">
        <p className="font-mono text-[11px] uppercase tracking-[0.24em] text-text-faint">
          {t("title")} {agentId.toString()}
        </p>
        <h1 className="mt-4 font-display text-[clamp(2.5rem,7vw,5.5rem)] uppercase leading-[0.9] tracking-[-0.01em]">
          {card?.name ?? t("card")}
        </h1>
        {card?.description === undefined ? null : (
          <p className="mt-5 text-base leading-relaxed text-text-muted">{card.description}</p>
        )}
        {agent.card === null ? <p className="mt-5 text-sm text-text-muted">{t("cardMissing")}</p> : null}
      </header>

      <div className="mt-14 grid gap-14 border-t border-line pt-8 lg:grid-cols-[1fr_1fr]">
        <section className="rise" style={{ animationDelay: "80ms" }}>
          <dl className="grid gap-6 sm:grid-cols-2">
            <div>
              <dt className="font-mono text-[11px] uppercase tracking-[0.18em] text-text-faint">{t("owner")}</dt>
              <dd className="mt-1.5 break-all font-mono text-sm">
                <a
                  href={`${MONAD_EXPLORER}/address/${agent.owner}`}
                  target="_blank"
                  rel="noreferrer"
                  className="transition-colors duration-200 hover:text-accent"
                >
                  {agent.owner}
                </a>
              </dd>
            </div>
            <div>
              <dt className="font-mono text-[11px] uppercase tracking-[0.18em] text-text-faint">{t("uri")}</dt>
              <dd className="mt-1.5 break-all font-mono text-sm text-text-muted">
                {agent.uri.startsWith("data:") ? (
                  agent.uri.slice(0, 48)
                ) : (
                  <a
                    href={gatewayUrl(agent.uri)}
                    target="_blank"
                    rel="noreferrer"
                    className="transition-colors duration-200 hover:text-accent"
                  >
                    {agent.uri}
                  </a>
                )}
              </dd>
            </div>
          </dl>

          <p className="mt-8 break-all font-mono text-[11px] uppercase tracking-[0.16em] text-text-faint">
            <a
              href={`${MONAD_EXPLORER}/address/${addresses.agentIdentity}`}
              target="_blank"
              rel="noreferrer"
              className="transition-colors duration-200 hover:text-accent"
            >
              {common("explorer")}
            </a>
          </p>
        </section>

        <section className="rise" style={{ animationDelay: "160ms" }}>
          <h2 className="font-display text-2xl uppercase tracking-[0.04em]">{t("reputation.heading")}</h2>
          {reputationError !== null ? (
            <p className="mt-4 max-w-[46ch] text-sm text-failed">
              {t("reputation.error", { reason: reputationError })}
            </p>
          ) : reputation === null || reputation.count === 0n ? (
            <p className="mt-4 max-w-[46ch] text-sm text-text-muted">{t("reputation.empty")}</p>
          ) : (
            <div className="mt-6 flex flex-wrap items-end gap-x-10 gap-y-4">
              <p className="font-display text-[clamp(3rem,9vw,6rem)] leading-[0.85] text-accent">
                {score.toFixed(score % 1 === 0 ? 0 : 1)}
              </p>
              <div className="pb-2">
                <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-text-faint">
                  {t("reputation.score")}
                </p>
                <p className="mt-1 text-sm text-text-muted">
                  {t("reputation.summary", { count: Number(reputation.count) })}
                </p>
              </div>
            </div>
          )}
          <p className="mt-8 break-all font-mono text-[11px] uppercase tracking-[0.16em] text-text-faint">
            {REPUTATION_REGISTRY}
          </p>
        </section>
      </div>
    </article>
  );
}

function Notice({ text, tone }: { text: string; tone?: "failed" }) {
  return (
    <div className="mx-auto w-full max-w-[1400px] px-5 py-24 sm:px-8">
      <p className={tone === "failed" ? "rise max-w-[52ch] text-base text-failed" : "rise max-w-[52ch] text-base text-text-muted"}>
        {text}
      </p>
    </div>
  );
}
