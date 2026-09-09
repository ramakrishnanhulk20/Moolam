"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";

/** Copies one value and says so for a second and a half, then goes quiet again. */
export function CopyButton({ value }: { value: string }) {
  const t = useTranslations("common");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) {
      return;
    }
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard.writeText(value).then(() => setCopied(true));
      }}
      className="rounded-[8px] border border-line px-2 py-1 font-mono text-[10px] uppercase tracking-[0.16em] text-text-faint transition-colors duration-200 hover:border-accent hover:text-accent"
    >
      {copied ? t("copied") : t("copy")}
    </button>
  );
}
