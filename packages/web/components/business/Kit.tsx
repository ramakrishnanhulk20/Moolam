"use client";

import { motion } from "framer-motion";
import { useFormatter } from "next-intl";
import type { ReactNode } from "react";
import { useIsReducedMotion } from "@/components/motion/useIsReducedMotion";
import { Link } from "@/lib/i18n/routing";
import { LINKS, isPlainHref, type LinkKey } from "./content";
import type { CodeLines } from "./data";

export const EASE = [0.16, 1, 0.3, 1] as const;

/** Fade and rise once, when it first scrolls into view. Stands still for a reader who asked for less motion. */
export function Reveal({
  children,
  delay = 0,
  className = "",
  as = "div",
}: {
  children: ReactNode;
  delay?: number;
  className?: string;
  as?: "div" | "li" | "article";
}) {
  const reduced = useIsReducedMotion();
  const Tag = motion[as];
  return (
    <Tag
      initial={reduced ? false : { opacity: 0, y: 24 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-60px" }}
      transition={reduced ? { duration: 0 } : { duration: 0.75, ease: EASE, delay }}
      className={className}
    >
      {children}
    </Tag>
  );
}

/** The mono kicker every Moolam section opens with, the kolam knot in front. */
export function Kicker({ children, number, className = "" }: { children: ReactNode; number?: string; className?: string }) {
  return (
    <p className={`flex items-center gap-3 font-mono text-[11px] uppercase tracking-[0.24em] text-accent ${className}`}>
      <span className="motif h-[10px] w-[10px] shrink-0" />
      {number === undefined ? null : <span className="text-text-faint">{number}</span>}
      <span>{children}</span>
    </p>
  );
}

/** Any link the page draws: the locale router for app routes, a plain anchor for the rest. */
export function Go({
  to,
  className,
  children,
  label,
}: {
  to: LinkKey;
  className: string;
  children: ReactNode;
  label?: string;
}) {
  const href = LINKS[to];
  if (isPlainHref(href)) {
    const away = href.startsWith("https://");
    return (
      <a
        href={href}
        className={className}
        aria-label={label}
        {...(away ? { target: "_blank", rel: "noopener noreferrer" } : {})}
      >
        {children}
      </a>
    );
  }
  return (
    <Link href={href} prefetch={false} className={className} aria-label={label}>
      {children}
    </Link>
  );
}

const ARROW = (
  <span
    aria-hidden
    className="block h-px w-5 bg-current transition-transform duration-300 group-hover:translate-x-1.5 group-focus-visible:translate-x-1.5"
  />
);

/** The one lead action: the accent, 8 px corners, an arrow that slides rather than grows. */
export function Lead({ to, children }: { to: LinkKey; children: ReactNode }) {
  return (
    <Go
      to={to}
      className="group inline-flex min-h-11 items-center gap-3 rounded-[8px] bg-accent px-6 py-3 text-xs font-semibold uppercase tracking-[0.14em] text-accent-ink transition duration-200 hover:-translate-y-0.5 hover:opacity-90 active:translate-y-0"
    >
      {children}
      {ARROW}
    </Go>
  );
}

/** The quiet action beside it, outlined, the site's secondary button. */
export function Quiet({ to, children }: { to: LinkKey; children: ReactNode }) {
  return (
    <Go
      to={to}
      className="group inline-flex min-h-11 items-center gap-3 rounded-[8px] border border-line-strong px-6 py-3 text-xs font-semibold uppercase tracking-[0.14em] text-text transition-colors duration-200 hover:border-accent hover:text-accent focus-visible:border-accent focus-visible:text-accent"
    >
      {children}
      {ARROW}
    </Go>
  );
}

/** A proof link under a claim: small, underlined, and 44 px tall to a thumb. */
export function Proof({ to, children }: { to: LinkKey; children: ReactNode }) {
  return (
    <Go
      to={to}
      className="inline-flex min-h-11 items-center gap-2 font-mono text-[11px] uppercase tracking-[0.16em] text-text underline decoration-line-strong underline-offset-4 transition-colors duration-200 hover:text-accent hover:decoration-accent"
    >
      {children}
      <span aria-hidden>{"→"}</span>
    </Go>
  );
}

/** A count in the page's figures, or a quiet dash with the reason when it was not read. */
export function Figure({ value, unread }: { value: number | null; unread: string }) {
  const format = useFormatter();
  return value === null ? (
    <span className="text-text-faint" title={unread}>
      {"–"}
      <span className="sr-only">{unread}</span>
    </span>
  ) : (
    <>{format.number(value)}</>
  );
}

/** Code coloured on the server, painted with the docs' own code block rules so both themes read. */
export function Code({ lines, label }: { lines: CodeLines; label: string }) {
  return (
    <div className="docs-code !my-0 min-w-0">
      <pre
        className="shiki !text-[13px] sm:!text-[0.82rem]"
        style={{ "--shiki-light": "#24292e", "--shiki-dark": "#e1e4e8" } as React.CSSProperties}
        aria-label={label}
        tabIndex={0}
      >
        <code>
          {lines.map((line, row) => (
            <span key={row} className="block min-h-[1.65em]">
              {line.map((token, at) => (
                <span key={at} style={token.style as React.CSSProperties}>
                  {token.content}
                </span>
              ))}
            </span>
          ))}
        </code>
      </pre>
    </div>
  );
}
