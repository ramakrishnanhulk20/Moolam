"use client";

import { useEffect, useState } from "react";
import { WarningMark } from "@/components/WarningMark";

/**
 * The address to share: the page itself, without the fragment a facts link or a
 * jump left on it, so whoever opens it lands on the poster rather than halfway
 * down somebody else's scroll.
 */
export function pageAddress(href: string): string {
  const url = new URL(href);
  url.hash = "";
  return url.href;
}

type Copy = "idle" | "copied" | "failed";

/**
 * Copy link, for the poster's credit line. It returns parts of that line rather
 * than a box of its own, so the credit line's rules fall between them.
 *
 * Both labels are laid in the same cell, so the button is as wide as the longer
 * one in every language and the line never shifts when it confirms. A refusal
 * gets a line of its own under the row, because the sentence is far longer than
 * any label.
 *
 * The words arrive translated from the server poster, so the line needs no
 * translation context of its own.
 */
export function ShareLink({ words }: { words: { copy: string; copied: string; copyFailed: string } }) {
  const [copy, setCopy] = useState<Copy>("idle");

  useEffect(() => {
    if (copy !== "copied") {
      return;
    }
    const timer = setTimeout(() => setCopy("idle"), 2000);
    return () => clearTimeout(timer);
  }, [copy]);

  const press = () => {
    const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard;
    if (clipboard === undefined) {
      setCopy("failed");
      return;
    }
    clipboard.writeText(pageAddress(window.location.href)).then(
      () => setCopy("copied"),
      () => setCopy("failed"),
    );
  };

  const copied = copy === "copied";

  return (
    <>
      <span>
        <button
          type="button"
          onClick={press}
          data-copy-link
          className="group/share -my-3.5 inline-grid py-3.5 uppercase text-text-muted transition-colors duration-200 hover:text-accent"
        >
          <span
            className={`[grid-area:1/1] bg-[linear-gradient(currentColor,currentColor)] bg-[length:0%_1px] bg-left-bottom bg-no-repeat pb-0.5 transition-[background-size] duration-300 group-hover/share:bg-[length:100%_1px] ${copied ? "invisible" : ""}`}
          >
            {words.copy}
          </span>
          <span className={`[grid-area:1/1] text-verified ${copied ? "" : "invisible"}`}>{words.copied}</span>
        </button>
        <span role="status" className="sr-only">
          {copied ? words.copied : ""}
        </span>
      </span>
      {copy === "failed" ? (
        <span
          role="alert"
          data-copy-failed
          className="order-last flex basis-full items-start gap-2.5 font-body text-base normal-case tracking-normal text-failed"
        >
          <WarningMark className="mt-[5px]" />
          {words.copyFailed}
        </span>
      ) : null}
    </>
  );
}
