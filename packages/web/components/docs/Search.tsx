"use client";

import { AnimatePresence, MotionConfig, motion } from "framer-motion";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useHeldFocus } from "@/lib/docs/focus";
import type { SearchEntry } from "@/lib/docs/search";
import { loadSearchIndex } from "@/lib/docs/searchIndex";
import { useRouter } from "@/lib/i18n/routing";

type Row = { key: string; href: string; title: string; note: string; kind: "page" | "heading" };

function words(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .filter((word) => word.length > 1);
}

function snippet(text: string, word: string): string {
  const at = text.toLowerCase().indexOf(word);
  if (at === -1) {
    return text.slice(0, 120);
  }
  const from = Math.max(0, at - 50);
  return `${from === 0 ? "" : "..."}${text.slice(from, from + 130).trim()}...`;
}

function rank(entries: SearchEntry[], query: string): Row[] {
  const asked = words(query);
  if (asked.length === 0) {
    return [];
  }

  const hits = entries
    .map((entry) => {
      const title = entry.title.toLowerCase();
      const text = entry.text.toLowerCase();
      const headings = entry.headings.map((heading) => ({ ...heading, lower: heading.text.toLowerCase() }));
      let score = 0;
      for (const word of asked) {
        const inTitle = title.includes(word);
        const inHeading = headings.some((heading) => heading.lower.includes(word));
        const inText = text.includes(word);
        // Every word has to land somewhere on the page, or it is not this page.
        if (!inTitle && !inHeading && !inText) {
          return null;
        }
        score += (inTitle ? 8 : 0) + (inHeading ? 4 : 0) + (inText ? 1 : 0);
      }
      const best = headings.filter((heading) => asked.some((word) => heading.lower.includes(word))).slice(0, 3);
      return { entry, score, best };
    })
    .filter((hit): hit is NonNullable<typeof hit> => hit !== null)
    .sort((one, two) => two.score - one.score)
    .slice(0, 6);

  const rows: Row[] = [];
  for (const hit of hits) {
    rows.push({
      key: hit.entry.slug,
      href: hit.entry.href,
      title: hit.entry.title,
      note: snippet(hit.entry.text, asked[0]),
      kind: "page",
    });
    for (const heading of hit.best) {
      rows.push({
        key: `${hit.entry.slug}#${heading.id}`,
        href: `${hit.entry.href}#${heading.id}`,
        title: heading.text,
        note: hit.entry.title,
        kind: "heading",
      });
    }
  }
  return rows;
}

/**
 * Every word in the docs, matched in the browser.
 *
 * The index is one file built with the site and fetched the first time the box
 * is wanted, so nothing a reader types is sent anywhere and the whole thing
 * works with no search service behind it. Until that file is here the box gives
 * no verdict: "Nothing found" is only ever said about the whole index.
 */
export function DocsSearch() {
  const t = useTranslations("docs");
  const common = useTranslations("common");
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<SearchEntry[] | null>(null);
  const [query, setQuery] = useState("");
  const [at, setAt] = useState(0);
  const field = useRef<HTMLInputElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);

  const load = useCallback(() => {
    loadSearchIndex().then(setEntries, () => {
      // Left unloaded, so the next open or keystroke asks again.
    });
  }, []);

  const close = useCallback(() => setOpen(false), []);
  useHeldFocus({ open, panel, opener, onClose: close });

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen(true);
        load();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [load]);

  useEffect(() => {
    if (open) {
      field.current?.focus();
    }
  }, [open]);

  const rows = useMemo(() => (entries === null ? [] : rank(entries, query)), [entries, query]);
  const active = rows.length === 0 ? -1 : Math.min(at, rows.length - 1);

  function go(row: Row | undefined) {
    if (row === undefined) {
      return;
    }
    setOpen(false);
    setQuery("");
    router.push(row.href);
  }

  return (
    <>
      <button
        ref={opener}
        type="button"
        onClick={() => {
          setOpen(true);
          load();
        }}
        onFocus={load}
        onMouseEnter={load}
        className="tap group flex w-full items-center gap-2 rounded-[8px] border border-line bg-bg-sunken px-3 py-2 text-left text-[13px] text-text-faint transition-colors duration-200 hover:border-accent hover:text-accent sm:w-64"
      >
        <span aria-hidden className="motif h-[7px] w-[7px] shrink-0 opacity-70" />
        <span className="truncate">{t("search")}</span>
        <span className="ml-auto hidden font-mono text-[10px] uppercase tracking-[0.16em] text-text-faint sm:inline">
          {t("shortcut")}
        </span>
      </button>

      {/* Less motion keeps the fade and drops the rise and the scale. */}
      <MotionConfig reducedMotion="user">
        <AnimatePresence>
          {open ? (
            <motion.div
              className="fixed inset-0 z-[60] flex items-start justify-center px-4 pt-[10vh]"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.18 }}
            >
              <button
                type="button"
                aria-label={t("close")}
                onClick={close}
                className="absolute inset-0 cursor-default bg-bg/85 backdrop-blur-sm"
              />
              <motion.div
                ref={panel}
                role="dialog"
                aria-modal="true"
                aria-label={t("search")}
                initial={{ opacity: 0, y: 18, scale: 0.985 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 8, scale: 0.99 }}
                transition={{ duration: 0.24, ease: [0.16, 1, 0.3, 1] }}
                className="grain relative w-full max-w-[640px] overflow-hidden rounded-[8px] border border-line-strong bg-bg-raised shadow-2xl"
              >
                <div className="flex items-center gap-3 border-b border-line px-4">
                  <span aria-hidden className="motif h-[9px] w-[9px]" />
                  <input
                    ref={field}
                    value={query}
                    onChange={(event) => {
                      setQuery(event.target.value);
                      setAt(0);
                      if (entries === null) {
                        load();
                      }
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "ArrowDown") {
                        event.preventDefault();
                        setAt((was) => Math.min(was + 1, rows.length - 1));
                      }
                      if (event.key === "ArrowUp") {
                        event.preventDefault();
                        setAt((was) => Math.max(was - 1, 0));
                      }
                      if (event.key === "Enter") {
                        event.preventDefault();
                        go(rows[active]);
                      }
                    }}
                    placeholder={t("searchPlaceholder")}
                    className="w-full bg-transparent py-4 text-base text-text outline-none placeholder:text-text-faint"
                  />
                </div>

                <div className="max-h-[54vh] overflow-y-auto">
                  {query !== "" && entries === null ? (
                    <p role="status" className="px-4 py-6 font-mono text-[12px] uppercase tracking-[0.18em] text-text-faint">
                      {common("loading")}
                    </p>
                  ) : null}
                  {query !== "" && entries !== null && rows.length === 0 ? (
                    <p role="status" className="px-4 py-6 text-sm text-text-faint">
                      {t("noResults")}
                    </p>
                  ) : null}
                  {rows.map((row, index) => (
                    <button
                      key={row.key}
                      type="button"
                      onMouseEnter={() => setAt(index)}
                      onClick={() => go(row)}
                      className={`flex w-full flex-col gap-1 border-b border-line px-4 py-3 text-left transition-colors duration-150 ${
                        index === active ? "bg-accent-soft" : ""
                      }`}
                    >
                      <span
                        className={
                          row.kind === "page"
                            ? "font-display text-sm font-semibold text-text"
                            : "text-sm text-text-muted"
                        }
                      >
                        {row.kind === "heading" ? "# " : ""}
                        {row.title}
                      </span>
                      <span className="docs-clamp font-mono text-[12px] leading-relaxed text-text-faint">{row.note}</span>
                    </button>
                  ))}
                </div>
              </motion.div>
            </motion.div>
          ) : null}
        </AnimatePresence>
      </MotionConfig>
    </>
  );
}
