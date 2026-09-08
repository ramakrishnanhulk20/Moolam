"use client";

import { useEffect, useRef, type RefObject } from "react";
import { registerGsap } from "@/lib/gsap";

interface ScrubOptions {
  /** ScrollTrigger start, in its own words. Defaults to the section top hitting the viewport top. */
  start?: string;
  /** ScrollTrigger end. Defaults to the section bottom reaching the viewport bottom. */
  end?: string;
  /** Split the travel into this many equal states and report which one is current. */
  states?: number;
  /** Called only when the state changes, never on every frame. */
  onState?: (state: number) => void;
}

/**
 * Publishes how far a section has been scrolled through, from 0 to 1, straight
 * onto the element as a CSS custom property.
 *
 * Nothing here goes through React state. A pinned sequence updates on every
 * frame of a scroll, and a setState at that rate would re-render the whole
 * section sixty times a second to change one number. Writing the value onto the
 * node instead lets every moving part read it back through calc(), so the work
 * stays on the compositor and the value is inspectable by reading one attribute.
 *
 * Someone who has asked for less motion gets the finished state, 1, written once
 * and no scroll listener at all.
 */
export function useScrubProgress(
  ref: RefObject<HTMLElement | null>,
  property: string,
  options: ScrubOptions = {},
): void {
  const { start = "top top", end = "bottom bottom", states = 0, onState } = options;

  // Held in a ref so passing an inline function does not tear the trigger down
  // and rebuild it on every render.
  const report = useRef(onState);
  useEffect(() => {
    report.current = onState;
  });

  useEffect(() => {
    const node = ref.current;
    if (node === null) {
      return;
    }

    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      node.style.setProperty(property, "1");
      return;
    }

    const { ScrollTrigger } = registerGsap();
    let current = -1;

    const trigger = ScrollTrigger.create({
      trigger: node,
      start,
      end,
      scrub: true,
      invalidateOnRefresh: true,
      onUpdate: (self) => {
        node.style.setProperty(property, self.progress.toFixed(4));

        if (states > 0) {
          const next = Math.min(states - 1, Math.floor(self.progress * states));
          if (next !== current) {
            current = next;
            report.current?.(next);
          }
        }
      },
    });

    // The still is fetched from a gateway, so the section's height is not final
    // when this runs and the trigger would otherwise measure the wrong distance.
    const remeasure = () => ScrollTrigger.refresh();
    window.addEventListener("load", remeasure);

    return () => {
      window.removeEventListener("load", remeasure);
      trigger.kill();
    };
  }, [ref, property, start, end, states]);
}
