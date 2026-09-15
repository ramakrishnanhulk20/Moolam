"use client";

import { motion } from "framer-motion";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { useIsReducedMotion } from "@/components/motion/useIsReducedMotion";
import type { PassportCursor } from "@/lib/data/passports";
import { morePlates } from "./load";
import { Plate } from "./Plate";
import type { ExploreSearch } from "./query";
import { mergePlates, sortPlates, type ExplorePlate } from "./sort";

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
    return <p className="mt-12 max-w-[54ch] text-sm leading-relaxed text-failed">{t("error", { reason: indexError })}</p>;
  }

  if (plates.length === 0) {
    return <p className="mt-12 max-w-[54ch] text-sm leading-relaxed text-text-muted">{t("empty")}</p>;
  }

  return (
    <>
      <ul className="mt-6 grid grid-cols-2 gap-px border border-line bg-line sm:mt-10 sm:grid-cols-3 xl:grid-cols-4">
        {plates.map((plate, index) => (
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
        ))}
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
        <p className="mt-6 max-w-[54ch] text-sm leading-relaxed text-failed">{t("error", { reason: problem })}</p>
      )}
    </>
  );
}
