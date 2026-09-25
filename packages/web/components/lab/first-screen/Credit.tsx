import { Link } from "@/lib/i18n/routing";
import type { Line } from "./lines";
import { WORDS } from "./words";

const INK: Record<Line["tone"], string> = {
  proof: "text-accent",
  plain: "text-text",
  miss: "text-failed",
};

/**
 * The live finding, set as a poster's credit block: one run of small capitals,
 * tight, every figure in it read from the registry, the consent register or
 * the verify service while this page was drawn.
 */
export function Credit({
  title,
  registered,
  href,
  lines,
  className = "",
}: {
  title: string;
  registered: string;
  href: string;
  lines: Line[];
  className?: string;
}) {
  return (
    <div data-first-finding className={className}>
      <p className="flex items-center gap-3 font-mono text-[10px] uppercase tracking-[0.24em] text-text-faint">
        <span aria-hidden className="relative flex h-2 w-2">
          <span className="absolute inset-0 animate-ping bg-verified/60" />
          <span className="relative h-2 w-2 bg-verified" />
        </span>
        Live finding, read while this page was drawn
      </p>
      <p className="mt-3 max-w-[80ch] font-display text-[12px] font-semibold uppercase leading-[1.5] tracking-[0.01em] text-text-muted sm:text-[13px]">
        <span className="block">
          <span className="text-text">{title}</span>, registered {registered}.
        </span>
        {lines.map((line) => (
          <span key={line.lead} className="block">
            {line.lead} <span className={INK[line.tone]}>{line.fact}</span>.
          </span>
        ))}
        <Link
          href={href}
          className="tap whitespace-nowrap text-text underline decoration-line-strong underline-offset-4 transition-colors duration-200 hover:text-accent hover:decoration-accent"
        >
          {WORDS.openPassport}
        </Link>
      </p>
    </div>
  );
}
