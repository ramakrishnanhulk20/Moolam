"use client";

import { AnimatePresence, motion } from "framer-motion";
import { useParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState, useTransition } from "react";
import { useIsReducedMotion } from "@/components/motion/useIsReducedMotion";
import { localeLabels, routing, usePathname, useRouter } from "@/lib/i18n/routing";

/**
 * Where this page lives: its own social address, and the same page in the other
 * nine languages.
 *
 * Without the alternate links a crawler that reads the page rather than the
 * sitemap sees ten unconnected copies of this site. They are rendered as real
 * tags rather than declared in the layout's metadata because Next never tells a
 * layout which page it is wrapping, and an hreflang pointing at the wrong page
 * is worse than none. The address comes from the same hook the control below
 * uses, which hands back the route with its locale stripped and its params
 * intact, so these are the readings of the page actually being drawn.
 *
 * The three social lines are written here for the same reason, and because the
 * layout declaring an openGraph block of its own would replace the one Next
 * builds from the card file and take the picture with it.
 */
export function PageAddress({ site, ogLocale, siteName }: { site: string; ogLocale: string; siteName: string }) {
  const pathname = usePathname();
  const tail = pathname === "/" ? "" : pathname;
  const here = (locale: string) => `${site}/${locale}${tail}`;
  const active = useActiveLocale();

  return (
    <>
      <meta property="og:url" content={here(active)} />
      <meta property="og:locale" content={ogLocale} />
      <meta property="og:site_name" content={siteName} />
      {routing.locales.map((locale) => (
        <link key={locale} rel="alternate" hrefLang={locale} href={here(locale)} />
      ))}
      {/* Where a reader whose language the site does not carry is sent. */}
      <link rel="alternate" hrefLang="x-default" href={here(routing.defaultLocale)} />
    </>
  );
}

/** The locale in the address, or the default one for anything the routes do not carry. */
function useActiveLocale(): string {
  const params = useParams();
  const raw = typeof params.locale === "string" ? params.locale : routing.defaultLocale;
  return (routing.locales as readonly string[]).includes(raw) ? raw : routing.defaultLocale;
}

/**
 * Switches language without leaving the page: the pathname next-intl hands back
 * has the locale segment stripped, so the same route is re-rendered in the other
 * language with its params intact.
 *
 * Ten languages will not sit in a header row at 375 px, so the current one is
 * the button and the rest live in a panel under it. Each is named in its own
 * script, which is the only name a reader who needs it can recognise.
 */
export function LocaleSwitch() {
  const t = useTranslations("header");
  const router = useRouter();
  const pathname = usePathname();
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const reduced = useIsReducedMotion();
  const shell = useRef<HTMLDivElement>(null);
  const active = useActiveLocale();

  useEffect(() => {
    if (!open) return;

    const onPointer = (event: PointerEvent) => {
      if (shell.current !== null && !shell.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };

    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const choose = (locale: string) => {
    setOpen(false);
    if (locale === active) return;
    startTransition(() => {
      router.replace(pathname, { locale: locale as (typeof routing.locales)[number] });
    });
  };

  return (
    <div ref={shell} className="relative">
      <button
        type="button"
        // The chip shows the language's own name, so that name leads the label
        // a screen reader hears and the one voice control listens for. Named
        // "Language" while it read "English", neither could reach it.
        aria-label={t("languageIs", { language: localeLabels[active as keyof typeof localeLabels] })}
        title={t("languageChange")}
        aria-expanded={open}
        aria-haspopup="listbox"
        disabled={pending}
        onClick={() => setOpen((was) => !was)}
        className={`flex items-center gap-2 rounded-[8px] border px-3 py-1.5 text-xs uppercase tracking-[0.18em] transition-colors duration-200 ${
          open ? "border-accent text-accent" : "border-line text-text-muted hover:border-accent hover:text-accent"
        }`}
      >
        <span className="motif h-[7px] w-[7px]" aria-hidden />
        <span className="max-w-[9ch] truncate normal-case tracking-[0.06em]">
          {localeLabels[active as keyof typeof localeLabels]}
        </span>
      </button>

      <AnimatePresence>
        {open ? (
          <motion.ul
            role="listbox"
            aria-label={t("language")}
            initial={reduced ? { opacity: 0 } : { opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reduced ? { opacity: 0 } : { opacity: 0, y: -6 }}
            transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
            // The header wraps on a phone and this control lands on the left of
            // the second row, so the panel hangs from the same edge it does. From
            // the width where the bar is one row again, it hangs from the right.
            className="absolute start-0 top-[calc(100%+8px)] z-50 max-h-[70vh] w-[13.5rem] overflow-y-auto border border-line bg-bg-raised py-1 shadow-[0_24px_60px_-30px_rgb(0_0_0/0.9)] backdrop-blur-md sm:start-auto sm:end-0"
          >
            {routing.locales.map((locale, index) => {
              const current = locale === active;
              return (
                <li key={locale}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={current}
                    onClick={() => choose(locale)}
                    className={`group flex w-full items-center gap-3 px-4 py-2.5 text-start transition-colors duration-200 ${
                      current ? "text-accent" : "text-text-muted hover:bg-accent-soft hover:text-text"
                    }`}
                  >
                    <span
                      aria-hidden
                      className={
                        current
                          ? "motif h-[7px] w-[7px] shrink-0"
                          : "h-[7px] w-[7px] shrink-0 border border-line-strong transition-colors duration-200 group-hover:border-accent"
                      }
                    />
                    <span className="flex-1 truncate text-sm">{localeLabels[locale]}</span>
                    <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-text-faint">
                      {locale}
                    </span>
                  </button>
                  {index === routing.locales.length - 1 ? null : (
                    <span className="mx-4 block h-px bg-line/60" aria-hidden />
                  )}
                </li>
              );
            })}
          </motion.ul>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
