"use client";

import { useState, type MouseEvent } from "react";
import { WarningMark } from "@/components/WarningMark";

/**
 * The name the route asked the file to be saved under, or the fallback when it
 * named none. Only the plain quoted form is read, which is the one form the
 * route writes (app/api/passports/[id]/picture).
 */
export function savedName(disposition: string | null, fallback: string): string {
  const quoted = disposition === null ? null : /filename="([^"]+)"/i.exec(disposition);
  return quoted?.[1] ?? fallback;
}

/** Whether a click is the plain one this control answers, and not a new tab or a save-as. */
function plainClick(event: MouseEvent<HTMLAnchorElement>): boolean {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

type Fetch = "idle" | "fetching" | "failed";

/**
 * Download the original, for the poster's credit line.
 *
 * The route can wait a minute on IPFS, and a plain download link showed nothing
 * for all of it, then only the browser's own failed-download notice. So a plain
 * press fetches the file here, with one line saying it is on its way and one
 * saying it did not come, in the reader's own language. The route's English
 * sentence is never shown. The link stays a real link, so a new tab or a
 * save-as still goes straight to the file.
 *
 * It returns parts of the credit line rather than a box of its own, so the
 * line's rules fall between them and the status line sits under the row. The
 * words arrive translated from the server poster.
 *
 * Its tap area reaches 4 px above the words and 24 px below, the mirror of Copy
 * link's, so where the line wraps and Download lands on the row under Copy link
 * neither covers the other's words (see ShareLink).
 */
export function DownloadOriginal({
  href,
  fallbackName,
  words,
}: {
  href: string;
  fallbackName: string;
  words: { download: string; downloading: string; downloadFailed: string };
}) {
  const [state, setState] = useState<Fetch>("idle");

  const fetchOriginal = async (event: MouseEvent<HTMLAnchorElement>) => {
    if (!plainClick(event)) {
      return;
    }
    event.preventDefault();
    if (state === "fetching") {
      return;
    }

    setState("fetching");
    try {
      const response = await fetch(href);
      if (!response.ok) {
        throw new Error(`the picture route answered ${response.status}`);
      }
      const file = URL.createObjectURL(await response.blob());
      const save = document.createElement("a");
      save.href = file;
      save.download = savedName(response.headers.get("content-disposition"), fallbackName);
      document.body.append(save);
      save.click();
      save.remove();
      // The browser has taken the file by the time this fires; the address is only freed.
      setTimeout(() => URL.revokeObjectURL(file), 10_000);
      setState("idle");
    } catch {
      setState("failed");
    }
  };

  return (
    <>
      <span>
        <a
          href={href}
          download
          data-download-original
          aria-busy={state === "fetching"}
          onClick={(event) => void fetchOriginal(event)}
          className="group/download relative inline-flex items-center gap-2 text-text-muted after:absolute after:inset-x-0 after:-top-1 after:-bottom-6 after:content-[''] transition-colors duration-200 hover:text-accent aria-busy:cursor-wait"
        >
          <span className="bg-[linear-gradient(currentColor,currentColor)] bg-[length:0%_1px] bg-left-bottom bg-no-repeat pb-0.5 transition-[background-size] duration-300 group-hover/download:bg-[length:100%_1px]">
            {words.download}
          </span>
          <span aria-hidden className="transition-transform duration-200 group-hover/download:translate-y-0.5">
            &darr;
          </span>
        </a>
      </span>
      {state === "fetching" ? (
        <span
          role="status"
          data-download-state="fetching"
          className="order-last flex basis-full items-center gap-2.5 font-body text-base normal-case tracking-normal text-pending"
        >
          <span aria-hidden className="motif h-2 w-2 shrink-0 bg-pending motion-safe:animate-pulse" />
          {words.downloading}
        </span>
      ) : state === "failed" ? (
        <span
          role="alert"
          data-download-state="failed"
          className="order-last flex basis-full items-start gap-2.5 font-body text-base normal-case tracking-normal text-failed"
        >
          <WarningMark className="mt-[5px]" />
          {words.downloadFailed}
        </span>
      ) : null}
    </>
  );
}
