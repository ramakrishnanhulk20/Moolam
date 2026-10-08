"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "@/lib/i18n/routing";
import { refreshPassport } from "@/lib/passport/refresh";

const WINDOW_MS = 15 * 60_000;
const FAST_FOR_MS = 3 * 60_000;
const FAST_EVERY_MS = 15_000;
const SLOW_EVERY_MS = 60_000;

/**
 * How long to wait before the next look at this passport, or null once the
 * window after registration is over.
 */
export function nextDelayMs(nowMs: number, mountedAtMs: number, registeredAtS: number): number | null {
  if (nowMs >= registeredAtS * 1000 + WINDOW_MS) {
    return null;
  }
  return nowMs < mountedAtMs + FAST_FOR_MS ? FAST_EVERY_MS : SLOW_EVERY_MS;
}

/**
 * Draws nothing. A passport waits for its Chainlink verdict for seconds to a
 * minute, and each tick costs the site a fresh read of the chain and the index,
 * so the window is bounded to 15 minutes after registration and slows to once a
 * minute after three minutes.
 */
export function LiveRefresh({ passportId, registeredAt }: { passportId: string; registeredAt: number }): null {
  const router = useRouter();
  const routerRef = useRef(router);
  useEffect(() => {
    routerRef.current = router;
  });

  useEffect(() => {
    const mountedAtMs = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;

    const schedule = () => {
      const delay = nextDelayMs(Date.now(), mountedAtMs, registeredAt);
      if (delay === null || stopped) {
        return;
      }
      timer = setTimeout(tick, delay);
    };

    const tick = async () => {
      if (document.visibilityState === "visible") {
        try {
          await refreshPassport(passportId);
          if (stopped) {
            return;
          }
          routerRef.current.refresh();
        } catch {
          // A failed look is not the end of the wait: the next tick tries again.
        }
      }
      schedule();
    };

    schedule();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [passportId, registeredAt]);

  return null;
}
