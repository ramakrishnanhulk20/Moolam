import { getTranslations } from "next-intl/server";
import { IndexRetry } from "@/components/IndexRetry";
import type { Opening } from "@/components/studio/opening";
import { ToolOpening } from "@/components/studio/ToolOpening";
import { Link } from "@/lib/i18n/routing";
import { Row } from "./Row";
import type { AgentRow } from "./roster";

/** Where the formula behind the trust score is written out in full. */
const TRUST_DOC = "/docs/developers/envio-indexer#the-trust-score";

/**
 * Every generating agent the index has seen, the busiest first.
 *
 * Nothing on this page is placed by hand: the order is the passport count, which
 * is why the two demo agents lead it. An index that will not answer says so, and
 * an index with nothing in it says that instead of showing an empty ruled page.
 */
export async function Board({
  agents,
  error,
  locale,
  opening = "full",
}: {
  agents: AgentRow[];
  error: string | null;
  locale: string;
  opening?: Opening;
}) {
  const t = await getTranslations("agents");

  // Tamil letters carry marks above and below the line, so the tight leading the
  // display face wants in Latin makes two lines touch.
  const leading = locale === "ta" ? "leading-[1.12]" : "leading-[0.86]";

  const formula = (
    <details
      className={`rise group max-w-[58ch] border-t border-line ${opening === "compact" ? "mt-4 pt-3" : "mt-8 pt-5"}`}
      style={{ animationDelay: "240ms" }}
    >
      <summary className="flex cursor-pointer list-none items-center gap-3 font-mono text-[10px] uppercase tracking-[0.18em] text-text-muted transition-colors duration-200 hover:text-accent [&::-webkit-details-marker]:hidden">
        <span
          aria-hidden
          className="h-px w-8 bg-line-strong transition-all duration-300 group-open:w-12 group-hover:bg-accent"
        />
        {t("formulaHow")}
      </summary>

      <div className="mt-5 flex flex-col items-start gap-4 border-s border-line ps-5">
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
        <p className="text-sm leading-relaxed text-failed">{t("error", { reason: error })}</p>
        <IndexRetry said={error} />
      </div>
    ) : agents.length === 0 ? (
      <p className="mt-14 max-w-[54ch] text-sm leading-relaxed text-text-muted">{t("empty")}</p>
    ) : (
      <ul className={opening === "compact" ? "" : "mt-14 border-t border-line"}>
        {agents.map((agent, place) => (
          <Row key={agent.id} agent={agent} place={place} />
        ))}
      </ul>
    );

  if (opening === "compact") {
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
              className="rise max-w-[60ch] text-sm leading-relaxed text-text-muted lg:justify-self-end"
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

  return (
    <div className="mx-auto w-full max-w-[1400px] px-5 py-16 sm:px-8 sm:py-24">
      <header className="relative">
        <span
          aria-hidden
          className="pointer-events-none absolute right-0 top-16 hidden select-none font-mono text-[11px] uppercase tracking-[0.4em] text-text-faint lg:block"
          style={{ writingMode: "vertical-rl" }}
        >
          {t("rail")}
        </span>

        <p className="rise flex items-center gap-3 font-mono text-[11px] uppercase tracking-[0.28em] text-accent">
          <span className="motif h-[10px] w-[10px]" />
          {t("kicker")}
        </p>

        <h1
          className={`rise mt-6 max-w-[12ch] font-display text-[clamp(2.6rem,8.5vw,6.5rem)] font-semibold uppercase tracking-[-0.035em] ${leading}`}
          style={{ animationDelay: "60ms" }}
        >
          {t("title")}
        </h1>

        <p
          className="rise mt-7 max-w-[54ch] text-base leading-relaxed text-text-muted sm:text-lg"
          style={{ animationDelay: "120ms" }}
        >
          {t("lede")}
        </p>

        {/* The formula led this page in capitals, which is the one thing about
            a trust score nobody can read at a glance. The sentence leads now
            and the arithmetic waits under it for whoever wants it. */}
        <p
          className="rise mt-6 max-w-[58ch] text-base leading-relaxed text-text-muted"
          style={{ animationDelay: "180ms" }}
        >
          {t("scoreMeaning")}
        </p>

        {formula}
      </header>

      {list}
    </div>
  );
}
