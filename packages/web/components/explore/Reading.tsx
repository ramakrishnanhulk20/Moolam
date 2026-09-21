"use client";

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";

interface Reading {
  /** True while a chip or the search box is waiting for the sheet it asked for. */
  reading: boolean;
  /** Says a read has started, and answers with the call that says it has finished. */
  hold: () => () => void;
}

const Held = createContext<Reading>({ reading: false, hold: () => () => undefined });

/**
 * Whether the sheet on screen is the one the chips say it is.
 *
 * Pressing a chip is a full server render of about a second: the index is
 * scanned and a pinned document is read for every row it walks past. Until this
 * existed the page sat there looking finished, and a reader pressed again. The
 * chip that was pressed and the grid it is about to replace both read this, so
 * the whole sheet says it is working with one piece of state rather than three
 * that could disagree.
 *
 * It counts rather than flags: a reader who presses two chips in a row has two
 * navigations in flight, and the first one finishing must not clear the mark
 * the second one is still waiting on.
 */
export function ReadingProvider({ children }: { children: ReactNode }) {
  const [readers, setReaders] = useState(0);

  const hold = useCallback(() => {
    setReaders((count) => count + 1);
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      setReaders((count) => Math.max(0, count - 1));
    };
  }, []);

  const value = useMemo(() => ({ reading: readers > 0, hold }), [readers, hold]);

  return <Held.Provider value={value}>{children}</Held.Provider>;
}

export function useReading(): Reading {
  return useContext(Held);
}
