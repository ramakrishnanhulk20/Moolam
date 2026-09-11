"use client";

import { motion } from "framer-motion";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { pageHref } from "@/lib/docs/links";
import { navLabel, type NavEntry, type NavPage } from "@/lib/docs/tree";
import { Link, usePathname } from "@/lib/i18n/routing";

function Item({
  page,
  active,
  onGo,
}: {
  page: NavPage;
  active: boolean;
  onGo?: () => void;
}) {
  return (
    <li className="relative">
      {active ? (
        <motion.span
          layoutId="docs-tree-mark"
          className="absolute left-0 top-1 bottom-1 w-[2px] rounded-full bg-accent"
          transition={{ type: "spring", stiffness: 420, damping: 34 }}
        />
      ) : null}
      <Link
        href={pageHref(page.slug)}
        onClick={onGo}
        aria-current={active ? "page" : undefined}
        className={`block border-l border-transparent py-1.5 pl-4 pr-2 text-[13px] leading-snug transition-all duration-200 hover:translate-x-[2px] hover:text-accent ${
          active ? "text-accent" : "text-text-muted"
        }`}
      >
        {navLabel(page)}
      </Link>
    </li>
  );
}

/**
 * The whole book, always in view. A group opens when the page you are reading is
 * inside it, and stays open if you open it yourself, so you never lose your
 * place while looking somewhere else.
 */
export function DocsTree({ nav, onGo }: { nav: NavEntry[]; onGo?: () => void }) {
  const t = useTranslations("docs");
  const pathname = usePathname();
  const [toggled, setToggled] = useState<Record<string, boolean>>({});

  const isActive = (slug: string) => pathname === pageHref(slug);

  return (
    <nav aria-label={t("sections")} className="docs-tree">
      {nav.map((entry) => {
        if (entry.type === "page") {
          return (
            <ul key={entry.slug} className="mb-3 border-l border-line">
              <Item page={entry} active={isActive(entry.slug)} onGo={onGo} />
            </ul>
          );
        }

        const holdsCurrent = entry.pages.some((page) => isActive(page.slug));
        const open = toggled[entry.title] ?? (holdsCurrent || entry.open === true);

        return (
          <div key={entry.title} className="mb-4">
            <button
              type="button"
              onClick={() => setToggled((was) => ({ ...was, [entry.title]: !open }))}
              aria-expanded={open}
              className="flex w-full items-center gap-2 py-1 text-left font-mono text-[10px] uppercase tracking-[0.2em] text-text-faint transition-colors duration-200 hover:text-accent"
            >
              <span
                aria-hidden
                className={`inline-block h-[5px] w-[5px] shrink-0 transition-transform duration-300 ${
                  open ? "rotate-45 bg-accent" : "bg-line-strong"
                }`}
              />
              {entry.title}
            </button>
            {open ? (
              <ul className="mt-1 border-l border-line">
                {entry.pages.map((page) => (
                  <Item key={page.slug} page={page} active={isActive(page.slug)} onGo={onGo} />
                ))}
              </ul>
            ) : null}
          </div>
        );
      })}
    </nav>
  );
}
