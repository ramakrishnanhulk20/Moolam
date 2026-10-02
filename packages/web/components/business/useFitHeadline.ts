"use client";

import { useLayoutEffect, type RefObject } from "react";

/** The smallest the headline may shrink to, as a share of the size its own CSS asks for. */
const FLOOR = 0.4;
const STEPS = 8;

/** Where an element ends on the page, read from layout alone so the entrance's slide does not move it. */
function bottomOnPage(node: HTMLElement) {
  let top = 0;
  for (let at: HTMLElement | null = node; at !== null; at = at.offsetParent as HTMLElement | null) {
    top += at.offsetTop;
  }
  return top + node.offsetHeight;
}

/**
 * Shrinks the hero's headline until the opening fits the first screen, and
 * never makes it bigger than its CSS asks for.
 *
 * The CSS already sizes the headline from the column's width and the window's
 * height, which is exact for English. Other languages break the same words
 * onto more lines, and Tamil, Devanagari and the CJK scripts need taller
 * leading, so the same size runs past the fold there. The page cannot know
 * how many lines a language takes, so it measures: on a laptop the whole left
 * column must sit inside the screen, on a phone the first button must clear
 * the tab bar, and on both no word may run out of the column. The answer goes
 * out as --hero-shrink on the column, which the headline's size multiplies by.
 *
 * Height is monotone in size (a bigger headline never takes fewer lines), so
 * a halving search finds the largest size that fits.
 */
export function useFitHeadline(column: RefObject<HTMLElement | null>, copy: string) {
  useLayoutEffect(() => {
    const host = column.current;
    if (host === null) {
      return;
    }
    const wide = window.matchMedia("(min-width: 1024px)");
    let lastKey = "";
    let frame = 0;

    const fit = () => {
      const probe = document.createElement("div");
      probe.setAttribute("aria-hidden", "true");
      probe.style.cssText = "position:fixed;left:0;top:0;width:0;visibility:hidden;pointer-events:none;height:100svh";
      const bar = document.createElement("div");
      // The tab bar's room is only set on phones. Elsewhere it is unset and this reads as nothing.
      bar.style.height = "var(--bar-room, 0px)";
      probe.append(bar);
      host.append(probe);
      const screen = probe.offsetHeight;
      const barRoom = wide.matches ? 0 : bar.offsetHeight;
      probe.remove();

      const header = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--header-h")) || 0;
      const key = `${window.innerWidth}x${screen}x${header}`;
      if (key === lastKey) {
        return;
      }
      lastKey = key;

      const grid = host.parentElement;
      const gridStyle = grid === null ? null : getComputedStyle(grid);
      const padding = gridStyle === null ? 0 : Number.parseFloat(gridStyle.paddingTop) + Number.parseFloat(gridStyle.paddingBottom);
      const lead = host.querySelector("a");

      const fits = () => {
        // A long word cannot break, so a language with one can run out the side of the column.
        if (host.scrollWidth > host.clientWidth) {
          return false;
        }
        if (wide.matches) {
          return host.offsetHeight + padding <= screen - header - 1;
        }
        return lead === null || bottomOnPage(lead) <= screen - barRoom;
      };

      host.style.removeProperty("--hero-shrink");
      if (fits()) {
        return;
      }
      let low = FLOOR;
      let high = 1;
      for (let step = 0; step < STEPS; step += 1) {
        const middle = (low + high) / 2;
        host.style.setProperty("--hero-shrink", String(middle));
        if (fits()) {
          low = middle;
        } else {
          high = middle;
        }
      }
      host.style.setProperty("--hero-shrink", String(low));
    };

    const refit = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(fit);
    };

    fit();
    window.addEventListener("resize", refit);
    // The fonts change how many lines the words take, and they can land after hydration.
    void document.fonts?.ready.then(() => {
      lastKey = "";
      refit();
    });
    return () => {
      window.removeEventListener("resize", refit);
      cancelAnimationFrame(frame);
    };
  }, [column, copy]);
}
