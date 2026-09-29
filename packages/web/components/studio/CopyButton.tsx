"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { WarningMark } from "@/components/WarningMark";

type Copied = "idle" | "copied" | "failed";

/**
 * Writes one value to the clipboard and says whether it went.
 *
 * A browser can refuse the clipboard outright (no secure context, no
 * permission), in which case there is no clipboard object at all, or it can
 * reject the write. Both come back as "failed" rather than a silent button.
 */
export async function copyValue(
  value: string,
  clipboard: Pick<Clipboard, "writeText"> | undefined = globalThis.navigator?.clipboard,
): Promise<Exclude<Copied, "idle">> {
  if (clipboard === undefined) {
    return "failed";
  }
  try {
    await clipboard.writeText(value);
    return "copied";
  } catch {
    return "failed";
  }
}

/**
 * Copies one value and says so for a second and a half, then goes quiet again.
 *
 * Both labels are laid in the same cell and only one is visible, so the button
 * is always as wide as the longer of them: in Tamil "Copied" is three times
 * the length of "Copy", and the row it sits in used to shift sideways on every
 * press. A refused copy says so beside the button and stays until the next
 * press, since what it asks the reader to do takes longer than a second.
 */
export function CopyButton({ value }: { value: string }) {
  const t = useTranslations("common");
  const [state, setState] = useState<Copied>("idle");

  useEffect(() => {
    if (state !== "copied") {
      return;
    }
    const timer = setTimeout(() => setState("idle"), 1500);
    return () => clearTimeout(timer);
  }, [state]);

  const copied = state === "copied";

  return (
    <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1">
      <button
        type="button"
        onClick={() => {
          void copyValue(value).then(setState);
        }}
        className="rounded-[8px] border border-line px-2 py-1 font-mono text-[10px] uppercase tracking-[0.16em] text-text-faint transition-colors duration-200 hover:border-accent hover:text-accent"
      >
        <span className="grid">
          <span data-copy-label aria-hidden={copied} className={`col-start-1 row-start-1 ${copied ? "invisible" : ""}`}>
            {t("copy")}
          </span>
          <span data-copy-label aria-hidden={!copied} className={`col-start-1 row-start-1 ${copied ? "" : "invisible"}`}>
            {t("copied")}
          </span>
        </span>
      </button>
      {state === "failed" ? (
        <span role="alert" data-copy-failed className="flex max-w-[34ch] items-start gap-2 text-xs leading-relaxed text-failed">
          <WarningMark className="mt-[1px]" />
          <span className="min-w-0">{t("copyFailed")}</span>
        </span>
      ) : null}
    </span>
  );
}
