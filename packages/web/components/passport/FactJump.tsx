"use client";

import type { MouseEvent, ReactNode } from "react";
import { jumpToFact } from "./top-facts";

/**
 * Whether a click is the plain kind this link takes over. A new tab, a new
 * window, a download or a middle click keeps the browser's own behaviour.
 */
export function isPlainClick(event: {
  button: number;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  defaultPrevented: boolean;
}): boolean {
  return (
    event.button === 0 &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey &&
    !event.defaultPrevented
  );
}

/**
 * A facts link to a section lower on this page. The href stays a real hash, so
 * the link still works with no script and opens in a new tab as usual.
 */
export function FactJumpLink({ href, className, children }: { href: string; className?: string; children: ReactNode }) {
  const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (!isPlainClick(event)) {
      return;
    }
    const id = href.slice(1);
    const target = document.getElementById(id);
    if (target === null) {
      return;
    }
    event.preventDefault();
    jumpToFact(id, {
      target,
      history: window.history,
      reduced: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    });
  };

  return (
    <a href={href} className={className} onClick={onClick}>
      {children}
    </a>
  );
}
