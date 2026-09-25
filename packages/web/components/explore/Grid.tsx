"use client";

import { motion } from "framer-motion";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { IndexRetry } from "@/components/IndexRetry";
import { useIsReducedMotion } from "@/components/motion/useIsReducedMotion";
import type { PassportCursor } from "@/lib/data/passports";
import { EndCard } from "./EndCard";
import { morePlates } from "./load";
import { Plate } from "./Plate";
import type { ExploreSearch } from "./query";
import { useReading } from "./Reading";
import { mergePlates, sortPlates, type ExplorePlate } from "./sort";

/**
 * How many plates are drawn without waiting for the browser to run the page.
 * The grid is two columns on a phone and four at its widest, so this covers the
 * first row on any screen, which is the only row a reader sees before scrolling.
 */
const FIRST_ROW = 4;

/**
 * How many of those pictures are named in the head of the page as well, so the
 * browser fetches them before it has read the grid. Two, not four: two is the
 * first row on a phone and the only pictures certain to be on screen before a
 * scroll, and anything named here is pulled down ahead of the one the paint is
 * actually waiting for.
 */
const NAMED_EARLY = 2;

/**
 * The contact sheet: every passport the filter matched, as plates on a grid of
 * hairlines.
 *
 * The first page is rendered on the server so the sheet is on screen before any
 * script arrives. This component exists for the button under it: "Load more"
 * asks the server for the next page from the cursor and drops it in without
 * taking the reader back to the top.
 */
export function Grid({
  first,
  cursor,
  search,
  indexError,
}: {
  first: ExplorePlate[];
  cursor: PassportCursor | null;
  search: ExploreSearch;
  indexError: string | null;
}) {
  const t = useTranslations("explore");
  const reduced = useIsReducedMotion();
  const { reading } = useReading();
  const [plates, setPlates] = useState(() => sortPlates(first));
  const [next, setNext] = useState(cursor);
  const [problem, setProblem] = useState<string | null>(null);
  const [pending, startLoading] = useTransition();

  const loadMore = () => {
    startLoading(async () => {
      const answer = await morePlates({ ...search, cursor: next });
      if (!answer.ok) {
        setProblem(answer.error);
        return;
      }
      setProblem(null);
      setPlates((held) => mergePlates(held, answer.plates));
      setNext(answer.cursor);
    });
  };

  if (indexError !== null) {
    return (
      <div className="mt-12 max-w-[54ch]">
        <p className="text-sm leading-relaxed text-failed">{t("error", { reason: indexError })}</p>
        <IndexRetry said={indexError} />
      </div>
    );
  }

  if (plates.length === 0) {
    return <p className="mt-12 max-w-[54ch] text-sm leading-relaxed text-text-muted">{t("empty")}</p>;
  }

  return (
    <>
      {/* While a chip is being read the sheet under it is the old one, so it
          steps back rather than pretending to be the answer. Opacity only:
          nothing moves, and the reduced-motion rule in globals.css cuts the
          fade to nothing. */}
      <ul
        className={`mt-6 grid grid-cols-2 gap-px border border-line bg-line transition-opacity duration-300 sm:mt-10 sm:grid-cols-3 xl:grid-cols-4 ${
          reading ? "opacity-60" : "opacity-100"
        }`}
      >
        {plates.map((plate, index) =>
          index < FIRST_ROW ? (
            // A motion component holds its plate at opacity 0 in the served HTML
            // until the browser has downloaded and run the page, which on a phone
            // left the first picture painted 4.8 seconds after it had arrived.
            // The row that is already on screen enters with the CSS rise the rest
            // of the server-drawn site uses, staggered the same way, so it is
            // visible in the first paint and still arrives rather than appears.
            <li
              key={plate.id}
              className="rise min-w-0 bg-bg-raised"
              style={{ animationDelay: `${index * 70}ms` }}
            >
              <Plate plate={plate} first={index < NAMED_EARLY} />
            </li>
          ) : (
            <motion.li
              key={plate.id}
              initial={reduced ? false : { opacity: 0, y: 26 }}
              whileInView={reduced ? undefined : { opacity: 1, y: 0 }}
              viewport={{ once: true, margin: "-40px" }}
              transition={{ duration: 0.55, ease: [0.16, 1, 0.3, 1], delay: (index % 8) * 0.045 }}
              className="min-w-0 bg-bg-raised"
            >
              <Plate plate={plate} />
            </motion.li>
          ),
        )}
        <EndCard count={plates.length} />
      </ul>

      <div className="mt-10 flex flex-wrap items-center gap-x-6 gap-y-4">
        {next === null ? (
          <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-text-faint">{t("end")}</p>
        ) : (
          <button
            type="button"
            onClick={loadMore}
            disabled={pending}
            className="rounded-[8px] border border-line-strong px-6 py-3 font-mono text-[11px] uppercase tracking-[0.2em] text-text transition-colors duration-200 hover:border-accent hover:text-accent disabled:cursor-wait disabled:text-text-faint"
          >
            {pending ? t("loading") : t("loadMore")}
          </button>
        )}
        <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-text-faint">
          {t("shown", { count: plates.length })}
        </p>
      </div>

      {problem === null ? null : (
        <div className="mt-6 max-w-[54ch]">
          <p className="text-sm leading-relaxed text-failed">{t("error", { reason: problem })}</p>
          {/* The next page knows how to fetch itself, so the retry asks the
              action again rather than redrawing the whole sheet and losing the
              pages already under the reader. */}
          <IndexRetry said={problem} again={loadMore} />
        </div>
      )}
    </>
  );
}
