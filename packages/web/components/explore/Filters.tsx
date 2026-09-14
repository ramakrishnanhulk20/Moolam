"use client";

import { useTranslations } from "next-intl";
import { Link, useRouter } from "@/lib/i18n/routing";
import { PICTURE_VIEWS, RECORD_VIEWS, exploreHref, type ExploreSearch, type ExploreView } from "./query";

/**
 * The chips and the search box.
 *
 * Two groups with a hairline between them: which half of the registry is on the
 * sheet, then what the record says. The page opens on the first chip of the
 * first group, so the test cards the scripts wrote are one press away and never
 * the first thing a reader sees.
 *
 * Every chip is a real link carrying the whole state of the page, so a filtered
 * view can be copied out of the address bar, and the browser's back button walks
 * back through the filters a reader tried. The box is a form: typing does not
 * fire a query per keystroke at the index.
 */
export function Filters({ search }: { search: ExploreSearch }) {
  const t = useTranslations("explore");
  const router = useRouter();

  return (
    <div className="mt-10 flex flex-col gap-5 border-y border-line py-5 lg:flex-row lg:items-center lg:justify-between">
      <nav aria-label={t("chipsLabel")} className="-mx-1 flex flex-wrap items-center gap-1.5">
        {PICTURE_VIEWS.map((view) => (
          <Chip key={view} view={view} search={search} label={t(`chips.${view}`)} />
        ))}
        <span aria-hidden className="mx-1.5 hidden h-4 w-px bg-line-strong sm:block" />
        {RECORD_VIEWS.map((view) => (
          <Chip key={view} view={view} search={search} label={t(`chips.${view}`)} />
        ))}
        {search.agent === null ? null : (
          <Link
            href={exploreHref({ ...search, agent: null })}
            className="ms-1 flex items-center gap-2 rounded-[8px] border border-accent px-3 py-2 font-mono text-[10px] uppercase tracking-[0.18em] text-accent transition-colors duration-200 hover:border-line-strong hover:text-text-muted"
          >
            {t("agentFilter", { id: search.agent })}
            <span aria-hidden>x</span>
            <span className="sr-only">{t("clearAgent")}</span>
          </Link>
        )}
      </nav>

      <form
        role="search"
        onSubmit={(event) => {
          event.preventDefault();
          const typed = new FormData(event.currentTarget).get("q");
          router.push(exploreHref({ ...search, search: typeof typed === "string" ? typed.trim() : "" }));
        }}
        className="flex items-center gap-2"
      >
        <label htmlFor="explore-search" className="sr-only">
          {t("searchLabel")}
        </label>
        {/* Uncontrolled, and keyed by the term in the URL: a chip is a navigation,
            and the box has to follow it rather than keep a word the grid is no
            longer filtered by. */}
        <input
          key={search.search}
          id="explore-search"
          name="q"
          defaultValue={search.search}
          placeholder={t("searchPlaceholder")}
          spellCheck={false}
          autoComplete="off"
          className="w-full min-w-0 rounded-[8px] border border-line bg-bg-raised px-4 py-2.5 font-mono text-[12px] text-text outline-none transition-colors duration-200 placeholder:text-text-faint hover:border-line-strong focus:border-accent lg:w-[22rem]"
        />
        <button
          type="submit"
          className="rounded-[8px] border border-line-strong px-4 py-2.5 font-mono text-[10px] uppercase tracking-[0.18em] text-text transition-colors duration-200 hover:border-accent hover:text-accent"
        >
          {t("searchAction")}
        </button>
      </form>
    </div>
  );
}

function Chip({ view, search, label }: { view: ExploreView; search: ExploreSearch; label: string }) {
  const on = search.view === view;

  return (
    <Link
      href={exploreHref({ ...search, view })}
      aria-current={on ? "true" : undefined}
      className={`rounded-[8px] border px-3.5 py-2 font-mono text-[10px] uppercase tracking-[0.18em] transition-colors duration-200 ${
        on
          ? "border-accent bg-accent-soft text-accent"
          : "border-line text-text-muted hover:border-line-strong hover:text-text"
      }`}
    >
      {label}
    </Link>
  );
}
