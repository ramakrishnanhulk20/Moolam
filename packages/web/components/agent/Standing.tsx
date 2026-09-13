import { getFormatter, getTranslations } from "next-intl/server";
import { REPUTATION_REGISTRY, MONAD_EXPLORER, shortHex } from "@/lib/chain/client";
import type { GeneratorRecord } from "@/lib/data/passports";

export interface Reputation {
  count: bigint;
  value: bigint;
  decimals: number;
}

/**
 * How this agent has held up.
 *
 * Two numbers exist and only one may be the headline, or a reader has to decide
 * which to believe. The trust score is the headline: it is calculated from
 * re-checks that matched, re-checks that did not and any upheld dispute, and
 * the formula is published. The reputation registry's average sits under it as
 * a secondary line, labelled as what it is: a claim somebody signed and wrote
 * on chain, which is a different kind of thing from a calculation.
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
      <div className="mx-auto grid w-full max-w-[1400px] gap-14 px-5 py-14 sm:px-8 sm:py-20 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)] lg:gap-20">
        <div className="rise">
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
                <p className="font-display text-[clamp(3.4rem,10vw,7rem)] font-semibold leading-[0.82] tracking-[-0.05em] tabular-nums text-accent">
                  {record.trustScore}
                </p>
                <div className="pb-3">
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

        <div className="rise lg:border-s lg:border-line lg:ps-16" style={{ animationDelay: "90ms" }}>
          <h2 className="font-mono text-[11px] uppercase tracking-[0.28em] text-text-faint">
            {t("reputation.heading")}
          </h2>
          <p className="mt-4 max-w-[40ch] font-mono text-[10px] uppercase tracking-[0.18em] text-text-muted">
            {t("reputation.secondary")}
          </p>

          {reputationError !== null ? (
            <p className="mt-6 max-w-[46ch] text-sm leading-relaxed text-failed">
              {t("reputation.error", { reason: reputationError })}
            </p>
          ) : reputation === null || reputation.count === 0n ? (
            <p className="mt-6 max-w-[46ch] text-sm leading-relaxed text-text-muted">{t("reputation.empty")}</p>
          ) : (
            <p className="mt-6 flex flex-wrap items-baseline gap-x-4 gap-y-1">
              <span className="font-display text-3xl font-semibold tabular-nums tracking-[-0.02em] text-text">
                {score.toFixed(score % 1 === 0 ? 0 : 1)}
              </span>
              <span className="font-mono text-[11px] uppercase tracking-[0.2em] text-text-faint">
                {t("reputation.score")}
              </span>
              <span className="text-sm text-text-muted">
                {t("reputation.summary", { count: Number(reputation.count) })}
              </span>
            </p>
          )}

          <p className="mt-7 max-w-[46ch] text-sm leading-relaxed text-text-muted">{t("reputation.body")}</p>
          <a
            href={`${MONAD_EXPLORER}/address/${REPUTATION_REGISTRY}`}
            target="_blank"
            rel="noreferrer"
            className="mt-4 inline-block font-mono text-[10px] uppercase tracking-[0.18em] text-text-muted transition-colors duration-200 hover:text-accent"
          >
            {t("reputation.registry", { address: shortHex(REPUTATION_REGISTRY) })}
          </a>
        </div>
      </div>
    </section>
  );
}

function Count({ label, value, tone }: { label: string; value: number; tone?: "verified" | "failed" }) {
  const colour =
    value === 0 ? "text-text-muted" : tone === "verified" ? "text-verified" : tone === "failed" ? "text-failed" : "text-text";
  return (
    <div className="min-w-0">
      <dt className="font-mono text-[10px] uppercase tracking-[0.2em] text-text-faint">{label}</dt>
      <dd className={`mt-2 font-display text-2xl tabular-nums ${colour}`}>{value}</dd>
    </div>
  );
}
