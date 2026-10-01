import { Link } from "@/lib/i18n/routing";
import type { MarkCopy } from "./copy";
import { TONE_EDGE, TONE_INK } from "./tones";
import { MarkStamp } from "./Stamp";

/**
 * The band under the poster: the trust mark pressed large with the one
 * sentence that says what it means, and beside it what Chainlink found about
 * look-alikes. It is the first thing under the picture because it is the one
 * verdict on the page the registrant could not have written about themselves.
 *
 * A mark that could not be read says so in words and draws no stamp (L32).
 */
export function MarkBand({ copy }: { copy: MarkCopy }) {
  const side = copy.lookalike !== null || copy.later !== null;
  return (
    <section
      data-mark-band={copy.state}
      aria-label={copy.label}
      className="relative overflow-hidden border-b border-line bg-bg"
    >
      <div
        className={`mx-auto grid w-full max-w-[1400px] gap-9 px-5 py-10 sm:px-8 sm:py-14 ${
          side ? "lg:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)] lg:gap-16" : ""
        }`}
      >
        <div className="rise min-w-0">
          <p className="flex items-center gap-3 font-mono text-[11px] uppercase tracking-[0.28em] text-text-faint">
            <span aria-hidden className="motif h-[8px] w-[8px] opacity-70" />
            {copy.label}
          </p>
          {copy.word === null ? null : (
            <div className="mt-6">
              <MarkStamp state={copy.state} word={copy.word} tone={copy.tone} size="lg" delay={0.25} />
            </div>
          )}
          <p
            data-mark-line
            className={`mt-6 max-w-[56ch] text-base leading-relaxed ${copy.word === null ? "text-text-muted" : "text-text"}`}
          >
            {copy.line}
          </p>
          {copy.link === null ? null : (
            <BandLink href={copy.link.href} tone={copy.tone === "amber" ? "amber" : "quiet"} className="mt-6">
              {copy.link.label}
            </BandLink>
          )}
        </div>

        {side ? (
          <div className="rise min-w-0 space-y-6" style={{ animationDelay: "120ms" }}>
            {copy.lookalike === null ? null : copy.lookalike.kind === "none" ? (
              <p data-lookalike="none" className="max-w-[56ch] border-s-2 border-line-strong ps-5 text-base leading-relaxed text-text-muted">
                {copy.lookalike.line}
              </p>
            ) : (
              <div
                data-lookalike={copy.lookalike.kind}
                className={`max-w-[60ch] border-s-[3px] ps-5 sm:ps-6 ${
                  copy.lookalike.tone === "amber" ? TONE_EDGE.amber : "border-dashed border-line-strong"
                }`}
              >
                <p
                  className={`font-display text-[clamp(1.25rem,2.6vw,1.9rem)] font-semibold leading-[1.05] tracking-[-0.03em] ${
                    copy.lookalike.tone === "amber" ? TONE_INK.amber : "text-text-muted"
                  }`}
                >
                  {copy.lookalike.heading}
                </p>
                <p className="mt-3 text-base leading-relaxed text-text">{copy.lookalike.line}</p>
                {copy.lookalike.order === null ? null : (
                  <p className="mt-3 text-base leading-relaxed text-text-muted">{copy.lookalike.order}</p>
                )}
                <BandLink
                  href={copy.lookalike.link.href}
                  tone={copy.lookalike.tone === "amber" ? "amber" : "quiet"}
                  className="mt-5"
                >
                  {copy.lookalike.link.label}
                </BandLink>
              </div>
            )}

            {copy.later === null ? null : (
              <div data-lookalike-later className="max-w-[56ch] border-s-2 border-line ps-5">
                <Link
                  href={copy.later.href}
                  className="group inline text-base leading-relaxed text-text-muted transition-colors duration-200 hover:text-text"
                >
                  <span className="bg-[linear-gradient(currentColor,currentColor)] bg-[length:0%_1px] bg-left-bottom bg-no-repeat transition-[background-size] duration-500 ease-[cubic-bezier(0.16,1,0.3,1)] group-hover:bg-[length:100%_1px]">
                    {copy.later.line}
                  </span>
                </Link>
                {copy.later.count === null ? null : (
                  <p className="mt-2 font-mono text-[11px] uppercase tracking-[0.18em] text-text-faint">{copy.later.count}</p>
                )}
              </div>
            )}
          </div>
        ) : null}
      </div>
    </section>
  );
}

/** A way to the other passport, at the house's 8 px radius, with the border taking the mark's ink on hover. */
function BandLink({
  href,
  tone,
  className = "",
  children,
}: {
  href: string;
  tone: "amber" | "quiet";
  className?: string;
  children: string;
}) {
  return (
    <Link
      href={href}
      className={`tap group inline-flex items-center gap-2.5 rounded-[8px] border px-4 py-2.5 font-mono text-[10px] uppercase tracking-[0.18em] transition-colors duration-200 ${className} ${
        tone === "amber"
          ? `${TONE_EDGE.amber} ${TONE_INK.amber} hover:bg-lookalike/10`
          : "border-line text-text-muted hover:border-accent hover:text-accent"
      }`}
    >
      {children}
      <svg aria-hidden viewBox="0 0 10 10" className="h-[9px] w-[9px] transition-transform duration-300 group-hover:translate-x-0.5 rtl:-scale-x-100">
        <path d="M1 5h8M5.5 1.5 9 5 5.5 8.5" fill="none" stroke="currentColor" strokeWidth="1.2" />
      </svg>
    </Link>
  );
}
