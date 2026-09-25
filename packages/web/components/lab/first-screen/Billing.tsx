import { BILLING } from "./words";

/**
 * The four sponsors, named once and quietly, the way a poster names its studio
 * and its lab along the foot: one line, small, tracked out, set apart by rules.
 */
export function Billing({ className = "" }: { className?: string }) {
  return (
    <p
      data-first-billing
      className={`flex flex-wrap items-center gap-x-3 gap-y-1.5 font-mono text-[10px] uppercase tracking-[0.2em] text-text-faint ${className}`}
    >
      {BILLING.map((credit, index) => (
        <span key={credit} className="flex items-center gap-3">
          {index === 0 ? null : <span aria-hidden className="h-2.5 w-px bg-line-strong" />}
          <span className="whitespace-nowrap">{credit}</span>
        </span>
      ))}
    </p>
  );
}
