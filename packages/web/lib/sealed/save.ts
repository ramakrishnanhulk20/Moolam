"use client";

import { useCallback, useEffect, useRef } from "react";
import type { SealedHandback } from "./handback";

/**
 * Hands the sealed file to the browser's own downloader.
 *
 * The object URL is made once and given back to the caller, because the same
 * file may be saved again from the receipt and a second URL for the same bytes
 * is a second copy of them in memory. Nothing here touches the network: the
 * bytes never left this tab.
 */
export function saveSealedFile(file: SealedHandback, made: string | null): string {
  const url = made ?? URL.createObjectURL(file.blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = file.name;
  anchor.rel = "noopener";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  return url;
}

/**
 * The save control's side of the same thing: one URL per file, revoked when the
 * panel holding it goes away or a new file takes its place.
 */
export function useSealedSave(file: SealedHandback | null, onSaved?: () => void): () => void {
  const made = useRef<string | null>(null);

  useEffect(() => {
    return () => {
      if (made.current !== null) {
        URL.revokeObjectURL(made.current);
        made.current = null;
      }
    };
  }, [file]);

  return useCallback(() => {
    if (file === null) {
      return;
    }
    made.current = saveSealedFile(file, made.current);
    onSaved?.();
  }, [file, onSaved]);
}

/**
 * Warns before the page is left while the only copy of a picture is still in
 * this tab's memory and nowhere else.
 *
 * Browsers show their own words here rather than any this app could write, so
 * there is nothing to translate: the flag is the whole behaviour. It is taken
 * off the moment the file has been saved, because a warning that fires when
 * nothing is at stake is one people learn to click through.
 */
export function useUnsavedFileWarning(holding: boolean): void {
  useEffect(() => {
    if (!holding) {
      return;
    }
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [holding]);
}
