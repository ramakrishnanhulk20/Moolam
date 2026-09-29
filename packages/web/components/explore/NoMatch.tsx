"use client";

import NextLink from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { useAiWord } from "./aiWord";
import { DEFAULT_SEARCH, exploreHref, type ExploreSearch } from "./query";

/**
 * The words for everything narrowing this sheet other than the search term,
 * which the sentence above them already names.
 *
 * "All" narrows nothing, so it is never named. The Pictures chip is: it is the
 * one that leaves the test images out, and on a slow gateway day it was the
 * reason a sheet came up empty.
 */
export function narrowedBy(
  search: ExploreSearch,
  words: {
    chip: (view: Exclude<ExploreSearch["view"], "all">) => string;
    ai: (ai: NonNullable<ExploreSearch["ai"]>) => string;
    agent: (id: string) => string;
  },
): string[] {
  const named: string[] = [];
  if (search.view !== "all") {
    named.push(words.chip(search.view));
  }
  if (search.ai !== null) {
    named.push(words.ai(search.ai));
  }
  if (search.agent !== null) {
    named.push(words.agent(search.agent));
  }
  return named;
}

/** Whether this is the sheet a bare /explore opens on, where a way back would lead nowhere new. */
export function isOpeningSheet(search: ExploreSearch): boolean {
  return exploreHref(search) === exploreHref(DEFAULT_SEARCH);
}

/** How much of a searched term the sentence repeats before it stops. The box above still holds the whole term. */
export const QUERY_SHOWN = 40;

/** The term as the sentence shows it: trimmed, and cut at a word's worth of room with an ellipsis. */
export function shownTerm(term: string, room = QUERY_SHOWN): string {
  const clean = term.trim();
  return clean.length <= room ? clean : `${clean.slice(0, room - 1).trimEnd()}…`;
}

/** A character no message and no reader types, standing in for the term while the sentence is put together. */
const MARK = "";

/**
 * A sentence split around the one place a value sits in it.
 *
 * Each language puts the term somewhere else in its own sentence, and quotes it
 * differently, so the words either side come from the message and the term is
 * set apart by its face and its ground rather than by quote marks.
 */
export function aroundTerm(sentence: string): [string, string] {
  const at = sentence.indexOf(MARK);
  return at === -1 ? [sentence, ""] : [sentence.slice(0, at), sentence.slice(at + MARK.length)];
}

/**
 * A sheet that matched nothing.
 *
 * It used to be one grey line, "No passport matches this filter yet.", with no
 * word on which filter had narrowed it and no way back. It now says what was
 * asked, shows each chip that narrowed it the way the chip itself looks, and
 * offers the unfiltered Pictures sheet.
 */
export function NoMatch({ search }: { search: ExploreSearch }) {
  const t = useTranslations("explore");
  const locale = useLocale();
  const aiWord = useAiWord();
  const named = narrowedBy(search, {
    chip: (view) => t(`chips.${view}`),
    ai: (ai) => `${t("ai.label")}: ${aiWord(ai)}`,
    agent: (id) => t("agentFilter", { id }),
  });

  const term = search.search.trim();
  const shown = shownTerm(term);
  const [before, after] = aroundTerm(t("noMatchQuery", { query: MARK }));

  return (
    <div data-no-match className="rise mt-12 max-w-[60ch] border-s-2 border-accent ps-5 sm:ps-6">
      <p className="font-display text-xl font-semibold leading-snug tracking-[-0.02em] text-text sm:text-2xl">
        {term === "" ? (
          t("empty")
        ) : (
          <>
            {before}
            <span
              data-no-match-query
              title={shown === term ? undefined : term}
              className="rounded-[4px] bg-bg-sunken px-1.5 py-0.5 font-mono text-[0.72em] font-normal tracking-normal text-text [overflow-wrap:anywhere]"
            >
              {shown}
            </span>
            {after}
          </>
        )}
      </p>

      {named.length === 0 ? null : (
        <ul data-no-match-filters className="mt-4 flex flex-wrap items-center gap-1.5">
          {named.map((word) => (
            <li
              key={word}
              className="rounded-[8px] border border-accent bg-accent-soft px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.18em] text-accent"
            >
              {word}
            </li>
          ))}
        </ul>
      )}

      {isOpeningSheet(search) ? null : (
        // The address comes whole, as ReadFailed's does, so this card does not
        // load the locale-aware router. Every Explore link on the site waits for
        // a press before it is fetched, and this one does too.
        <NextLink
          href={`/${locale}${exploreHref(DEFAULT_SEARCH)}`}
          prefetch={false}
          data-back-to-all
          className="tap group mt-6 inline-flex min-h-[44px] items-center gap-3 rounded-[8px] border border-line-strong px-5 py-3 font-mono text-[11px] uppercase tracking-[0.2em] text-text transition-colors duration-200 hover:border-accent hover:text-accent"
        >
          <span aria-hidden className="inline-block transition-transform duration-200 group-hover:-translate-x-1">
            &larr;
          </span>
          {t("backToAll")}
        </NextLink>
      )}
    </div>
  );
}
