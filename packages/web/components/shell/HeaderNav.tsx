"use client";

import { motion } from "framer-motion";
import { useIsReducedMotion } from "@/components/motion/useIsReducedMotion";
import { Link, usePathname } from "@/lib/i18n/routing";
import { IntentLink } from "./BottomBar";

/** One link in the laptop header. The layout owns the words, so every language gets them. */
export interface HeaderLink {
  href: string;
  label: string;
  /** "intent" fetches the page once a pointer, focus or touch reaches for it; false never fetches it. */
  prefetch: "intent" | false | undefined;
  /** The name the first-visit guide lights this link by. */
  anchor: string | undefined;
}

/**
 * The routes each header link counts as its own besides its own address, by the
 * rule the phone bar uses: the route itself or anything under it.
 *
 * An agent's own page is reached from the agents board, and settling a
 * challenge is the verify side of the product. A passport is left unclaimed:
 * the header has no Explore-owns-everything tab to fall back on, and a reader
 * can arrive at one from Explore, My pictures or a pasted link alike.
 */
const ALSO_OWNS: Record<string, readonly string[]> = {
  "/agents": ["/agent"],
  "/verify": ["/resolve"],
};

/** Drops the query, the fragment and a trailing slash, so "/docs/" and "/docs?x" are "/docs". */
function tidy(here: string): string {
  const path = here.split("?")[0].split("#")[0];
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}

/**
 * Which of these links the route belongs to, or null where none of them does.
 *
 * The route is next-intl's, with the locale already taken off: /en/verify
 * arrives here as /verify.
 */
export function currentHeaderLink(here: string, hrefs: readonly string[]): string | null {
  const path = tidy(here);
  return (
    hrefs.find((href) =>
      [href, ...(ALSO_OWNS[href] ?? [])].some((root) => path === root || path.startsWith(`${root}/`)),
    ) ?? null
  );
}

/**
 * The laptop header's links, with the page being read marked the way the
 * phone bar marks its tab: the accent colour and a short rule, which slides
 * from the old link to the new one as the reader moves.
 */
export function HeaderNav({ links, label }: { links: readonly HeaderLink[]; label?: string }) {
  const here = usePathname();
  const current = currentHeaderLink(
    here,
    links.map((link) => link.href),
  );
  const reduced = useIsReducedMotion();

  return (
    // Below lg the links take a row of their own under the wordmark and the
    // chips; from lg they sit on the one row, pushed right. 12 px between links
    // up to xl keeps English on one row at 1024; 16 px from there, never 20,
    // at which the chips dropped to a second row.
    <nav
      aria-label={label}
      className="order-last hidden basis-full items-center gap-3 text-sm md:flex lg:order-none lg:ml-auto lg:basis-auto xl:gap-4"
    >
      {links.map((link) => {
        const on = link.href === current;
        const props = {
          href: link.href,
          "data-guide-anchor": link.anchor,
          "aria-current": on ? ("page" as const) : undefined,
          className: `tap whitespace-nowrap transition-colors duration-200 hover:text-accent ${
            on ? "text-accent" : "text-text-muted"
          }`,
        };
        const rule = on ? <Rule reduced={reduced} /> : null;
        return link.prefetch === "intent" ? (
          <IntentLink key={link.href} {...props}>
            {link.label}
            {rule}
          </IntentLink>
        ) : (
          <Link key={link.href} prefetch={link.prefetch} {...props}>
            {link.label}
            {rule}
          </Link>
        );
      })}
    </nav>
  );
}

/** The short accent rule under the current link, the phone bar's mark laid on its side. */
function Rule({ reduced }: { reduced: boolean }) {
  const className = "pointer-events-none absolute -bottom-2 left-0 h-[2px] w-4 bg-accent";
  if (reduced) {
    return <span aria-hidden className={className} />;
  }
  return (
    <motion.span
      layoutId="header-nav-lit"
      aria-hidden
      className={className}
      transition={{ type: "spring", stiffness: 420, damping: 34 }}
    />
  );
}
