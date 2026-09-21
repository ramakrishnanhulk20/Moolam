"use client";

import { AnimatePresence, motion } from "framer-motion";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { NavEntry } from "@/lib/docs/tree";
import { Link } from "@/lib/i18n/routing";
import { DocsSearch } from "./Search";
import { DocsTree } from "./Tree";

/**
 * The bar above every page: where you are, the way into the tree on a phone, and
 * the search box. It sits under the app header, which is why it takes its offset
 * from the measured height of that header rather than a guess.
 */
export function DocsToolbar({ nav }: { nav: NavEntry[] }) {
  const t = useTranslations("docs");
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) {
      return;
    }
    const was = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = was;
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="docs-bar">
      <div className="mx-auto flex w-full max-w-[1400px] items-center gap-3 px-5 py-3 sm:px-8">
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-expanded={open}
          className="tap flex items-center gap-2 rounded-[8px] border border-line px-3 py-2 font-mono text-[12px] uppercase tracking-[0.18em] text-text-muted transition-colors duration-200 hover:border-accent hover:text-accent lg:hidden"
        >
          <span aria-hidden className="flex flex-col gap-[3px]">
            <span className="block h-px w-4 bg-current" />
            <span className="block h-px w-4 bg-current" />
            <span className="block h-px w-2.5 bg-current" />
          </span>
          {t("menu")}
        </button>

        <Link
          href="/docs"
          className="tap hidden font-mono text-[12px] uppercase tracking-[0.22em] text-text-faint transition-colors duration-200 hover:text-accent lg:inline"
        >
          {t("home")}
        </Link>

        <div className="ml-auto min-w-0 flex-1 sm:flex-none">
          <DocsSearch />
        </div>
      </div>

      {/* The bar filters what is behind it, and a backdrop filter makes an
          element the containing block for anything fixed inside it, so a drawer
          rendered here opened as tall as the bar itself. It goes into the body,
          where fixed still means the window. The drawer is closed while the page
          is rendered on the server, so it puts nothing in either tree until
          somebody opens it. */}
      {typeof document === "undefined"
        ? null
        : createPortal(<ContentsDrawer nav={nav} open={open} onClose={() => setOpen(false)} />, document.body)}
    </div>
  );
}

/** The tree on a phone: the whole window, with the list scrolling inside it. */
function ContentsDrawer({ nav, open, onClose }: { nav: NavEntry[]; open: boolean; onClose: () => void }) {
  const t = useTranslations("docs");

  return (
    <AnimatePresence>
      {open ? (
        <motion.div
          className="fixed inset-0 z-[70] lg:hidden"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.16 }}
        >
          <button
            type="button"
            aria-label={t("close")}
            onClick={onClose}
            className="absolute inset-0 cursor-default bg-bg/80 backdrop-blur-sm"
          />
          <motion.div
            initial={{ x: "-100%" }}
            animate={{ x: 0 }}
            exit={{ x: "-100%" }}
            transition={{ duration: 0.32, ease: [0.16, 1, 0.3, 1] }}
            className="docs-drawer relative h-full w-[19rem] max-w-[86vw] overflow-y-auto border-r border-line-strong bg-bg-raised px-5 py-6"
          >
            <div className="mb-5 flex items-center justify-between">
              <span className="font-mono text-[10px] uppercase tracking-[0.22em] text-text-faint">{t("home")}</span>
              <button
                type="button"
                onClick={onClose}
                className="tap rounded-[8px] border border-line px-2 py-1 font-mono text-[12px] uppercase tracking-[0.16em] text-text-muted transition-colors duration-200 hover:border-accent hover:text-accent"
              >
                {t("close")}
              </button>
            </div>
            <DocsTree nav={nav} onGo={onClose} />
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
