import { getTranslations } from "next-intl/server";
import { Link } from "@/lib/i18n/routing";

/**
 * The page a wrong address lands on: an id that is not a passport, an agent the
 * registry never minted, a link that changed.
 *
 * It is the product's own page rather than the framework's, because the two
 * most likely ways to arrive here are a mistyped passport id and agent 0, and
 * both of those deserve a sentence that says what happened and three ways on.
 */
export default async function NotFound() {
  const t = await getTranslations("notFound");

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

      <nav
        className="rise mt-12 flex flex-wrap items-center gap-3"
        style={{ animationDelay: "230ms" }}
        aria-label={t("title")}
      >
        {[
          { href: "/explore", label: t("explore") },
          { href: "/verify", label: t("verify") },
          { href: "/docs", label: t("docs") },
        ].map((link) => (
          <Link
            key={link.href}
            href={link.href}
            className="inline-flex min-h-11 items-center rounded-[8px] border border-line-strong px-5 py-3 font-mono text-[11px] uppercase tracking-[0.18em] text-text transition-colors duration-200 hover:border-accent hover:text-accent"
          >
            {link.label}
          </Link>
        ))}
      </nav>
    </div>
  );
}
