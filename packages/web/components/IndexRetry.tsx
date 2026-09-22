"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { PRESS_QUIET_SECONDS, isRateLimited, tick, waitBefore } from "./retryPlan";

/**
 * The way back from an index that would not answer.
 *
 * Wherever a page prints "the index could not be read" it also counts down and
 * asks again, because what a reader met is usually a busy minute on a shared
 * endpoint rather than anything about this site. Three tries, each wait longer
 * than the last, one request per try and none at all while the tab is hidden.
 * After the third it says the one thing that is still true: the registry is on
 * Monad and a passport page reads the chain itself.
 *
 * The button outlives the schedule, because a reader who waited out a busy
 * minute deserves a way back. It goes quiet for ten seconds after each press,
 * so the way back is one request at a time however hard it is pressed.
 *
 * `again` is for a piece of the page that knows how to fetch itself, like the
 * Load more button. Everything else is a server render, so the default is to ask
 * the router for the page again, which keeps the reader where they are and keeps
 * whatever is already under them.
 */
export function IndexRetry({ said, again }: { said: string; again?: () => void }) {
  const t = useTranslations("retry");
  const router = useRouter();
  const rateLimited = isRateLimited(said);

  const [tried, setTried] = useState(0);
  const wait = waitBefore(tried, rateLimited);
  const [left, setLeft] = useState(wait ?? 0);
  const [asking, startAsking] = useTransition();
  // True while the button is sitting out its ten seconds after a press.
  const [quiet, setQuiet] = useState(false);

  // One request per try, whichever of the two ways it was reached: the countdown
  // running out, or a reader pressing the button a moment before it did.
  const fired = useRef(-1);

  const ask = () => {
    startAsking(() => {
      if (again === undefined) {
        router.refresh();
      } else {
        again();
      }
    });
  };

  const fire = () => {
    if (wait === null) {
      // The schedule is over and this press is the reader's own. It is answered
      // once, and then the button holds still long enough that a second press
      // is a decision rather than a repeat.
      if (quiet || asking) {
        return;
      }
      setQuiet(true);
      ask();
      return;
    }

    if (fired.current === tried) {
      return;
    }
    fired.current = tried;

    // The next wait goes up in the same update as the try it follows, so the
    // countdown never sits at a zero that would read as a second try.
    const next = tried + 1;
    setTried(next);
    setLeft(waitBefore(next, rateLimited) ?? 0);

    ask();
  };

  useEffect(() => {
    if (!quiet) {
      return;
    }
    const timer = setTimeout(() => setQuiet(false), PRESS_QUIET_SECONDS * 1_000);
    return () => clearTimeout(timer);
  }, [quiet]);

  // The countdown below is started once per try and must not be restarted every
  // time this component draws, so it reaches for the current try through here
  // rather than through its own dependencies.
  const latest = useRef(fire);
  useEffect(() => {
    latest.current = fire;
  });

  useEffect(() => {
    if (wait === null) {
      return;
    }

    let seconds = wait;
    let timer: ReturnType<typeof setInterval> | null = null;

    const stop = () => {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    };

    const start = () => {
      if (timer !== null) {
        return;
      }
      timer = setInterval(() => {
        seconds = tick(seconds, document.visibilityState === "visible");
        setLeft(seconds);
        if (seconds === 0) {
          stop();
          latest.current();
        }
      }, 1_000);
    };

    // A tab nobody is looking at has no timer at all, rather than one that wakes
    // every second to decide it has nothing to do. The countdown picks up from
    // the second it stopped on when the reader comes back to it.
    const watch = () => {
      if (document.visibilityState === "visible") {
        start();
      } else {
        stop();
      }
    };

    watch();
    document.addEventListener("visibilitychange", watch);

    return () => {
      stop();
      document.removeEventListener("visibilitychange", watch);
    };
  }, [tried, wait]);

  return (
    <div className="mt-5 flex flex-wrap items-center gap-x-5 gap-y-3">
      {wait === null ? (
        <p role="status" className="max-w-[54ch] text-sm leading-relaxed text-text-muted">
          {t("stopped")}
        </p>
      ) : (
        <p className="flex items-center gap-2.5 font-mono text-[10px] uppercase tracking-[0.2em] text-text-faint">
          <span aria-hidden className={`motif h-[7px] w-[7px] ${asking ? "animate-pulse opacity-100" : "opacity-50"}`} />
          {asking ? t("trying") : t("countdown", { seconds: left })}
        </p>
      )}

      <button
        type="button"
        onClick={fire}
        disabled={asking || quiet}
        className="tap rounded-[8px] border border-line-strong px-4 py-2 font-mono text-[10px] uppercase tracking-[0.2em] text-text transition-colors duration-200 hover:border-accent hover:text-accent disabled:cursor-wait disabled:text-text-faint"
      >
        {t("now")}
      </button>
    </div>
  );
}
