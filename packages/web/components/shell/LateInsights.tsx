"use client";

import { useEffect, useState, type ComponentType } from "react";

/**
 * The longest the page waits for the browser to go idle. A phone that stays
 * busy (the film, a long hydration) still gets counted, just a little later.
 */
export const IDLE_TIMEOUT_MS = 4000;

/** Where there is no requestIdleCallback (Safari), the wait after the first paint. */
export const NO_IDLE_WAIT_MS = 2000;

/**
 * Vercel's visit counter and Speed Insights, mounted once the page has painted
 * and the browser has a spare moment.
 *
 * Both used to mount with the layout, which put their code in the first script
 * the home page evaluates: on 25 September that script cost 1.1 s of bootup
 * under Lighthouse's phone profile. Nothing is lost by waiting. The Speed
 * Insights script is web-vitals, and web-vitals asks the browser for paint and
 * largest-contentful-paint entries with buffered: true, so an FCP and an LCP
 * that happened before it loaded are still handed to it.
 *
 * The code for both arrives with import(), so it is a chunk of its own rather
 * than part of the layout's.
 */
export function LateInsights() {
  const [parts, setParts] = useState<ComponentType[] | null>(null);

  useEffect(() => {
    let live = true;
    const load = () => {
      void Promise.all([import("@vercel/analytics/next"), import("@vercel/speed-insights/next")])
        .then(([analytics, speed]) => {
          if (live) {
            setParts([analytics.Analytics, speed.SpeedInsights]);
          }
        })
        // A blocker or a dropped chunk only means this visit is not counted.
        .catch(() => undefined);
    };

    if (typeof window.requestIdleCallback === "function") {
      const id = window.requestIdleCallback(load, { timeout: IDLE_TIMEOUT_MS });
      return () => {
        live = false;
        window.cancelIdleCallback(id);
      };
    }
    const id = window.setTimeout(load, NO_IDLE_WAIT_MS);
    return () => {
      live = false;
      window.clearTimeout(id);
    };
  }, []);

  if (parts === null) {
    return null;
  }
  return (
    <>
      {parts.map((Part, at) => (
        <Part key={at} />
      ))}
    </>
  );
}
