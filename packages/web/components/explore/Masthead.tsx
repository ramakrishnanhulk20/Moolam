import { getTranslations } from "next-intl/server";
import { FailureDetails } from "@/components/studio/FailureDetails";
import { WarningMark } from "@/components/WarningMark";
import type { RegistryCounts } from "@/lib/data/passports";
import { withoutReason } from "@/lib/i18n/reason";
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
  // A phone gets a short opening so the first pictures reach its first screen.
  // Every phone class here is paired with an sm value, and those draw the
  // tablet's masthead from 640 px up.
  //
  // From 768 px the page opens the way Verify does: the title on one row and
  // the counts as one strip, so the whole first row of pictures is on a
  // tablet's and a laptop's first screen. Under the poster-size title a 768 by
  // 1024 tablet started those pictures below the fold. The lede sits under the
  // title on a tablet and beside it from 1024 px, where there is room for both.

  const sortLine = (
    <p className="mt-2 flex flex-wrap items-center gap-3 font-mono text-[10px] uppercase tracking-[0.2em] text-text-faint sm:mt-10 md:mt-0">
      <span aria-hidden className="h-px w-8 bg-line-strong" />
      {isMixedView(view) ? t("sortRule") : t("sortNewest")}
    </p>
  );

  // Tamil letters carry marks above and below the line, so the tight leading the
  // display face wants in Latin makes two lines touch.
  const leading = locale === "ta" ? "leading-[1.12]" : "leading-[0.86] md:leading-[0.92]";

  return (
    <header className="relative">
      <div
        data-opening="compact"
        className="max-w-[54ch] md:max-w-none md:border-b md:border-line md:pb-6 lg:grid lg:grid-cols-2 lg:items-end lg:gap-x-12"
      >
        <div>
          <p className="rise flex items-center gap-3 font-mono text-[11px] uppercase tracking-[0.28em] text-accent">
            <span className="motif h-[10px] w-[10px]" />
            {t("kicker")}
            {/* The rail stood on its side down the poster's right edge. The
                compact opening has no free edge, so it follows the kicker. */}
            <span aria-hidden className="hidden items-center gap-3 text-text-faint md:inline-flex">
              <span className="h-px w-6 bg-line-strong" />
              {t("rail")}
            </span>
          </p>

          <h1
            className={`rise mt-2.5 max-w-[11ch] font-display text-[clamp(1.75rem,8vw,2.25rem)] font-semibold uppercase tracking-[-0.035em] sm:mt-6 sm:text-[clamp(2.4rem,8.5vw,6.5rem)] md:mt-3 md:max-w-none md:whitespace-nowrap md:text-[3rem] ${leading}`}
            style={{ animationDelay: "60ms" }}
          >
            {t("title")}
          </h1>
        </div>

        <p
          className="rise mt-2.5 max-w-[52ch] text-base leading-relaxed text-text-muted sm:mt-7 sm:text-lg md:mt-3 md:text-base lg:mt-0 lg:max-w-[56ch] lg:justify-self-end"
          style={{ animationDelay: "120ms" }}
        >
          {t("lede")}
        </p>
      </div>

      <div
        data-counts-strip
        className="mt-2.5 sm:mt-10 md:mt-5 md:flex md:flex-wrap md:items-baseline md:gap-x-4 md:gap-y-2"
      >
        {countsError !== null || counts === null ? (
          <div
            className="rise max-w-[60ch] border-t border-line pt-5 sm:pt-6 md:max-w-none md:flex-1 md:border-t-0 md:pt-0"
            style={{ animationDelay: "180ms" }}
          >
            <p className="flex items-start gap-2.5 text-base leading-relaxed text-failed">
              <WarningMark className="mt-[5px]" />
              <span className="min-w-0">
                {countsError === null
                  ? t("countsError", { reason: t("countsMissing") })
                  : withoutReason((reason) => t("countsError", { reason }))}
              </span>
            </p>
            {countsError === null ? null : <FailureDetails reason={countsError} className="ms-[24px] mt-2" />}
          </div>
        ) : (
          <div
            className="rise sm:border-t sm:border-line sm:pt-6 md:flex md:flex-1 md:flex-wrap md:items-baseline md:gap-x-8 md:gap-y-2 md:border-t-0 md:pt-0"
            style={{ animationDelay: "180ms" }}
          >
            {/* On a phone the four counts are one line, the way the split
                under them already is, so the pictures reach the first screen. */}
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
            {/* Four across from 640 px, so a five word label never has to fit
                in a quarter of 400 px, and one strip of figures from 768 px. */}
            <dl
              data-counts-grid
              className="hidden gap-x-6 gap-y-5 sm:grid sm:grid-cols-4 md:flex md:flex-wrap md:items-baseline md:gap-x-8 md:gap-y-2"
            >
              <Count label={t("counts.total")} value={counts.total} lead />
              <Count label={t("counts.generated")} value={counts.generated} capped={counts.capped} />
              <Count label={t("counts.rechecked")} value={counts.rechecked} capped={counts.capped} />
              {/* The index keeps this one as a counter of its own, so it is a
                  total rather than a floor. Where it did not answer it, the
                  figure is left out: a zero would say nobody has spoken. */}
              {counts.stated === null ? null : <Count label={t("counts.stated")} value={counts.stated} />}
            </dl>

            {/* The split and the order travel together: where they do not fit
                beside the figures they take one line under them. Apart, the All
                chip's longer order line pushed the split under the figures at
                1440 px and the figures onto two lines at 1024 px. */}
            <div data-counts-tail className="md:ms-auto md:flex md:flex-wrap md:items-center md:gap-x-6 md:gap-y-2">
              {split === null ? null : (
                <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[10px] uppercase tracking-[0.18em] text-text-faint sm:mt-5 md:mt-0">
                  <span className="text-accent">{t("split.real", { count: split.real })}</span>
                  <span aria-hidden className="h-[9px] w-px bg-line-strong" />
                  <span>
                    {split.capped
                      ? t("split.testCapped", { count: split.test, scanned: split.scanned })
                      : t("split.test", { count: split.test })}
                  </span>
                </p>
              )}
              {sortLine}
            </div>
          </div>
        )}

        {countsError !== null || counts === null ? sortLine : null}
      </div>
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
    <div className="min-w-0 md:flex md:items-baseline md:gap-2.5">
      <dd
        className={`font-display font-semibold tabular-nums tracking-[-0.04em] md:text-[1.9rem] md:leading-none ${
          lead ? "text-[clamp(2.4rem,6vw,4rem)] leading-[0.85] text-accent" : "text-[clamp(1.6rem,4vw,2.6rem)] leading-[0.9] text-text"
        }`}
      >
        {capped === true ? `${value}+` : value}
      </dd>
      <dt className="mt-2 font-mono text-[10px] uppercase tracking-[0.18em] text-text-faint sm:mt-3 md:mt-0">{label}</dt>
    </div>
  );
}
