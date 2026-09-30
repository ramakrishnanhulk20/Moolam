"use client";

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import type { GalleryAnswer } from "@/lib/gallery";

export type GalleryView = { state: "loading" } | GalleryAnswer;

interface GalleryContext {
  view: GalleryView;
  reload: () => void;
}

const Context = createContext<GalleryContext>({ view: { state: "loading" }, reload: () => {} });

/**
 * Reads the gallery once for the whole page, so the hero and the grid draw the
 * same pictures from one request. The server holds its answer for a minute, so
 * asking again never reaches the index more often than that.
 */
export function GalleryData({ children }: { children: ReactNode }) {
  const [view, setView] = useState<GalleryView>({ state: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    fetch("/api/gallery", { cache: "no-store" })
      .then(async (response) => (await response.json()) as GalleryAnswer)
      .then((answer) => {
        if (live) {
          setView(answer.state === "ready" ? answer : { state: "unavailable", readAt: Date.now() });
        }
      })
      .catch(() => {
        if (live) {
          setView({ state: "unavailable", readAt: Date.now() });
        }
      });
    return () => {
      live = false;
    };
  }, [attempt]);

  const reload = useCallback(() => {
    setView({ state: "loading" });
    setAttempt((count) => count + 1);
  }, []);

  return <Context.Provider value={{ view, reload }}>{children}</Context.Provider>;
}

export function useGallery(): GalleryContext {
  return useContext(Context);
}
