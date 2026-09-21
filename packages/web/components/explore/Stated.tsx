import { getTranslations } from "next-intl/server";
import { SUMMARY_TONES } from "@/components/consent/tones";
import { Link } from "@/lib/i18n/routing";
import type { ExploreAi } from "./query";

/** Where the GraphQL behind this sheet is written out, so a reader can run it themselves. */
const QUERY_DOC = "/docs/api/graphql#example-pictures-open-to-ai-use";

/**
 * What the sheet under an AI-use chip actually is, said in one line.
 *
 * Two of the four chips are answers somebody outside this product wants: the
 * pictures an AI company may train on, and the pictures whose holders have
 * refused. Both are a set rather than a search result, so each one says what it
 * is and where its date comes from, and the open set carries the query behind
 * it. The other two chips need no line: "any" is the registry and "nothing
 * stated" is already the plainest thing on the page.
 */
export async function StatedLine({ ai }: { ai: ExploreAi | null }) {
  if (ai !== "open" && ai !== "closed") {
    return null;
  }

  const t = await getTranslations("explore");

  return (
    <p
      className={`rise mt-8 flex max-w-[70ch] flex-wrap items-baseline gap-x-3 gap-y-2 border-s-2 ps-5 text-sm leading-relaxed text-text-muted sm:mt-10 sm:text-base ${
        SUMMARY_TONES[ai].edge
      }`}
    >
      <span>{t(ai === "open" ? "ai.openLine" : "ai.closedLine")}</span>
      {ai === "open" ? (
        <Link
          href={QUERY_DOC}
          className="tap shrink-0 border-b border-line-strong pb-0.5 font-mono text-[10px] uppercase tracking-[0.18em] text-text transition-colors duration-200 hover:border-accent hover:text-accent"
        >
          {t("ai.openQuery")}
        </Link>
      ) : null}
    </p>
  );
}
