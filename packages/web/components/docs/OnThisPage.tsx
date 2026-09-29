"use client";

import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import type { Heading } from "@/lib/docs/tree";

/**
 * The page's own contents, tracking the part being read.
 *
 * The tracking is an observer rather than a scroll handler, so nothing runs
 * while the page sits still. The rail is the desktop shape; the fold is the same
 * list above the page on a narrow window, where there is no room beside it.
 * A page with a table of four or more columns shows the fold at every width
 * instead of the rail, so the table has the rail's room and never passes over
 * the list: the docs-rail and docs-fold rules in globals.css do the swap.
 */
export function OnThisPage({ headings, variant }: { headings: Heading[]; variant: "rail" | "fold" }) {
  const t = useTranslations("docs");
  const [here, setHere] = useState<string | null>(headings[0]?.id ?? null);

  useEffect(() => {
    if (headings.length === 0) {
      return;
    }
    const seen = new Set<string>();
    const watcher = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            seen.add(entry.target.id);
          } else {
            seen.delete(entry.target.id);
          }
        }
        const first = headings.find((heading) => seen.has(heading.id));
        if (first !== undefined) {
          setHere(first.id);
        }
      },
      // The band is the top third of the window: a heading counts as the one
      // being read once it has climbed past the header and before it leaves.
      { rootMargin: "-15% 0px -66% 0px", threshold: 0 },
    );
    for (const heading of headings) {
      const target = document.getElementById(heading.id);
      if (target !== null) {
        watcher.observe(target);
      }
    }
    return () => watcher.disconnect();
  }, [headings]);

  if (headings.length === 0) {
    return null;
  }

  const list = (
    <ul className="docs-contents space-y-1">
      {headings.map((heading) => (
        <li key={heading.id}>
          <a
            href={`#${heading.id}`}
            className={`block border-l py-1 text-[12px] leading-snug transition-all duration-200 hover:translate-x-[2px] hover:text-accent ${
              heading.depth === 3 ? "pl-6" : "pl-3"
            } ${here === heading.id ? "border-accent text-accent" : "border-line text-text-faint"}`}
          >
            {heading.text}
          </a>
        </li>
      ))}
    </ul>
  );

  if (variant === "fold") {
    return (
      <details className="docs-fold mb-10 rounded-[8px] border border-line bg-bg-raised px-4 py-3 xl:hidden">
        <summary className="cursor-pointer font-mono text-[10px] uppercase tracking-[0.2em] text-text-faint transition-colors duration-200 hover:text-accent">
          {t("onThisPage")}
        </summary>
        <div className="mt-3">{list}</div>
      </details>
    );
  }

  return (
    <aside className="docs-rail hidden xl:block">
      <div className="sticky top-[calc(var(--docs-top,4rem)+3.5rem)] max-h-[calc(100dvh-var(--docs-top,4rem)-6rem)] overflow-y-auto pt-[7.5rem]">
        <p className="mb-3 font-mono text-[10px] uppercase tracking-[0.2em] text-text-faint">{t("onThisPage")}</p>
        {list}
      </div>
    </aside>
  );
}
