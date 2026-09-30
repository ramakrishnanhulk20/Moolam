"use client";

import { motion } from "framer-motion";
import { useFormatter, useTranslations } from "next-intl";
import { shortHex } from "@/lib/chain/client";
import { Link } from "@/lib/i18n/routing";
import type { HeldPassport, HeldPassports } from "./held";

/**
 * The passports this wallet holds and did not make, under its own work (P25).
 *
 * Silent while the index is read, and silent when it will not answer: the grid
 * above already reads the same index and says so in words, and a second failure
 * line for the same outage would only repeat it. The read is the page's own,
 * shared with the handovers drawn beside the wallet's own pictures.
 */
export function HeldPictures({ held }: { held: HeldPassports }) {
  if (held.status !== "ready" || (held.shown.length === 0 && held.hiddenCount === 0)) {
    return null;
  }
  return <HeldGrid rows={held.shown} hiddenCount={held.hiddenCount} onHide={held.hide} onShowHidden={held.showHidden} />;
}

/** The grid itself, apart from its reads, so a test can draw it from fixture rows. */
export function HeldGrid({
  rows,
  hiddenCount,
  onHide,
  onShowHidden,
}: {
  rows: HeldPassport[];
  hiddenCount: number;
  onHide: (id: string) => void;
  onShowHidden: () => void;
}) {
  const t = useTranslations("mine.held");
  const studio = useTranslations("studio");
  const common = useTranslations("common");
  const kinds = useTranslations("kind");
  const format = useFormatter();

  return (
    <section data-mine-held aria-labelledby="mine-held-heading" className="mt-16 border-t border-dashed border-line-strong pt-10">
      {/* Its own heading, so no held picture ever sits under the page's "made" one (P25). */}
      <h2
        id="mine-held-heading"
        className="font-display text-[clamp(1.6rem,3.2vw,2.6rem)] font-semibold uppercase leading-[0.95] tracking-[-0.03em]"
      >
        {t("heading")}
      </h2>
      {rows.length === 0 ? null : (
        <ul className="mt-8 grid gap-px border border-line bg-line sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {rows.map((row, index) => (
            <motion.li
              key={row.id}
              data-held={row.id}
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, amount: 0.2 }}
              transition={{ duration: 0.6, delay: Math.min(index, 5) * 0.05, ease: [0.16, 1, 0.3, 1] }}
              className="group relative grid grid-cols-[minmax(0,1fr)_auto] grid-rows-[auto_1fr] gap-x-4 bg-bg-raised"
            >
              {/* The link lies on the card's own grid, so Hide takes a column of its own and the title gives way in any language. */}
              <Link href={`/passport/${row.id}`} className="col-[1/-1] row-[1/-1] grid grid-cols-subgrid grid-rows-subgrid">
                <div className="grain relative col-[1/-1] aspect-[4/3] overflow-hidden bg-bg-sunken">
                  {row.imageUrl === undefined ? (
                    <span className="absolute inset-0 flex items-center justify-center font-mono text-[10px] uppercase tracking-[0.2em] text-text-faint">
                      {studio("passports.noThumbnail")}
                    </span>
                  ) : (
                    <img
                      src={row.imageUrl}
                      alt={row.title ?? common("registeredPicture")}
                      loading="lazy"
                      className="h-full w-full object-cover opacity-80 grayscale-[35%] transition duration-500 group-hover:scale-[1.03] group-hover:opacity-100 group-hover:grayscale-0"
                    />
                  )}
                  <div className="scrim pointer-events-none absolute inset-0" />
                  {/* The one line that keeps a gift from reading as the wallet's own work. */}
                  <span
                    data-held-label
                    className="absolute start-3 top-3 flex items-center gap-2 rounded-[4px] border border-line-strong bg-bg/85 px-2 py-1 font-mono text-[10px] uppercase tracking-[0.16em] text-text"
                  >
                    <span aria-hidden className="motif h-[6px] w-[6px] shrink-0" />
                    {t("label")}
                  </span>
                </div>

                <div data-held-text className="min-w-0 py-5 ps-5">
                  <p className="truncate text-sm text-text transition-colors duration-200 group-hover:text-accent">
                    {row.title ?? studio("passports.untitled")}
                  </p>
                  <p className="mt-2 font-mono text-[11px] text-text-faint">{shortHex(row.id, 10, 8)}</p>
                  <p className="mt-1 font-mono text-[11px] text-text-faint">
                    {kinds(String(row.kind))} <span className="mx-1">/</span>
                    {format.dateTime(new Date(Number(row.registeredAt) * 1000), "moment")}
                  </p>
                </div>
              </Link>
              {/* Outside the link, so hiding never opens the passport. */}
              <button
                type="button"
                data-held-hide
                onClick={() => onHide(row.id)}
                className="tap col-start-2 row-start-2 mb-5 me-5 shrink-0 self-end whitespace-nowrap rounded-[8px] border border-line px-3 py-2 font-mono text-[10px] uppercase tracking-[0.18em] text-text-faint transition-colors duration-200 hover:border-accent hover:text-accent"
              >
                {t("hide")}
              </button>
            </motion.li>
          ))}
        </ul>
      )}

      {hiddenCount === 0 ? null : (
        <button
          type="button"
          data-held-show-hidden
          onClick={onShowHidden}
          className={`group/shown inline-flex items-center gap-3 font-mono text-[10px] uppercase tracking-[0.2em] text-text-muted transition-colors duration-200 hover:text-accent ${
            rows.length === 0 ? "mt-6" : "mt-8"
          }`}
        >
          <span
            aria-hidden
            className="h-px w-6 bg-line-strong transition-all duration-300 group-hover/shown:w-10 group-hover/shown:bg-accent"
          />
          {t("showHidden", { count: hiddenCount })}
        </button>
      )}
    </section>
  );
}
