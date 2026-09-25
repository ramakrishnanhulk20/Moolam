import { getTranslations } from "next-intl/server";

/**
 * The top of every page: the group it belongs to, the headline at display size,
 * and the rule that draws itself under both. Server rendered, so the entrance
 * runs in the first painted frame with no script behind it.
 */
export async function Masthead({ section, title }: { section: string | null; title: string }) {
  const t = await getTranslations("docs");

  return (
    <header className="docs-masthead" data-motif="seal">
      {/* A page outside any group would label itself "Documentation", which
          the bar above already says beside the search box on a laptop. There
          the bar's word is the one kept; on a phone the bar has no room for it,
          so the kicker stays. */}
      <p
        data-docs-kicker
        className={`rise flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.28em] text-accent ${
          section === null ? "lg:hidden" : ""
        }`}
        style={{ animationDelay: "40ms" }}
      >
        <span aria-hidden className="motif h-[7px] w-[7px]" />
        {section ?? t("home")}
      </p>
      <h1
        className="rise mt-4 font-display text-[clamp(2.1rem,5.4vw,3.9rem)] font-bold leading-[0.95] tracking-[-0.03em] text-text"
        style={{ animationDelay: "110ms" }}
      >
        {title}
      </h1>
      <span aria-hidden className="docs-rule" />
    </header>
  );
}
