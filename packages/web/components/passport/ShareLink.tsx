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

type Copy = "idle" | "copied" | { failed: string };

/**
 * Copy link, for the poster's credit line. It returns parts of that line rather
 * than a box of its own, so the credit line's rules fall between them.
 *
 * Both labels are laid in the same cell, so the button is as wide as the longer
 * one in every language and the line never shifts when it confirms. Each starts
 * at the cell's start edge: a button centres its words, which set the shorter
 * label 9 px in from the line above and slid it left when it changed. A refusal
 * gets a line of its own under the row, because the sentence is far longer than
 * any label, with the address under it ready to select, since the sentence asks
 * the reader to copy it by hand.
 *
 * The tap area is an invisible layer, 24 px above the words and 4 px below,
 * rather than padding all round. Where the credit line wraps, Download sits on
 * the next row 4 px down, and an even pad let its area cover these words, so a
 * tap meant to copy downloaded the file. Download's layer reaches the other way,
 * so the two meet in the gap and never cover each other's words, and the line
 * keeps its height. The focus ring stays on the words.
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
    const address = pageAddress(window.location.href);
    const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard;
    if (clipboard === undefined) {
      setCopy({ failed: address });
      return;
    }
    clipboard.writeText(address).then(
      () => setCopy("copied"),
      () => setCopy({ failed: address }),
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
          className="group/share relative inline-grid justify-items-start text-start uppercase after:absolute after:inset-x-0 after:-top-6 after:-bottom-1 after:content-[''] text-text-muted transition-colors duration-200 hover:text-accent"
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
      {typeof copy === "object" ? (
        <span
          role="alert"
          data-copy-failed
          className="order-last flex basis-full items-start gap-2.5 font-body text-base normal-case tracking-normal text-failed"
        >
          <WarningMark className="mt-[5px]" />
          <span className="min-w-0">
            <span className="block">{words.copyFailed}</span>
            <span
              data-copy-address
              className="mt-1.5 block select-all font-mono text-[11px] text-text-muted [overflow-wrap:anywhere]"
            >
              {copy.failed}
            </span>
          </span>
        </span>
      ) : null}
    </>
  );
}
