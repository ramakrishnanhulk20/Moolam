"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Hex } from "viem";
import { readRecheckStatus, requestRecheck } from "@/lib/verifier/client";
import {
  describeRecheckFailure,
  idleRecheck,
  nextPollDelay,
  pollsSpent,
  stateFromRequest,
  stateFromStatus,
  type RecheckState,
} from "./state";

/**
 * The reader's side of the re-check queue: ask for one, and watch where it got to.
 *
 * Nothing here spends anything and nothing here needs a wallet. A request is a
 * line in the verify service's queue, and the Chainlink run it leads to happens
 * on a runner's machine, which is why this is the one control in the app that
 * anybody can press.
 *
 * Two rules shape the rest of it. A page must not turn into a refresh loop on a
 * shared service, so it asks once on arrival, then once a minute while
 * something is really in flight, never while the tab is in the background, and
 * it stops after half an hour and hands the reader the button. And a read that
 * did not come back cleanly changes nothing on the screen: the button stays
 * where it was rather than the page inventing a verdict out of silence.
 */
export interface RecheckControl {
  state: RecheckState;
  /** True once the control has stopped asking on its own, so the next ask is the reader's own. */
  spent: boolean;
  /** True while a read is out, so a button the reader presses can hold still. */
  checking: boolean;
  actions: {
    request: () => void;
    check: () => void;
  };
}

export function useRecheckRequest({
  passportId,
  onDone,
}: {
  passportId: Hex;
  /** Called once, when a re-check finishes, so the page can read the new verdict. */
  onDone?: () => void | Promise<void>;
}): RecheckControl {
  const [state, setState] = useState<RecheckState>(idleRecheck);
  const [asked, setAsked] = useState(0);
  const [checking, setChecking] = useState(false);

  const live = useRef(true);
  // One call at a time, whichever of the three ways it was reached: the first
  // read, the minute timer, or a press. A flag read straight after a dispatch
  // would be a stale flag, so it is kept out of the state.
  const busy = useRef(false);
  const told = useRef(false);
  const stop = useRef<AbortController | null>(null);

  const onDoneRef = useRef(onDone);
  useEffect(() => {
    onDoneRef.current = onDone;
  });

  /** The one place a new state lands, so the finished call is made exactly once. */
  const settle = useCallback((next: RecheckState) => {
    setState(next);
    if (next.kind === "done" && !told.current) {
      told.current = true;
      void onDoneRef.current?.();
    }
  }, []);

  const read = useCallback(async () => {
    if (busy.current) {
      return;
    }
    busy.current = true;
    const controller = new AbortController();
    stop.current = controller;

    const lookup = await readRecheckStatus(passportId, { signal: controller.signal });

    // An answer to a call that has since been dropped belongs to nobody: the
    // call that replaced it owns the flag and will clear it itself.
    if (stop.current !== controller) {
      return;
    }
    busy.current = false;
    if (!live.current) {
      return;
    }
    setChecking(false);
    // A service that could not say leaves the screen exactly as it was. There
    // is nothing honest to draw from silence, and the button is already there.
    if (lookup.state === "unknown") {
      return;
    }
    settle(lookup.state === "none" ? idleRecheck : stateFromStatus(lookup.status));
  }, [passportId, settle]);

  const request = useCallback(() => {
    if (busy.current) {
      return;
    }
    busy.current = true;
    setState({ kind: "sending" });
    const controller = new AbortController();
    stop.current = controller;

    void (async () => {
      try {
        const answer = await requestRecheck(passportId, { signal: controller.signal });
        if (live.current && stop.current === controller) {
          settle(stateFromRequest(answer));
          // The minute timer starts again from this press rather than from
          // whatever the page was doing before it.
          setAsked(0);
        }
      } catch (error) {
        if (live.current && stop.current === controller) {
          setState(describeRecheckFailure(error));
        }
      } finally {
        if (stop.current === controller) {
          busy.current = false;
        }
      }
    })();
  }, [passportId, settle]);

  // The reader's own look, which is the only read that shows its work: the
  // first one and the minute timer happen behind the page, and a button that
  // greyed itself out on a schedule nobody asked for would be noise.
  const check = useCallback(() => {
    setAsked(0);
    setChecking(true);
    void read();
  }, [read]);

  // One read on arrival. The route holds its answer for 30 seconds, so a room
  // full of readers on the same passport costs the service two reads a minute.
  //
  // Nothing is reset here, because nothing has to be: the control is drawn
  // under its passport's own key, so another passport is another instance with
  // a state of its own rather than this one being emptied and refilled.
  useEffect(() => {
    live.current = true;
    // Started inside a turn of its own so that nothing this effect does lands
    // in the same render pass: the answer comes back later and sets the state
    // from there, the way any other outside system reports in.
    void (async () => {
      await read();
    })();

    return () => {
      live.current = false;
      stop.current?.abort();
      // The call this screen was waiting on is dropped, flag and all. React
      // mounts a component twice in development, and a leftover flag there
      // would swallow the second mount's read and leave the control with no
      // answer at all.
      stop.current = null;
      busy.current = false;
    };
  }, [read]);

  useEffect(() => {
    const seen = (): boolean => typeof document === "undefined" || document.visibilityState === "visible";
    let timer: ReturnType<typeof setTimeout> | null = null;

    const clear = (): void => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    };

    const start = (): void => {
      if (timer !== null) {
        return;
      }
      const delay = nextPollDelay(state, asked, seen());
      if (delay === null) {
        return;
      }
      timer = setTimeout(() => {
        timer = null;
        setAsked((count) => count + 1);
        void read();
      }, delay);
    };

    // A tab nobody is looking at has no timer at all, rather than one that wakes
    // every minute to decide it has nothing to do. Coming back starts a fresh
    // minute instead of firing at once, because a service that was left alone
    // for an hour should not meet a burst the moment the tab is picked up.
    const watch = (): void => {
      if (seen()) {
        start();
      } else {
        clear();
      }
    };

    watch();
    document.addEventListener("visibilitychange", watch);
    return () => {
      clear();
      document.removeEventListener("visibilitychange", watch);
    };
  }, [state, asked, read]);

  return {
    state,
    spent: pollsSpent(state, asked),
    checking,
    actions: { request, check },
  };
}
