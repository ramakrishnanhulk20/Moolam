import { getFormatter, getTranslations } from "next-intl/server";
import { REPUTATION_REGISTRY, MONAD_EXPLORER, shortHex } from "@/lib/chain/client";
import type { GeneratorRecord } from "@/lib/data/passports";
import { Link } from "@/lib/i18n/routing";

/** Where the formula behind the trust score is written out in full, as on the Agents page. */
const TRUST_DOC = "/docs/developers/envio-indexer#the-trust-score";

export interface Reputation {
  count: bigint;
  value: bigint;
  decimals: number;
}

/**
 * How this agent has held up.
 *
 * Two numbers exist and only one may be the headline, or a reader has to decide
 * which to believe. The trust score is the headline, and it is the same index
 * row the home story and the Agents page show, with the formula linked beside
 * it. What the reputation registry holds is kept in its own block and named for
 * what it is: feedback somebody signed and wrote on chain, counted in entries,
 * never mixed into the re-check score.
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
  const latest = reputation === null ? 0 : Number(reputation.value) / 10 ** reputation.decimals;

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

              <p className="mt-8 flex flex-wrap items-center gap-3">
                <span aria-hidden className="h-px w-8 bg-line-strong" />
                <code className="font-mono text-[10px] uppercase tracking-[0.14em] text-text-faint">
                  {t("index.formula")}
                </code>
                <Link
                  href={TRUST_DOC}
                  className="font-mono text-[10px] uppercase tracking-[0.18em] text-text-muted transition-colors duration-200 hover:text-accent"
                >
                  {t("index.formulaLink")}
                </Link>
              </p>

              <p className="mt-5 font-mono text-[10px] uppercase tracking-[0.18em] text-text-faint">
                {t("index.since", {
                  when: format.dateTime(new Date(Number(record.firstSeenAt) * 1000), { dateStyle: "medium" }),
                })}
              </p>
            </>
          )}
        </div>

        <div className="rise lg:border-s lg:border-line lg:ps-16" style={{ animationDelay: "90ms" }}>
          <h2 className="max-w-[26ch] font-mono text-[11px] uppercase leading-relaxed tracking-[0.28em] text-text-faint">
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
              <span className="font-mono text-[11px] uppercase tracking-[0.2em] text-text">
                {t("reputation.entries", { count: Number(reputation.count) })}
              </span>
              <span aria-hidden className="h-px w-6 self-center bg-line-strong" />
              <span className="font-display text-3xl font-semibold tabular-nums tracking-[-0.02em] text-text">
                {latest.toFixed(latest % 1 === 0 ? 0 : 1)}
              </span>
              <span className="font-mono text-[11px] uppercase tracking-[0.2em] text-text-faint">
                {t("reputation.latest")}
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
