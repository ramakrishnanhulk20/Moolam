import { getTranslations } from "next-intl/server";
import type { RegistryCounts } from "@/lib/data/passports";
import type { PictureSplit } from "./plates";
import { isMixedView, type ExploreView } from "./query";

/**
 * The head of the page: what this list is, how big the registry is, how it
 * divides between pictures and test cards, and the one line that says how it is
 * ordered.
 *
 * The three counts are the whole index however the grid is filtered. The line
 * under them is the split, so a reader on the pictures chip can see what the
 * other chip holds without pressing it. The sort rule is printed rather than
 * implied, and on a chip that can mix the two it still says the test cards
 * sort last.
 */
export async function Masthead({
  locale,
  counts,
  countsError,
  split,
  view,
}: {
  locale: string;
  counts: RegistryCounts | null;
  countsError: string | null;
  split: PictureSplit | null;
  view: ExploreView;
}) {
  const t = await getTranslations("explore");

  // Tamil letters carry marks above and below the line, so the tight leading the
  // display face wants in Latin makes two lines touch.
  const leading = locale === "ta" ? "leading-[1.12]" : "leading-[0.86]";

  return (
    <header className="relative">
      <span
        aria-hidden
        className="pointer-events-none absolute right-0 top-16 hidden select-none font-mono text-[11px] uppercase tracking-[0.4em] text-text-faint lg:block"
        style={{ writingMode: "vertical-rl" }}
      >
        {t("rail")}
      </span>

      <div className="grid gap-x-16 gap-y-7 sm:gap-y-10 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,0.75fr)] lg:items-end">
        <div className="max-w-[54ch]">
          <p className="rise flex items-center gap-3 font-mono text-[11px] uppercase tracking-[0.28em] text-accent">
            <span className="motif h-[10px] w-[10px]" />
            {t("kicker")}
          </p>

          <h1
            className={`rise mt-4 max-w-[11ch] font-display text-[clamp(2.4rem,8.5vw,6.5rem)] font-semibold uppercase tracking-[-0.035em] sm:mt-6 ${leading}`}
            style={{ animationDelay: "60ms" }}
          >
            {t("title")}
          </h1>

          <p
            className="rise mt-5 max-w-[52ch] text-base leading-relaxed text-text-muted sm:mt-7 sm:text-lg"
            style={{ animationDelay: "120ms" }}
          >
            {t("lede")}
          </p>
        </div>

        {countsError !== null || counts === null ? (
          <p
            className="rise max-w-[40ch] border-t border-line pt-5 text-sm leading-relaxed text-failed sm:pt-6 lg:border-t-0 lg:border-s lg:border-line lg:pt-0 lg:ps-12"
            style={{ animationDelay: "180ms" }}
          >
            {t("countsError", { reason: countsError ?? t("countsMissing") })}
          </p>
        ) : (
          <div
            className="rise border-t border-line pt-5 sm:pt-6 lg:border-t-0 lg:border-s lg:border-line lg:pt-0 lg:ps-12"
            style={{ animationDelay: "180ms" }}
          >
            <dl className="grid grid-cols-3 gap-x-6 gap-y-2">
              <Count label={t("counts.total")} value={counts.total} lead />
              <Count label={t("counts.generated")} value={counts.generated} capped={counts.capped} />
              <Count label={t("counts.rechecked")} value={counts.rechecked} capped={counts.capped} />
            </dl>

            {split === null ? null : (
              <p className="mt-4 flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[10px] uppercase tracking-[0.18em] text-text-faint sm:mt-5">
                <span className="text-accent">{t("split.real", { count: split.real })}</span>
                <span aria-hidden className="h-[9px] w-px bg-line-strong" />
                <span>
                  {split.capped
                    ? t("split.testCapped", { count: split.test, scanned: split.scanned })
                    : t("split.test", { count: split.test })}
                </span>
              </p>
            )}
          </div>
        )}
      </div>

      <p className="mt-6 flex flex-wrap items-center gap-3 font-mono text-[10px] uppercase tracking-[0.2em] text-text-faint sm:mt-10">
        <span aria-hidden className="h-px w-8 bg-line-strong" />
        {isMixedView(view) ? t("sortRule") : t("sortNewest")}
      </p>
    </header>
  );
}

function Count({ label, value, lead, capped }: { label: string; value: number; lead?: boolean; capped?: boolean }) {
  return (
    <div className="min-w-0">
      <dd
        className={`font-display font-semibold tabular-nums tracking-[-0.04em] ${
          lead ? "text-[clamp(2.4rem,6vw,4rem)] leading-[0.85] text-accent" : "text-[clamp(1.6rem,4vw,2.6rem)] leading-[0.9] text-text"
        }`}
      >
        {capped === true ? `${value}+` : value}
      </dd>
      <dt className="mt-2 font-mono text-[10px] uppercase tracking-[0.18em] text-text-faint sm:mt-3">{label}</dt>
    </div>
  );
}
