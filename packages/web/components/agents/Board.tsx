import { getTranslations } from "next-intl/server";
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
}: {
  agents: AgentRow[];
  error: string | null;
  locale: string;
}) {
  const t = await getTranslations("agents");

  // Tamil letters carry marks above and below the line, so the tight leading the
  // display face wants in Latin makes two lines touch.
  const leading = locale === "ta" ? "leading-[1.12]" : "leading-[0.86]";

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

        <p className="rise mt-8 flex flex-wrap items-center gap-3" style={{ animationDelay: "180ms" }}>
          <span aria-hidden className="h-px w-8 bg-line-strong" />
          <code className="font-mono text-[10px] uppercase tracking-[0.14em] text-text-faint">{t("formula")}</code>
          <Link
            href={TRUST_DOC}
            className="font-mono text-[10px] uppercase tracking-[0.18em] text-text-muted transition-colors duration-200 hover:text-accent"
          >
            {t("formulaLink")}
          </Link>
        </p>
      </header>

      {error !== null ? (
        <p className="mt-14 max-w-[54ch] text-sm leading-relaxed text-failed">{t("error", { reason: error })}</p>
      ) : agents.length === 0 ? (
        <p className="mt-14 max-w-[54ch] text-sm leading-relaxed text-text-muted">{t("empty")}</p>
      ) : (
        <ul className="mt-14 border-t border-line">
          {agents.map((agent, place) => (
            <Row key={agent.id} agent={agent} place={place} />
          ))}
        </ul>
      )}
    </div>
  );
}
