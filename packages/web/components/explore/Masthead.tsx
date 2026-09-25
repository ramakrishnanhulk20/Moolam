import { getTranslations } from "next-intl/server";
import type { RegistryCounts } from "@/lib/data/passports";
import type { PictureSplit } from "./plates";
import { isMixedView, type ExploreView } from "./query";
import type { Opening } from "@/components/studio/opening";

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
  opening = "full",
}: {
  locale: string;
  counts: RegistryCounts | null;
  countsError: string | null;
  split: PictureSplit | null;
  view: ExploreView;
  opening?: Opening;
}) {
  const t = await getTranslations("explore");
  // The compact opening is a phone change only. Every class it swaps is paired
  // with the sm value today's page already has, so from 640 px up the two
  // openings draw the same page.
  const compact = opening === "compact";

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

      <div
        className={`grid gap-x-16 sm:gap-y-10 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,0.75fr)] lg:items-end ${
          compact ? "gap-y-3" : "gap-y-7"
        }`}
      >
        <div className="max-w-[54ch]">
          <p className="rise flex items-center gap-3 font-mono text-[11px] uppercase tracking-[0.28em] text-accent">
            <span className="motif h-[10px] w-[10px]" />
            {t("kicker")}
          </p>

          <h1
            className={`rise max-w-[11ch] font-display font-semibold uppercase tracking-[-0.035em] sm:mt-6 sm:text-[clamp(2.4rem,8.5vw,6.5rem)] ${leading} ${
              compact ? "mt-2.5 text-[clamp(1.75rem,8vw,2.25rem)]" : "mt-4 text-[clamp(2.4rem,8.5vw,6.5rem)]"
            }`}
            style={{ animationDelay: "60ms" }}
          >
            {t("title")}
          </h1>

          <p
            className={`rise max-w-[52ch] leading-relaxed text-text-muted sm:mt-7 sm:text-lg ${
              compact ? "mt-2.5 text-sm" : "mt-5 text-base"
            }`}
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
            className={`rise sm:border-t sm:border-line sm:pt-6 lg:border-t-0 lg:border-s lg:border-line lg:pt-0 lg:ps-12 ${
              compact ? "" : "border-t border-line pt-5"
            }`}
            style={{ animationDelay: "180ms" }}
          >
            {/* On a phone under the compact opening the four counts are one
                line, the way the split under them already is, so the pictures
                reach the first screen. */}
            {compact ? (
              <p
                data-counts-line
                className="flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[10px] uppercase tracking-[0.16em] text-text-faint sm:hidden"
              >
                <CountWord value={counts.total} label={t("counts.total")} lead />
                <span aria-hidden>&middot;</span>
                <CountWord value={counts.generated} label={t("counts.generated")} capped={counts.capped} />
                <span aria-hidden>&middot;</span>
                <CountWord value={counts.rechecked} label={t("counts.rechecked")} capped={counts.capped} />
                {counts.stated === null ? null : (
                  <>
                    <span aria-hidden>&middot;</span>
                    <CountWord value={counts.stated} label={t("counts.stated")} />
                  </>
                )}
              </p>
            ) : null}
            {/* Two up on a phone and again in the narrow column beside the
                title, four across in between, so a five word label never has to
                fit in a quarter of 400 px. */}
            <dl
              className={`gap-x-6 gap-y-5 sm:grid sm:grid-cols-4 lg:grid-cols-2 ${compact ? "hidden" : "grid grid-cols-2"}`}
            >
              <Count label={t("counts.total")} value={counts.total} lead />
              <Count label={t("counts.generated")} value={counts.generated} capped={counts.capped} />
              <Count label={t("counts.rechecked")} value={counts.rechecked} capped={counts.capped} />
              {/* The index keeps this one as a counter of its own, so it is a
                  total rather than a floor. Where it did not answer it, the
                  figure is left out: a zero would say nobody has spoken. */}
              {counts.stated === null ? null : <Count label={t("counts.stated")} value={counts.stated} />}
            </dl>

            {split === null ? null : (
              <p
                className={`flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[10px] uppercase tracking-[0.18em] text-text-faint sm:mt-5 ${
                  compact ? "mt-1.5" : "mt-4"
                }`}
              >
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

      <p
        className={`flex flex-wrap items-center gap-3 font-mono text-[10px] uppercase tracking-[0.2em] text-text-faint sm:mt-10 ${
          compact ? "mt-3" : "mt-6"
        }`}
      >
        <span aria-hidden className="h-px w-8 bg-line-strong" />
        {isMixedView(view) ? t("sortRule") : t("sortNewest")}
      </p>
    </header>
  );
}

/** One count in the phone's single line: the figure in ink, the word after it. */
function CountWord({ value, label, lead, capped }: { value: number; label: string; lead?: boolean; capped?: boolean }) {
  return (
    <span>
      <span className={`tabular-nums ${lead ? "text-accent" : "text-text"}`}>{capped === true ? `${value}+` : value}</span>{" "}
      {label}
    </span>
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
