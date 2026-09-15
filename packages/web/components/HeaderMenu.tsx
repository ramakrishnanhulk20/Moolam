"use client";

import { AnimatePresence, motion } from "framer-motion";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { LocaleSwitch } from "@/components/LocaleSwitch";
import { ThemeToggle } from "@/components/ThemeToggle";
import { useIsReducedMotion } from "@/components/motion/useIsReducedMotion";
import { Link, usePathname } from "@/lib/i18n/routing";

/** What the bar needs to show below 768 px: the four routes, in the reader's language. */
export interface MenuLink {
  href: string;
  label: string;
}

/**
 * The bar on a phone: a lockup, a button, and everything else behind it.
 *
 * Four links, a language control naming ten languages and a theme control do
 * not fit in a 375 px row, and wrapping them cost three rows and a third of the
 * first screen. They live in a panel instead, which falls from under the bar,
 * takes the keyboard while it is open, and shuts on a choice, on Escape and on
 * a tap outside it.
 */
export function HeaderMenu({ links }: { links: MenuLink[] }) {
  const t = useTranslations("header");
  const reduced = useIsReducedMotion();
  const shell = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const here = usePathname();

  // The menu is remembered as the route it was opened on, so any route change,
  // including the browser's own back button, closes it without an effect
  // watching for one.
  const [openAt, setOpenAt] = useState<string | null>(null);
  const open = openAt === here;
  const setOpen = (next: boolean) => setOpenAt(next ? here : null);

  useEffect(() => {
    if (!open) {
      return;
    }

    const onPointer = (event: PointerEvent) => {
      if (shell.current !== null && !shell.current.contains(event.target as Node)) {
        setOpenAt(null);
      }
    };

    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpenAt(null);
        button.current?.focus();
        return;
      }
      if (event.key !== "Tab" || panel.current === null) {
        return;
      }

      // The panel covers the page, so tabbing out of it would walk a reader
      // through a page they cannot see. The ring stays inside until it closes.
      const stops = panel.current.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (stops.length === 0) {
        return;
      }
      const first = stops[0];
      const last = stops[stops.length - 1];
      const active = document.activeElement;

      if (event.shiftKey && (active === first || active === button.current)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    const was = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);

    return () => {
      document.body.style.overflow = was;
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={shell} className="ms-auto md:hidden">
      <button
        ref={button}
        type="button"
        aria-expanded={open}
        aria-controls="header-menu"
        aria-label={open ? t("menuClose") : t("menu")}
        onClick={() => setOpen(!open)}
        className={`tap flex items-center gap-2.5 rounded-[8px] border px-3 py-2 text-[11px] uppercase tracking-[0.2em] transition-colors duration-200 ${
          open ? "border-accent text-accent" : "border-line text-text-muted"
        }`}
      >
        <span aria-hidden className="relative block h-[9px] w-[15px]">
          <span
            className="absolute inset-x-0 top-0 block h-px bg-current transition-transform duration-300"
            style={open ? { transform: "translateY(4px) rotate(45deg)" } : undefined}
          />
          <span
            className="absolute inset-x-0 bottom-0 block h-px bg-current transition-transform duration-300"
            style={open ? { transform: "translateY(-4px) rotate(-45deg)" } : undefined}
          />
        </span>
        {open ? t("menuClose") : t("menu")}
      </button>

      <AnimatePresence>
        {open ? (
          <motion.div
            id="header-menu"
            ref={panel}
            initial={reduced ? { opacity: 0 } : { opacity: 0, y: -12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reduced ? { opacity: 0 } : { opacity: 0, y: -12 }}
            transition={{ duration: 0.26, ease: [0.16, 1, 0.3, 1] }}
            className="fixed inset-x-0 top-[var(--header-h)] z-50 border-y border-line bg-bg-raised/95 px-5 pb-7 pt-2 backdrop-blur-xl"
          >
            <nav className="flex flex-col">
              {links.map((item, index) => (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={() => setOpenAt(null)}
                  style={reduced ? undefined : { animationDelay: `${40 + index * 45}ms` }}
                  className="rise group flex items-baseline gap-4 border-b border-line py-3.5 font-display text-[1.6rem] font-semibold leading-[1.1] tracking-[-0.03em] text-text transition-colors duration-200 hover:text-accent"
                >
                  <span aria-hidden className="font-mono text-[10px] tracking-[0.2em] text-text-faint">
                    0{index + 1}
                  </span>
                  {item.label}
                </Link>
              ))}
            </nav>

            {/* Both chips are drawn small on purpose and both are grown to a
                44 px target by the tap-row rule in globals.css. */}
            <div className="tap-row mt-6 flex items-center gap-2">
              <LocaleSwitch />
              <ThemeToggle />
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
