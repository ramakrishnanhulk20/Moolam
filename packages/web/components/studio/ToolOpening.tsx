import type { ReactNode } from "react";

/** The opening's one line, wherever a page seats it. */
export const OPENING_LINE = "rise max-w-[56ch] text-sm leading-relaxed text-text-muted sm:text-base";

/**
 * The compact opening a tool page gets: the kicker, the page's name at a size
 * that leaves the first screen to the tool, and one line.
 *
 * On a laptop the line stands beside the title rather than under it, so the
 * whole opening is one band about a fifth of the screen tall. `aside` takes
 * that right-hand place instead where a page has something better to put there,
 * and `under` is drawn under the title, inside the title's own block.
 *
 * Plain markup with the CSS rise, so it paints from the server's HTML.
 */
export function ToolOpening({
  kicker,
  title,
  line,
  locale,
  aside,
  under,
}: {
  kicker: string;
  title: string;
  line?: string;
  locale: string;
  aside?: ReactNode;
  under?: ReactNode;
}) {
  // Tamil letters carry marks above and below the line, so the tight leading
  // the display face wants in Latin makes two lines touch.
  const leading = locale === "ta" ? "leading-[1.2]" : "leading-[0.92]";

  const said =
    line === undefined ? null : (
      <p className={`${OPENING_LINE} lg:justify-self-end`} style={{ animationDelay: "120ms" }}>
        {line}
      </p>
    );

  return (
    <header
      data-opening="compact"
      className="relative grid gap-x-12 gap-y-4 border-b border-line pb-6 sm:pb-7 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:items-end"
    >
      <div className="min-w-0">
        <p className="rise flex items-center gap-3 font-mono text-[11px] uppercase tracking-[0.28em] text-accent">
          <span className="motif h-[9px] w-[9px]" />
          {kicker}
        </p>
        <h1
          className={`rise mt-3 max-w-[22ch] font-display text-[clamp(1.75rem,3.4vw,3rem)] font-semibold uppercase tracking-[-0.03em] ${leading}`}
          style={{ animationDelay: "60ms" }}
        >
          {title}
        </h1>
        {under}
      </div>

      {aside ?? said}
    </header>
  );
}
