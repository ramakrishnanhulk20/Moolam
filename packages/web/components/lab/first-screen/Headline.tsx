import { Link } from "@/lib/i18n/routing";
import { WORDS } from "./words";

/**
 * The why and the headline, drawn on the server so a slow phone reads them from
 * the first byte. They rise on CSS, never on script, and a reader who asked for
 * less motion gets them standing still.
 */
export function Headline({ size, className = "" }: { size: "poster" | "board"; className?: string }) {
  return (
    <div className={className}>
      <p className="rise flex items-center gap-3 font-mono text-[11px] uppercase tracking-[0.28em] text-accent">
        <span className="motif h-[10px] w-[10px]" />
        {WORDS.kicker}
      </p>
      <h1
        data-first-line
        style={{ animationDelay: "70ms" }}
        className={`rise mt-5 font-display font-semibold uppercase leading-[0.9] tracking-[-0.045em] ${
          size === "poster"
            ? "max-w-[14ch] text-[clamp(2.75rem,6.4vw,7rem)]"
            : "max-w-[15ch] text-[clamp(2.6rem,4.3vw,4.6rem)]"
        }`}
      >
        {WORDS.headline} <span className="text-accent">{WORDS.headlineTail}</span>
      </h1>
      <p
        data-first-why
        className="rise mt-6 max-w-[52ch] text-base leading-relaxed text-text-muted sm:text-[1.075rem]"
        style={{ animationDelay: "160ms" }}
      >
        {WORDS.line}
      </p>
    </div>
  );
}

/** The small second call: make a passport of your own. */
export function MakeOne({ className = "" }: { className?: string }) {
  return (
    <div className={`flex flex-wrap items-center gap-x-4 gap-y-2 ${className}`}>
      <Link
        href="/studio"
        prefetch={false}
        className="group inline-flex h-11 items-center gap-3 rounded-[8px] border border-line-strong px-5 text-[11px] font-semibold uppercase tracking-[0.18em] text-text transition-colors duration-200 hover:border-accent hover:text-accent"
      >
        {WORDS.make}
        <span aria-hidden className="block h-px w-5 bg-current transition-all duration-300 group-hover:w-8" />
      </Link>
      <span className="text-xs text-text-faint">{WORDS.makeNote}</span>
    </div>
  );
}
