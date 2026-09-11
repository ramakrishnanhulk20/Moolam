"use client";

import { usePathname } from "next/navigation";
import { useEffect } from "react";

/**
 * Lands a reader on the heading they asked for.
 *
 * Arriving at a page with a hash on it is a race: the smooth scroll provider
 * puts every new page back at the top, which would undo the browser's own jump
 * to the heading. Scrolling again on the next tick settles it, and the
 * scroll-margin on headings keeps the line clear of the sticky bar.
 */
export function HashLanding() {
  const pathname = usePathname();

  useEffect(() => {
    const id = decodeURIComponent(window.location.hash.slice(1));
    if (id === "") {
      return;
    }
    const timer = setTimeout(() => {
      document.getElementById(id)?.scrollIntoView({ block: "start", behavior: "auto" });
    }, 90);
    return () => clearTimeout(timer);
  }, [pathname]);

  return null;
}
