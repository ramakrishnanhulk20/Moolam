"use client";

import Lenis from "lenis";
import { usePathname } from "next/navigation";
import { useEffect, useRef, type ReactNode } from "react";
import { registerGsap } from "@/lib/gsap";

/**
 * Smooth scroll on every page, driven by one requestAnimationFrame loop that
 * also ticks GSAP's ScrollTrigger, so pinned sections and the scroll position
 * can never fall out of step.
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

    const { ScrollTrigger } = registerGsap();
    const instance = new Lenis({ duration: 1.05, smoothWheel: true });
    lenis.current = instance;

    let frame = 0;
    const raf = (time: number) => {
      instance.raf(time);
      frame = requestAnimationFrame(raf);
    };
    frame = requestAnimationFrame(raf);

    instance.on("scroll", ScrollTrigger.update);

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
