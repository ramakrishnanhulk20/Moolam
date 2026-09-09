import { getFormatter, getTranslations } from "next-intl/server";
import { REPUTATION_REGISTRY, MONAD_EXPLORER, shortHex } from "@/lib/chain/client";
import type { GeneratorRecord } from "@/lib/data/passports";

export interface Reputation {
  count: bigint;
  value: bigint;
  decimals: number;
}

/**
 * How this agent has held up, from the two places that keep count.
 *
 * The left number is written on chain by whoever left feedback, read back
 * through the canonical ERC-8004 reputation registry. The right one is the
 * index's own arithmetic over the re-checks and disputes it has seen. They are
 * kept apart on purpose: one is a claim someone signed, the other is a
 * calculation, and a reader deserves to know which is which.
 */
export async function Standing({
  reputation,
  reputationError,
  record,
  recordError,
  locale,
}: {
  reputation: Reputation | null;
  reputationError: string | null;
  record: GeneratorRecord | null;
  recordError: string | null;
  locale: string;
}) {
  const t = await getTranslations("agent");
  const format = await getFormatter({ locale });
  const score = reputation === null ? 0 : Number(reputation.value) / 10 ** reputation.decimals;

  return (
    <section className="border-b border-line bg-bg-raised">
      <div className="mx-auto grid w-full max-w-[1400px] gap-14 px-5 py-14 sm:px-8 sm:py-20 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] lg:gap-20">
        <div className="rise">
          <h2 className="font-mono text-[11px] uppercase tracking-[0.28em] text-text-faint">
            {t("reputation.heading")}
          </h2>

          {reputationError !== null ? (
            <p className="mt-6 max-w-[46ch] text-sm leading-relaxed text-failed">
              {t("reputation.error", { reason: reputationError })}
            </p>
          ) : reputation === null || reputation.count === 0n ? (
            <p className="mt-6 max-w-[46ch] text-sm leading-relaxed text-text-muted">{t("reputation.empty")}</p>
          ) : (
            <div className="mt-6 flex flex-wrap items-end gap-x-10 gap-y-4">
              <p className="font-display text-[clamp(3rem,8vw,5.5rem)] font-semibold leading-[0.82] tracking-[-0.05em] tabular-nums text-accent">
                {score.toFixed(score % 1 === 0 ? 0 : 1)}
              </p>
              <div className="pb-2">
                <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-text-faint">
                  {t("reputation.score")}
                </p>
                <p className="mt-1.5 text-sm text-text-muted">
                  {t("reputation.summary", { count: Number(reputation.count) })}
                </p>
              </div>
            </div>
          )}

          <p className="mt-8 max-w-[46ch] text-sm leading-relaxed text-text-muted">{t("reputation.body")}</p>
          <a
            href={`${MONAD_EXPLORER}/address/${REPUTATION_REGISTRY}`}
            target="_blank"
            rel="noreferrer"
            className="mt-4 inline-block font-mono text-[10px] uppercase tracking-[0.18em] text-text-faint transition-colors duration-200 hover:text-accent"
          >
            {t("reputation.registry", { address: shortHex(REPUTATION_REGISTRY) })}
          </a>
        </div>

        <div className="rise lg:border-s lg:border-line lg:ps-16" style={{ animationDelay: "90ms" }}>
          <h2 className="font-mono text-[11px] uppercase tracking-[0.28em] text-text-faint">{t("index.heading")}</h2>

          {recordError !== null ? (
            <p className="mt-6 max-w-[46ch] text-sm leading-relaxed text-failed">
              {t("index.error", { reason: recordError })}
            </p>
          ) : record === null ? (
            <p className="mt-6 max-w-[46ch] text-sm leading-relaxed text-text-muted">{t("index.empty")}</p>
          ) : (
            <>
              <div className="mt-6 flex flex-wrap items-end gap-x-10 gap-y-4">
                <p className="font-display text-[clamp(3rem,8vw,5.5rem)] font-semibold leading-[0.82] tracking-[-0.05em] tabular-nums text-text">
                  {record.trustScore}
                </p>
                <div className="pb-2">
                  <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-text-faint">
                    {t("index.trustScore")}
                  </p>
                  <p className="mt-1.5 max-w-[34ch] text-sm text-text-muted">{t("index.trustScoreBody")}</p>
                </div>
              </div>

              <dl className="mt-10 grid grid-cols-2 gap-x-8 gap-y-6 border-t border-line pt-7 sm:grid-cols-4">
                <Count label={t("index.passportCount")} value={record.passportCount} />
                <Count label={t("index.matchedCount")} value={record.matchedCount} tone="verified" />
                <Count label={t("index.mismatchedCount")} value={record.mismatchedCount} tone="failed" />
                <Count label={t("index.disputesUpheld")} value={record.disputesUpheld} tone="failed" />
              </dl>

              <p className="mt-8 font-mono text-[10px] uppercase tracking-[0.18em] text-text-faint">
                {t("index.since", {
                  when: format.dateTime(new Date(Number(record.firstSeenAt) * 1000), { dateStyle: "medium" }),
                })}
              </p>
            </>
          )}
        </div>
      </div>
    </section>
  );
}

function Count({ label, value, tone }: { label: string; value: number; tone?: "verified" | "failed" }) {
  const colour = value === 0 ? "text-text-faint" : tone === "verified" ? "text-verified" : tone === "failed" ? "text-failed" : "text-text";
  return (
    <div className="min-w-0">
      <dt className="font-mono text-[10px] uppercase tracking-[0.2em] text-text-faint">{label}</dt>
      <dd className={`mt-2 font-display text-2xl tabular-nums ${colour}`}>{value}</dd>
    </div>
  );
}
