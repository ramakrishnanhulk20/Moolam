"use client";

import { AnimatePresence, motion } from "framer-motion";
import { useParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState, useTransition, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useIsReducedMotion } from "@/components/motion/useIsReducedMotion";
import { localeLabels, routing, usePathname, useRouter, type Locale } from "@/lib/i18n/routing";

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

/** Everything under the header: the parts that fade while another language is on its way. */
const FRAME_PARTS = "main, main ~ footer";

/**
 * Dims the page to 60 percent while it is drawn again in another language, and
 * hands back the undo.
 *
 * The whole frame is replaced on a language change, because it lives in the
 * locale's layout. Left alone, the old page sat untouched for up to half a
 * second and then vanished at once, which read as a fault rather than an
 * answer. Faded first, the swap reads as the answer to the press. Reduced
 * motion still dims the page; it just does not animate the dimming.
 */
export function dimFrame(root: Pick<ParentNode, "querySelectorAll">, reduced: boolean): () => void {
  const parts = Array.from(root.querySelectorAll<HTMLElement>(FRAME_PARTS));
  const before = parts.map((part) => ({ opacity: part.style.opacity, transition: part.style.transition }));
  for (const part of parts) {
    part.style.transition = reduced ? "none" : "opacity 320ms cubic-bezier(0.16, 1, 0.3, 1)";
    part.style.opacity = "0.6";
  }
  return () => {
    parts.forEach((part, index) => {
      part.style.opacity = before[index].opacity;
      part.style.transition = before[index].transition;
    });
  };
}

/**
 * Where focus goes in the open list for a key, or null for a key the list
 * leaves alone. The arrows wrap, so the last language is one press from the
 * first.
 */
export function stepOption(from: number, key: string, count: number): number | null {
  if (count <= 0) return null;
  const at = Math.min(Math.max(from, 0), count - 1);
  switch (key) {
    case "ArrowDown":
      return (at + 1) % count;
    case "ArrowUp":
      return (at - 1 + count) % count;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}

/**
 * When the last language switch was pressed, in the page's own clock, or null
 * once the new language's frame is up.
 *
 * The locale's layout holds the loading screen, so a switch that lands after
 * the new frame but before its page shows that screen. It reads this to know
 * it is standing in for a switch and should wait longer before it shows.
 */
let switchPressedAt: number | null = null;

/** How long a pressed switch still counts as on its way, however it ended. */
const SWITCH_WINDOW_MS = 10_000;

/** Notes the moment a switch is pressed, for the loading screen the new frame may show. */
function markSwitchPressed(): void {
  switchPressedAt = performance.now();
}

/** True while a language switch pressed in this tab is still on its way. */
export function switchOnItsWay(now: number = performance.now()): boolean {
  return switchPressedAt !== null && now - switchPressedAt < SWITCH_WINDOW_MS;
}

/** Every other language this page can be read in, in the list's order. */
export function otherLocales(active: string): Locale[] {
  return routing.locales.filter((locale) => locale !== active);
}

/**
 * Whether to fetch the other languages' pages when the list opens. A page in
 * hand is what lets a choice land on the dimmed page with no loading screen
 * between, but nine of them are real data on a phone plan, so a reader who
 * asked the browser to save data is not sent them.
 */
export function shouldWarmLanguages(connection: { saveData?: boolean } | undefined): boolean {
  return connection?.saveData !== true;
}

/** The rows of the open list, in the order they are drawn. */
function rowsOf(list: HTMLUListElement | null): HTMLButtonElement[] {
  return Array.from(list?.querySelectorAll<HTMLButtonElement>('[role="option"]') ?? []);
}

/**
 * The tag that hangs under the chip while the chosen language is on its way,
 * naming it in its own script. The chip itself is too narrow for the sentence
 * in most of the ten languages, and growing it would shove the header about
 * in the very moment the page is meant to hold still.
 */
export function OpeningNote({ language, reduced }: { language: string; reduced: boolean }) {
  const t = useTranslations("header");
  return (
    <motion.span
      aria-hidden
      data-language-opening
      initial={reduced ? { opacity: 0 } : { opacity: 0, y: -4 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
      className="pointer-events-none absolute end-0 top-[calc(100%+8px)] z-50 flex items-center gap-2 whitespace-nowrap rounded-[8px] border border-accent/60 bg-bg-raised px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.2em] text-accent shadow-[0_18px_40px_-24px_rgb(0_0_0/0.9)]"
    >
      <span aria-hidden className="motif h-[7px] w-[7px] shrink-0 animate-pulse motion-reduce:animate-none" />
      <span className="normal-case tracking-[0.06em]">{t("languageOpening", { language })}</span>
    </motion.span>
  );
}

/**
 * Switches language without leaving the page: the pathname next-intl hands back
 * has the locale segment stripped, so the same route is re-rendered in the other
 * language with its params intact.
 *
 * Ten languages will not sit in a header row at 375 px, so the current one is
 * the button and the rest live in a panel under it. Each is named in its own
 * script, which is the only name a reader who needs it can recognise.
 *
 * Opened from the keyboard, focus lands on the current language and the arrows
 * walk the list. Only one row at a time takes a Tab stop, so Tab leaves the list
 * in one press, and leaving closes it. Escape closes it and puts focus back on
 * the chip rather than on the top of the page.
 */
export function LocaleSwitch() {
  const t = useTranslations("header");
  const router = useRouter();
  const pathname = usePathname();
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [fromKeys, setFromKeys] = useState(false);
  const [target, setTarget] = useState<Locale | null>(null);
  const reduced = useIsReducedMotion();
  const shell = useRef<HTMLDivElement>(null);
  const chip = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const active = useActiveLocale();
  const opening = pending && target !== null ? target : null;
  const shown = localeLabels[(opening ?? active) as Locale];

  useEffect(() => {
    if (!open) return;

    const onPointer = (event: PointerEvent) => {
      if (shell.current !== null && !shell.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const inside = shell.current?.contains(document.activeElement) ?? false;
      setOpen(false);
      if (inside) chip.current?.focus();
    };

    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  useEffect(() => {
    if (!open || !fromKeys) return;
    const all = rowsOf(list.current);
    (all.find((row) => row.getAttribute("aria-selected") === "true") ?? all[0])?.focus();
  }, [open, fromKeys]);

  useEffect(() => {
    if (!pending) return;
    return dimFrame(document, reduced);
  }, [pending, reduced]);

  // This chip is drawn by the new language's frame, so the switch that brought
  // it here is over as far as the loading screen is concerned.
  useEffect(() => {
    switchPressedAt = null;
  }, []);

  // The reader is choosing, which takes a second or two: long enough to have
  // this page in every other language by the press, and then the router swaps
  // the dimmed page for the new one with nothing in between. The default kind
  // is the right one. Nearly every page here is built ahead and kept for a
  // minute or so, and for a built page Next fetches the whole of it from its
  // cache without drawing it again; asking for "full" would draw nine pages on
  // the server, and their reads, on every open. The router keeps what it
  // fetched, so opening the list again asks for nothing. Next never prefetches
  // on the dev server, so there the loading screen still stands in.
  useEffect(() => {
    if (!open) return;
    const connection = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
    if (!shouldWarmLanguages(connection)) return;
    for (const locale of otherLocales(active)) {
      router.prefetch(pathname, { locale });
    }
  }, [open, active, pathname, router]);

  const choose = (locale: Locale) => {
    setOpen(false);
    chip.current?.focus();
    if (locale === active) return;
    markSwitchPressed();
    setTarget(locale);
    startTransition(() => {
      router.replace(pathname, { locale });
    });
  };

  const walk = (event: ReactKeyboardEvent<HTMLUListElement>) => {
    const all = rowsOf(list.current);
    const to = stepOption(all.indexOf(document.activeElement as HTMLButtonElement), event.key, all.length);
    if (to === null) return;
    event.preventDefault();
    all[to]?.focus();
  };

  return (
    <div
      ref={shell}
      className="relative"
      onBlur={(event) => {
        // Only a move to something else on the page closes the list. A blur
        // with nowhere named is a press on a row in a browser that never
        // focuses buttons, and closing then would swallow the press.
        const next = event.relatedTarget as Node | null;
        if (open && next !== null && !event.currentTarget.contains(next)) setOpen(false);
      }}
    >
      <button
        ref={chip}
        type="button"
        // The chip shows the language's own name, so that name leads the label
        // a screen reader hears and the one voice control listens for. Named
        // "Language" while it read "English", neither could reach it.
        aria-label={
          opening === null
            ? t("languageIs", { language: localeLabels[active as keyof typeof localeLabels] })
            : t("languageOpening", { language: shown })
        }
        title={t("languageChange")}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-busy={pending}
        // Not disabled while the new language loads: a disabled button drops
        // the keyboard focus that just chose it onto the top of the page.
        aria-disabled={pending}
        onClick={(event) => {
          if (pending) return;
          // A press from Enter or Space reports no mouse clicks at all.
          setFromKeys(event.detail === 0);
          setOpen((was) => !was);
        }}
        onKeyDown={(event) => {
          if (pending || open || (event.key !== "ArrowDown" && event.key !== "ArrowUp")) return;
          event.preventDefault();
          setFromKeys(true);
          setOpen(true);
        }}
        className={`flex items-center gap-2 rounded-[8px] border px-3 py-1.5 text-xs uppercase tracking-[0.18em] transition-colors duration-200 ${
          open || opening !== null
            ? "border-accent text-accent"
            : "border-line text-text-muted hover:border-accent hover:text-accent"
        } ${pending ? "cursor-progress" : ""}`}
      >
        <span
          className={`motif h-[7px] w-[7px] ${opening === null ? "" : "animate-pulse motion-reduce:animate-none"}`}
          aria-hidden
        />
        <span className="max-w-[9ch] truncate normal-case tracking-[0.06em]">{shown}</span>
      </button>

      {/* Kept in the page from the start, so the sentence is read out the
          moment it is filled rather than lost as a region that just appeared. */}
      <span role="status" className="sr-only">
        {opening === null ? "" : t("languageOpening", { language: shown })}
      </span>

      <AnimatePresence>
        {opening !== null ? <OpeningNote key="opening" language={shown} reduced={reduced} /> : null}
      </AnimatePresence>

      <AnimatePresence>
        {open ? (
          <motion.ul
            ref={list}
            role="listbox"
            aria-label={t("language")}
            onKeyDown={walk}
            initial={reduced ? { opacity: 0 } : { opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reduced ? { opacity: 0 } : { opacity: 0, y: -6 }}
            transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
            // On a phone the header is one row, the wordmark on the left and
            // this chip beside the theme square on the right, and on a laptop
            // the chip ends the nav row. Either way it sits in the right half,
            // so the panel hangs from its end edge and opens back across the
            // screen, never past the right edge. The cap keeps it inside a
            // window narrower than the panel.
            className="absolute end-0 top-[calc(100%+8px)] z-50 max-h-[70vh] w-[13.5rem] max-w-[calc(100vw-2.5rem)] overflow-y-auto border border-line bg-bg-raised py-1 shadow-[0_24px_60px_-30px_rgb(0_0_0/0.9)] backdrop-blur-md"
          >
            {routing.locales.map((locale, index) => {
              const current = locale === active;
              return (
                <li key={locale}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={current}
                    tabIndex={current ? 0 : -1}
                    onClick={() => choose(locale)}
                    className={`group flex min-h-11 w-full items-center gap-3 px-4 py-2 text-start transition-colors duration-200 focus-visible:bg-accent-soft ${
                      current ? "text-accent" : "text-text-muted hover:bg-accent-soft hover:text-text"
                    }`}
                  >
                    <span
                      aria-hidden
                      className={
                        current
                          ? "motif h-[7px] w-[7px] shrink-0"
                          : "h-[7px] w-[7px] shrink-0 border border-line-strong transition-colors duration-200 group-hover:border-accent group-focus-visible:border-accent"
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
