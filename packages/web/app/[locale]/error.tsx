"use client";

import { useTranslations } from "next-intl";
import { Link } from "@/lib/i18n/routing";

/**
 * The page a render that failed lands on: a chain read that threw where the
 * page had no answer for it, a component that broke under a reader it did not
 * expect.
 *
 * It is the shape of the not-found page on purpose, because a visitor who hits
 * either one wants the same three things: what happened, one plain way to try
 * the same page again, and the ways on. The error's own message and stack are
 * never printed: they name internals, and on this app an endpoint can itself be
 * a credential.
 */
export default function LocaleError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const t = useTranslations("error");
  const back = useTranslations("notFound");

  return (
    <div className="relative mx-auto flex min-h-[70vh] w-full max-w-[1400px] flex-col justify-center px-5 py-24 sm:px-8">
      <span aria-hidden className="motif rise h-12 w-12 sm:h-16 sm:w-16" />

      <p
        className="rise mt-10 font-mono text-[11px] uppercase tracking-[0.28em] text-text-faint"
        style={{ animationDelay: "60ms" }}
      >
        {t("code")}
      </p>

      <h1
        className="rise mt-5 max-w-[14ch] font-display text-[clamp(2.6rem,9vw,6.5rem)] font-semibold uppercase leading-[0.88] tracking-[-0.035em]"
        style={{ animationDelay: "110ms" }}
      >
        {t("title")}
      </h1>

      <p
        className="rise mt-8 max-w-[46ch] text-base leading-relaxed text-text-muted sm:text-lg"
        style={{ animationDelay: "170ms" }}
      >
        {t("lede")}
      </p>

      <nav className="rise mt-12 flex flex-wrap items-center gap-3" style={{ animationDelay: "230ms" }}>
        <button
          type="button"
          onClick={reset}
          className="rounded-[8px] bg-accent px-5 py-3 text-xs font-semibold uppercase tracking-[0.16em] text-accent-ink transition-transform duration-200 hover:-translate-y-0.5"
        >
          {t("retry")}
        </button>
        {[
          { href: "/explore", label: back("explore") },
          { href: "/verify", label: back("verify") },
          { href: "/docs", label: back("docs") },
        ].map((link) => (
          <Link
            key={link.href}
            href={link.href}
            className="rounded-[8px] border border-line-strong px-5 py-3 font-mono text-[11px] uppercase tracking-[0.18em] text-text transition-colors duration-200 hover:border-accent hover:text-accent"
          >
            {link.label}
          </Link>
        ))}
      </nav>
    </div>
  );
}
