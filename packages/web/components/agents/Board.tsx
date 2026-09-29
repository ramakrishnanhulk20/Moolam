import { getTranslations } from "next-intl/server";
import { IndexRetry } from "@/components/IndexRetry";
import { FailureDetails } from "@/components/studio/FailureDetails";
import { ToolOpening } from "@/components/studio/ToolOpening";
import { WarningMark } from "@/components/WarningMark";
import { withoutReason } from "@/lib/i18n/reason";
import { Link } from "@/lib/i18n/routing";
import { Row } from "./Row";
import type { AgentRow } from "./roster";
import type { AgentStrip } from "./strip";

/** Where the formula behind the trust score is written out in full. */
const TRUST_DOC = "/docs/developers/envio-indexer#the-trust-score";

/**
 * Every generating agent the index has seen, the busiest first.
 *
 * Nothing on this page is placed by hand: the order is the passport count, which
 * is why the two demo agents lead it. An index that will not answer says so, and
 * an index with nothing in it says that instead of showing an empty ruled page.
 *
 * `strips` is each agent's newest pictures by id. Null when that read failed,
 * which costs the pictures and nothing else: every row still stands on its
 * number.
 */
export async function Board({
  agents,
  error,
  locale,
  strips = null,
}: {
  agents: AgentRow[];
  error: string | null;
  locale: string;
  strips?: Record<string, AgentStrip> | null;
}) {
  const t = await getTranslations("agents");

  // The formula led this page in capitals once, which is the one thing about a
  // trust score nobody can read at a glance. The sentence leads now and the
  // arithmetic waits under it for whoever wants it.
  const formula = (
    <details className="rise group mt-4 max-w-[58ch] border-t border-line pt-3" style={{ animationDelay: "240ms" }}>
      <summary className="flex cursor-pointer list-none items-center gap-3 font-mono text-[10px] uppercase tracking-[0.18em] text-text-muted transition-colors duration-200 hover:text-accent [&::-webkit-details-marker]:hidden">
        <span
          aria-hidden
          className="h-px w-8 bg-line-strong transition-all duration-300 group-open:w-12 group-hover:bg-accent"
        />
        {t("formulaHow")}
      </summary>

      <div className="mt-5 flex flex-col items-start gap-4 border-s border-line ps-5">
        <p className="text-base leading-relaxed text-text-muted">{t("formulaPlain")}</p>
        <code className="block font-mono text-[12px] leading-relaxed text-text">{t("formula")}</code>
        <Link
          href={TRUST_DOC}
          className="font-mono text-[10px] uppercase tracking-[0.18em] text-text-muted transition-colors duration-200 hover:text-accent"
        >
          {t("formulaDoc")}
        </Link>
      </div>
    </details>
  );

  const list =
    error !== null ? (
      <div className="mt-14 max-w-[54ch]">
        <p className="flex items-start gap-2.5 text-base leading-relaxed text-failed">
          <WarningMark className="mt-[3px]" />
          <span className="min-w-0">{withoutReason((reason) => t("error", { reason }))}</span>
        </p>
        <FailureDetails reason={error} className="ms-[24px] mt-2" />
        <IndexRetry said={error} />
      </div>
    ) : agents.length === 0 ? (
      <p className="mt-14 max-w-[54ch] text-base leading-relaxed text-text-muted">{t("empty")}</p>
    ) : (
      <ul>
        {agents.map((agent, place) => (
          <Row key={agent.id} agent={agent} place={place} strip={strips?.[agent.id] ?? null} />
        ))}
      </ul>
    );

  // The explaining lines stand beside the title instead of under it, so the
  // first agent's line and its trust score start inside a laptop's first
  // screen. The rule under the opening is the top of the ledger.
  return (
    <div className="mx-auto w-full max-w-[1400px] px-5 py-8 sm:px-8 sm:py-10">
      <ToolOpening
        kicker={t("kicker")}
        title={t("title")}
        locale={locale}
        aside={
          <div
            data-agents-explainer
            className="rise max-w-[54ch] text-base leading-relaxed text-text-muted lg:justify-self-end"
            style={{ animationDelay: "120ms" }}
          >
            <p>{t("lede")}</p>
            <p className="mt-2">{t("scoreMeaning")}</p>
            {formula}
          </div>
        }
      />
      {list}
    </div>
  );
}
