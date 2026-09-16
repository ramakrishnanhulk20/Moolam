"use client";

import Lenis from "lenis";
import { usePathname } from "next/navigation";
import { useEffect, useRef, type ReactNode } from "react";

/**
 * Smooth scroll on every page, driven by one requestAnimationFrame loop.
 *
 * It used to tick GSAP's ScrollTrigger as well, which put 39 kB of gsap on
 * every route in the app for a plugin no section here has ever registered. A
 * pinned section that wants it registers it in its own file and ticks it from
 * there.
 *
 * Anyone who has asked their system for less motion gets the browser's own
 * scrolling instead: Lenis is never started for them.
 */
export function LenisProvider({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const lenis = useRef<Lenis | null>(null);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      return;
    }

    const instance = new Lenis({ duration: 1.05, smoothWheel: true });
    lenis.current = instance;

    let frame = 0;
    const raf = (time: number) => {
      instance.raf(time);
      frame = requestAnimationFrame(raf);
    };
    frame = requestAnimationFrame(raf);

    return () => {
      cancelAnimationFrame(frame);
      instance.destroy();
      lenis.current = null;
    };
  }, []);

  useEffect(() => {
    lenis.current?.scrollTo(0, { immediate: true });
  }, [pathname]);

  return children;
}
