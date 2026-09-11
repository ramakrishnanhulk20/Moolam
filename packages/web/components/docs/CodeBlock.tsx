"use client";

import { useTranslations } from "next-intl";
import { useEffect, useState, type CSSProperties, type ReactNode } from "react";

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
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) {
      return;
    }
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  return (
    <div className="docs-code group">
      <button
        type="button"
        onClick={() => {
          void navigator.clipboard.writeText(code).then(() => setCopied(true));
        }}
        className="docs-copy"
      >
        {copied ? t("copied") : t("copy")}
      </button>
      <pre className={className} style={style}>
        {children}
      </pre>
    </div>
  );
}
