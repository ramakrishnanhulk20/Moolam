"use client";

import { useTranslations } from "next-intl";
import { useEffect, useState, type CSSProperties, type ReactNode } from "react";

export type CopyResult = "copied" | "failed";

/**
 * Hands the text to the clipboard and says how it went. A browser can refuse:
 * no clipboard at all outside a secure page, or a rejected write when the page
 * is not focused or permission is denied. Either way the reader is told, rather
 * than the button sitting still as if nothing was pressed.
 */
export async function copyText(
  text: string,
  clipboard: Pick<Clipboard, "writeText"> | undefined = typeof navigator === "undefined"
    ? undefined
    : navigator.clipboard,
): Promise<CopyResult> {
  if (clipboard === undefined) {
    return "failed";
  }
  try {
    await clipboard.writeText(text);
    return "copied";
  } catch {
    return "failed";
  }
}

/**
 * A highlighted block with the one thing a reader wants from it: the text, in
 * the clipboard. The highlighting itself is done at build time, so nothing about
 * this block costs the reader anything until they press the button.
 */
export function CodeBlock({
  code,
  className,
  style,
  children,
}: {
  code: string;
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
}) {
  const t = useTranslations("docs");
  const common = useTranslations("common");
  const [result, setResult] = useState<CopyResult | null>(null);

  useEffect(() => {
    if (result === null) {
      return;
    }
    // The failure line asks the reader to do something, so it stays long enough to be read.
    const timer = setTimeout(() => setResult(null), result === "failed" ? 5000 : 1500);
    return () => clearTimeout(timer);
  }, [result]);

  return (
    <div className="docs-code group">
      <button
        type="button"
        onClick={() => {
          void copyText(code).then(setResult);
        }}
        className="docs-copy"
      >
        {result === "copied" ? t("copied") : t("copy")}
      </button>
      {/* Always in the page, so a screen reader is already listening when the
          refusal lands in it. It sits under the button: the answer shows where
          the press was. */}
      <div role="status" className="docs-copy-failed">
        {result === "failed" ? common("copyFailed") : ""}
      </div>
      <pre className={className} style={style}>
        {children}
      </pre>
    </div>
  );
}
