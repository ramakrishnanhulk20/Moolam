"use client";

import type { MouseEvent, ReactNode } from "react";
import { jumpToFact, type JumpHistory } from "./top-facts";

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
 * The history a jump writes to, with the section's fragment left off.
 *
 * A jump that wrote "#made-by" onto the entry sent a reader who went on to
 * another page and pressed Back to the Made by section, not to where they had
 * scrolled before leaving: the router scrolls to a fragment it finds in the
 * address it restores. So the entry keeps the page's own address, clearing a
 * fragment a shared link or an earlier jump left there, and the router's
 * state on it, and the browser brings the reader back to where they were.
 */
export function addressOnlyHistory(
  history: Pick<History, "state" | "replaceState">,
  location: Pick<Location, "pathname" | "search">,
): JumpHistory {
  return {
    get state() {
      return history.state;
    },
    replaceState(data) {
      history.replaceState(data, "", `${location.pathname}${location.search}`);
    },
  };
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
      history: addressOnlyHistory(window.history, window.location),
      reduced: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    });
  };

  return (
    <a href={href} className={className} onClick={onClick}>
      {children}
    </a>
  );
}
