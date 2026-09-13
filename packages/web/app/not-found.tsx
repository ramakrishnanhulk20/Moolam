import Link from "next/link";
import { fontVariables } from "@/lib/fonts";
import { routing } from "@/lib/i18n/routing";
import messages from "@/messages/en.json";
import "@/styles/globals.css";

/**
 * The same page, for an address with no language in it at all.
 *
 * The root layout is a pass-through: every real page lives under a locale and
 * that layout carries the html and body tags. A miss above the locale segment
 * never reaches it, so this page carries its own shell, its own fonts and the
 * English words, and every link goes to the default language.
 */
export default function RootNotFound() {
  const t = messages.notFound;
  const home = `/${routing.defaultLocale}`;

  return (
    <html lang={routing.defaultLocale} className={fontVariables}>
      <body className="min-h-dvh bg-bg text-text antialiased">
        <div className="relative mx-auto flex min-h-dvh w-full max-w-[1400px] flex-col justify-center px-5 py-24 sm:px-8">
          <span aria-hidden className="motif rise h-12 w-12 sm:h-16 sm:w-16" />

          <p
            className="rise mt-10 font-mono text-[11px] uppercase tracking-[0.28em] text-text-faint"
            style={{ animationDelay: "60ms" }}
          >
            {t.code}
          </p>

          <h1
            className="rise mt-5 max-w-[14ch] font-display text-[clamp(2.6rem,9vw,6.5rem)] font-semibold uppercase leading-[0.88] tracking-[-0.035em]"
            style={{ animationDelay: "110ms" }}
          >
            {t.title}
          </h1>

          <p
            className="rise mt-8 max-w-[46ch] text-base leading-relaxed text-text-muted sm:text-lg"
            style={{ animationDelay: "170ms" }}
          >
            {t.lede}
          </p>

          <nav className="rise mt-12 flex flex-wrap items-center gap-3" style={{ animationDelay: "230ms" }}>
            {[
              { href: `${home}/explore`, label: t.explore },
              { href: `${home}/verify`, label: t.verify },
              { href: `${home}/docs`, label: t.docs },
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
      </body>
    </html>
  );
}
