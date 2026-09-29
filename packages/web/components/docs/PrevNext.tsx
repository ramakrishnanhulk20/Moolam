import { getTranslations } from "next-intl/server";
import { pageHref } from "@/lib/docs/links";
import { navLabel, type NavPage } from "@/lib/docs/tree";
import { Link } from "@/lib/i18n/routing";

/**
 * The same arrow the passport's facts draw, turned to point back for Previous.
 * Typed "<" and ">" read as code on a page that is half code already.
 */
function Arrow({ back }: { back: boolean }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 10 10"
      className={`h-3 w-3 shrink-0 transition-transform duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] ${
        back ? "-scale-x-100 group-hover:-translate-x-1" : "group-hover:translate-x-1"
      }`}
    >
      <path d="M1 5h8M5.5 1.5 9 5 5.5 8.5" fill="none" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}

/**
 * The two doors out of a page, in the order the book is written. Between them
 * they walk the whole tree, so a reader who never touches the sidebar still
 * reads everything in the right order.
 */
export async function PrevNext({ previous, next }: { previous: NavPage | null; next: NavPage | null }) {
  const t = await getTranslations("docs");

  return (
    <nav className="mt-20 grid gap-px border-t border-line pt-px sm:grid-cols-2">
      {previous === null ? (
        <span className="hidden sm:block" />
      ) : (
        <Link href={pageHref(previous.slug)} className="docs-step group">
          <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-text-faint">{t("previous")}</span>
          <span className="flex items-center gap-2 font-display text-lg font-semibold text-text transition-colors duration-200 group-hover:text-accent">
            <Arrow back />
            {navLabel(previous)}
          </span>
        </Link>
      )}
      {next === null ? null : (
        <Link href={pageHref(next.slug)} className="docs-step group sm:text-right">
          <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-text-faint">{t("next")}</span>
          <span className="flex items-center gap-2 font-display text-lg font-semibold text-text transition-colors duration-200 group-hover:text-accent sm:justify-end">
            {navLabel(next)}
            <Arrow back={false} />
          </span>
        </Link>
      )}
    </nav>
  );
}
