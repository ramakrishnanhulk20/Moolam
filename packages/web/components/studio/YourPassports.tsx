"use client";

import { motion } from "framer-motion";
import { useFormatter, useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { WarningMark } from "@/components/WarningMark";
import { shortHex } from "@/lib/chain/client";
import { Link } from "@/lib/i18n/routing";
import type { CreatorPassports } from "@/lib/studio/useCreatorPassports";
import { useWide, wideOnly } from "./layout";
import { useHeadingLeading } from "./leading";
import { FailureDetails } from "./FailureDetails";
import { hasPassportEnd, passportEnd, passportEndClasses } from "./passportsEnd";

/**
 * Everything this account has registered, read from the index rather than from
 * anything this session remembers. An account with nothing in it says so in
 * words, and never shows a placeholder row.
 *
 * The heading is the caller's to choose: the studio wears it as a section at
 * the foot of a working screen, and /mine wears it under a page whose whole
 * subject it already is, so the two want different words over the same grid.
 *
 * Under the wide studio the grid runs four across on a wide laptop and carries
 * its own Load more, the same press /mine puts under its copy of this grid, and
 * a short last row is closed by one quiet cell rather than grey gaps.
 */
export function YourPassports({
  passports,
  heading,
  lead,
  empty,
}: {
  passports: CreatorPassports;
  heading?: string;
  /**
   * A page whose whole subject is this grid already has its title and its
   * hairline above it, so it passes the row that heads the grid instead: the
   * display heading and the second rule are left out and the heading stays for
   * a screen reader only.
   */
  lead?: ReactNode;
  /** The way on from an account with nothing in it yet. */
  empty?: ReactNode;
}) {
  const t = useTranslations("studio");
  const common = useTranslations("common");
  const leading = useHeadingLeading("leading-[0.95]", "leading-[1.15]");
  const kinds = useTranslations("kind");
  const format = useFormatter();
  const wide = useWide();
  const onPage = lead !== undefined;

  return (
    <section
      data-studio-passports={wide ? "wide" : undefined}
      data-passports-on-page={onPage ? "" : undefined}
      className={
        onPage
          ? ""
          : `mt-24 border-t border-line pt-10 sm:mt-32${wideOnly(wide, "lg:mt-14 lg:border-t-0 lg:pt-0")}`
      }
    >
      {onPage ? (
        <>
          <h2 className="sr-only">{heading ?? t("passports.heading")}</h2>
          <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
            {lead}
            <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-text-faint">{t("passports.source")}</p>
          </div>
        </>
      ) : (
        <div className="flex flex-wrap items-end justify-between gap-4">
          <h2 className={`font-display text-[clamp(1.6rem,3.2vw,2.6rem)] uppercase tracking-[-0.02em] ${leading}`}>
            {heading ?? t("passports.heading")}
          </h2>
          <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-text-faint">{t("passports.source")}</p>
        </div>
      )}

      {passports.status === "reading" ? (
        <ReadingOutlines wide={wide} words={t("passports.reading")} />
      ) : passports.status === "unreadable" ? (
        <div role="alert" data-passports-unreadable className="mt-8 max-w-[54ch]">
          <p className="flex items-start gap-2.5 text-base leading-relaxed text-failed">
            <WarningMark className="mt-[5px]" />
            <span className="min-w-0">{t("passports.unreadable")}</span>
          </p>
          <button
            type="button"
            onClick={passports.refresh}
            data-passports-retry
            className="ms-[23px] mt-4 rounded-[8px] border border-line px-4 py-2 text-[11px] uppercase tracking-[0.18em] text-text-muted transition-colors duration-200 hover:border-accent hover:text-accent"
          >
            {t("passports.retry")}
          </button>
          {passports.error === null ? null : <FailureDetails reason={passports.error} className="ms-[23px] mt-4" />}
        </div>
      ) : passports.passports.length === 0 ? (
        <div className="mt-8">
          <p className="max-w-[54ch] text-base leading-relaxed text-text-muted">{t("passports.empty")}</p>
          {empty}
        </div>
      ) : (
        <ul
          className={`mt-10 grid gap-px border border-line bg-line sm:grid-cols-2 lg:grid-cols-3${wideOnly(wide, "xl:grid-cols-4")}`}
        >
          {passports.passports.map((passport, index) => (
            <motion.li
              key={passport.id}
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, amount: 0.2 }}
              transition={{ duration: 0.6, delay: Math.min(index, 5) * 0.05, ease: [0.16, 1, 0.3, 1] }}
              className="group bg-bg-raised"
            >
              <Link href={`/passport/${passport.id}`} className="block">
                <div className="grain relative aspect-[4/3] overflow-hidden bg-bg-sunken">
                  {passport.imageUrl === undefined ? (
                    <span className="absolute inset-0 flex items-center justify-center font-mono text-[10px] uppercase tracking-[0.2em] text-text-faint">
                      {t("passports.noThumbnail")}
                    </span>
                  ) : (
                    // The pinned thumbnail, the same file a verifier fetches when it re-checks this image.
                    <img
                      src={passport.imageUrl}
                      alt={passport.title ?? common("registeredPicture")}
                      loading="lazy"
                      className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-[1.03]"
                    />
                  )}
                  <div className="scrim pointer-events-none absolute inset-0" />
                </div>

                <div className="p-5">
                  <p className="truncate text-sm text-text transition-colors duration-200 group-hover:text-accent">
                    {passport.title ?? t("passports.untitled")}
                  </p>
                  <p className="mt-2 font-mono text-[11px] text-text-faint">{shortHex(passport.id, 10, 8)}</p>
                  <p className="mt-1 font-mono text-[11px] text-text-faint">
                    {kinds(String(passport.kind))} <span className="mx-1">/</span>
                    {format.dateTime(new Date(Number(passport.registeredAt) * 1000), "moment")}
                  </p>
                </div>
              </Link>
            </motion.li>
          ))}
          {wide ? <PassportsEnd count={passports.passports.length} /> : null}
        </ul>
      )}

      {wide ? <LoadMore passports={passports} /> : null}
    </section>
  );
}

/**
 * The grid's shape while the index is asked, so the page does not jump when
 * the cards arrive. Two outlines on a phone, a full row from lg, four across
 * on the wide studio's widest laptop, matching the grid they stand in for.
 */
function ReadingOutlines({ wide, words }: { wide: boolean; words: string }) {
  const cells = ["", "", "hidden lg:block", wide ? "hidden xl:block" : null];

  return (
    <div data-passports-reading aria-busy="true" className="mt-8">
      <p role="status" className="text-base leading-relaxed text-text-muted">
        {words}
      </p>
      <ul
        aria-hidden
        className={`mt-6 grid gap-px border border-line bg-line sm:grid-cols-2 lg:grid-cols-3${wideOnly(wide, "xl:grid-cols-4")}`}
      >
        {cells.map((shown, index) =>
          shown === null ? null : (
            <li key={index} data-outline className={`bg-bg-raised ${shown}`.trim()}>
              <div className="grain relative aspect-[4/3] animate-pulse bg-bg-sunken motion-reduce:animate-none" />
              <div className="p-5">
                <span className="block h-3 w-2/3 bg-line" />
                <span className="mt-3 block h-2.5 w-1/2 bg-line" />
                <span className="mt-2 block h-2.5 w-1/3 bg-line" />
              </div>
            </li>
          ),
        )}
      </ul>
    </div>
  );
}

/**
 * The cells a short last row leaves empty, taken by one plain raised cell with
 * the grain and the mark, so the grid always closes as a clean rectangle. It
 * spans exactly the empty cells at each column count and is not drawn where the
 * row is full. It says nothing: there is nothing true to put there.
 */
function PassportsEnd({ count }: { count: number }) {
  const end = passportEnd(count);
  if (!hasPassportEnd(end)) {
    return null;
  }

  return (
    <motion.li
      aria-hidden
      data-passports-end
      initial={{ opacity: 0 }}
      whileInView={{ opacity: 1 }}
      viewport={{ once: true, amount: 0.2 }}
      transition={{ duration: 0.6, delay: 0.12, ease: [0.16, 1, 0.3, 1] }}
      className={`${passportEndClasses(end)} relative min-h-[4rem] overflow-hidden bg-bg-raised`}
    >
      <span className="grain pointer-events-none absolute inset-0" />
      <span className="motif absolute start-5 top-5 h-[7px] w-[7px] opacity-40" />
    </motion.li>
  );
}

/**
 * The next page of this account's passports, under the wide studio's grid.
 *
 * It says it is working on its own face, and a page that would not come back is
 * reported on the same line with the cards already read left where they are.
 * The words are the Explore grid's, as they are on /mine.
 */
function LoadMore({ passports }: { passports: CreatorPassports }) {
  const t = useTranslations("explore");
  const studio = useTranslations("studio");

  if (passports.status !== "ready" || !passports.hasMore) {
    return null;
  }

  return (
    <div className="mt-10 flex flex-wrap items-center gap-x-6 gap-y-4">
      <button
        type="button"
        onClick={passports.more}
        disabled={passports.loadingMore}
        aria-busy={passports.loadingMore}
        data-load-more
        className="rounded-[8px] border border-line-strong px-6 py-3 font-mono text-[11px] uppercase tracking-[0.2em] text-text transition-colors duration-200 hover:border-accent hover:text-accent disabled:cursor-wait disabled:text-text-faint"
      >
        {passports.loadingMore ? t("loading") : t("loadMore")}
      </button>
      {passports.moreError === null ? null : (
        // The same shape as the grid's own failure above: the sentence in the
        // reader's language, and the index's English only in the fold.
        <div className="max-w-[54ch]">
          <p role="alert" className="flex items-start gap-2.5 text-base leading-relaxed text-failed">
            <WarningMark className="mt-[5px]" />
            <span className="min-w-0">{studio("passports.unreadable")}</span>
          </p>
          <FailureDetails reason={passports.moreError} className="ms-[23px] mt-3" />
        </div>
      )}
    </div>
  );
}
