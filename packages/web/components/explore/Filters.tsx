"use client";

import { useLinkStatus } from "next/link";
import { useTranslations } from "next-intl";
import { useEffect, useTransition } from "react";
import { Link, useRouter } from "@/lib/i18n/routing";
import { useReading } from "./Reading";
import { PICTURE_VIEWS, RECORD_VIEWS, exploreHref, type ExploreSearch, type ExploreView } from "./query";

/**
 * The chips, the search box, and the line that says what the three marks on a
 * plate mean.
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
  const { reading, hold } = useReading();
  const [searching, startSearching] = useTransition();

  // The search box is a push rather than a link, so it says it is working the
  // same way a chip does instead of leaving the reader to guess.
  useEffect(() => (searching ? hold() : undefined), [searching, hold]);

  return (
    <div className="mt-6 border-y border-line py-4 sm:mt-10 sm:py-5">
      <div className="flex flex-col gap-4 sm:gap-5 lg:flex-row lg:items-center lg:justify-between">
        {/* Nine chips wrapped onto four rows at 375 px and took a third of the
            first screen, which is the screen the pictures are meant to be on. On a
            phone they are one row that scrolls sideways, bleeding to both edges so
            it reads as a row that carries on. From 640 px they wrap as before. */}
        <nav
          aria-label={t("chipsLabel")}
          className="-mx-5 flex flex-nowrap items-center gap-1.5 overflow-x-auto overscroll-x-contain px-5 [scrollbar-width:none] sm:-mx-1 sm:flex-wrap sm:overflow-x-visible sm:px-1"
        >
          {PICTURE_VIEWS.map((view) => (
            <Chip key={view} view={view} search={search} label={t(`chips.${view}`)} />
          ))}
          <span aria-hidden className="mx-1.5 hidden h-4 w-px shrink-0 bg-line-strong sm:block" />
          {RECORD_VIEWS.map((view) => (
            <Chip key={view} view={view} search={search} label={t(`chips.${view}`)} />
          ))}
          {search.agent === null ? null : (
            <Link
              href={exploreHref({ ...search, agent: null })}
              className="tap ms-1 flex min-h-[44px] shrink-0 items-center gap-2 rounded-[8px] border border-accent px-3 py-2 font-mono text-[10px] uppercase tracking-[0.18em] text-accent transition-colors duration-200 hover:border-line-strong hover:text-text-muted sm:min-h-0"
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
            startSearching(() => {
              router.push(exploreHref({ ...search, search: typeof typed === "string" ? typed.trim() : "" }));
            });
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
            className="min-h-[44px] w-full min-w-0 rounded-[8px] border border-line bg-bg-raised px-4 py-2.5 font-mono text-[12px] text-text outline-none transition-colors duration-200 placeholder:text-text-faint hover:border-line-strong focus:border-accent lg:w-[22rem]"
          />
          <button
            type="submit"
            className={`relative min-h-[44px] rounded-[8px] border px-4 py-2.5 font-mono text-[10px] uppercase tracking-[0.18em] transition-colors duration-200 ${
              searching
                ? "border-accent text-text-faint"
                : "border-line-strong text-text hover:border-accent hover:text-accent"
            }`}
          >
            {t("searchAction")}
            {searching ? (
              <>
                <span aria-hidden className="motif absolute end-1 top-1 h-[5px] w-[5px] animate-pulse" />
                <span className="sr-only">{t("reading")}</span>
              </>
            ) : null}
          </button>
        </form>
      </div>

      {/* The three letters on a plate, said in words. A title never fires under
          a thumb, so on a phone they were three unexplained letters. The row
          keeps its height whether or not the sheet is being read, so nothing on
          the page moves when the mark lights. */}
      <div className="mt-4 flex flex-wrap items-center justify-between gap-x-6 gap-y-2 font-mono text-[10px] uppercase tracking-[0.18em] text-text-faint sm:mt-5">
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
          <span>
            <span className="text-accent">M</span> {t("legend.manifest")}
          </span>
          <span aria-hidden>&middot;</span>
          <span>
            <span className="text-verified">R</span> {t("legend.rechecked")}
          </span>
          <span aria-hidden>&middot;</span>
          <span>
            <span className="text-failed">D</span> {t("legend.disputed")}
          </span>
        </p>

        <p
          aria-hidden={!reading}
          className={`flex items-center gap-2 text-accent transition-opacity duration-200 ${
            reading ? "opacity-100" : "opacity-0"
          }`}
        >
          <span aria-hidden className="motif h-[6px] w-[6px] animate-pulse" />
          {t("reading")}
        </p>
      </div>
    </div>
  );
}

function Chip({ view, search, label }: { view: ExploreView; search: ExploreSearch; label: string }) {
  const on = search.view === view;

  return (
    <Link
      href={exploreHref({ ...search, view })}
      aria-current={on ? "true" : undefined}
      className={`tap inline-flex min-h-[44px] shrink-0 items-center rounded-[8px] border px-3.5 py-2 font-mono text-[10px] uppercase tracking-[0.18em] transition-colors duration-200 sm:min-h-0 ${
        on
          ? "border-accent bg-accent-soft text-accent"
          : "border-line text-text-muted hover:border-line-strong hover:text-text"
      }`}
    >
      <ChipLabel label={label} />
    </Link>
  );
}

/**
 * The label of one chip, and the mark it carries while the sheet it asked for
 * is being read.
 *
 * It is a child of the link rather than the link itself because that is where
 * the router says whether this navigation is the one in flight. Nothing here
 * changes the size of anything: the label fades and the mark is pinned over the
 * corner, so a row of nine chips does not move when one of them is pressed.
 */
function ChipLabel({ label }: { label: string }) {
  const t = useTranslations("explore");
  const { pending } = useLinkStatus();
  const { hold } = useReading();

  useEffect(() => (pending ? hold() : undefined), [pending, hold]);

  return (
    <>
      <span className={`transition-opacity duration-200 ${pending ? "opacity-40" : "opacity-100"}`}>{label}</span>
      {pending ? (
        <>
          <span aria-hidden className="motif absolute end-1 top-1 h-[5px] w-[5px] animate-pulse" />
          <span className="sr-only">{t("reading")}</span>
        </>
      ) : null}
    </>
  );
}
