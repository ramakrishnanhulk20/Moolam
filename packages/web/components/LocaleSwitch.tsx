"use client";

import { useParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useTransition } from "react";
import { routing, usePathname, useRouter } from "@/lib/i18n/routing";

/**
 * Switches language without leaving the page: the pathname next-intl hands back
 * has the locale segment stripped, so the same route is re-rendered in the other
 * language with its params intact.
 */
export function LocaleSwitch() {
  const t = useTranslations("header");
  const router = useRouter();
  const pathname = usePathname();
  const params = useParams();
  const [pending, startTransition] = useTransition();
  const active = typeof params.locale === "string" ? params.locale : routing.defaultLocale;

  return (
    <div className="flex items-center gap-1" aria-label={t("language")}>
      {routing.locales.map((locale) => (
        <button
          key={locale}
          type="button"
          disabled={pending}
          aria-current={locale === active ? "true" : undefined}
          onClick={() =>
            startTransition(() => {
              router.replace(pathname, { locale });
            })
          }
          className={
            locale === active
              ? "rounded-[8px] border border-accent px-2.5 py-1.5 text-xs uppercase tracking-[0.18em] text-accent"
              : "rounded-[8px] border border-transparent px-2.5 py-1.5 text-xs uppercase tracking-[0.18em] text-text-faint transition-colors duration-200 hover:border-line hover:text-text"
          }
        >
          {t(`locale.${locale}`)}
        </button>
      ))}
    </div>
  );
}
