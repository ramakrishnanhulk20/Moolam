import { useTranslations } from "next-intl";

/** The four sponsors, once each, in the order the product meets them. Their names are never translated. */
const CREDITS = ["monad", "privy", "chainlink", "envio"] as const;

/**
 * The four sponsors, named once and quietly, the way a poster names its studio
 * and its lab along the foot: one line, small, tracked out, set apart by rules.
 *
 * Every name carries its rule in front of it, and the row is pulled left by
 * exactly one rule and its gap into a clipped edge. Whichever name opens a
 * row, the first one or one that wrapped, has its rule hidden there, so a
 * wrapped row never starts with a stray rule (French wraps at 1440).
 */
export function Billing({ className = "" }: { className?: string }) {
  const t = useTranslations("home.first.billing");

  return (
    <p data-first-billing className={`overflow-hidden font-mono text-[11px] uppercase tracking-[0.2em] text-text-faint lg:tracking-[0.1em] ${className}`}>
      <span className="-ms-[13px] flex flex-wrap items-center gap-x-3 gap-y-1.5">
        {CREDITS.map((credit) => (
          <span key={credit} data-credit className="flex items-center gap-3">
            <span aria-hidden className="h-2.5 w-px shrink-0 bg-line-strong" />
            <span className="whitespace-nowrap">{t(credit)}</span>
          </span>
        ))}
      </span>
    </p>
  );
}
