import { Link } from "@/lib/i18n/routing";
import { Board } from "./Board";
import { Poster } from "./Poster";
import type { Drawing } from "./finding";
import type { FirstScreenData } from "./read";
import { WORDS } from "./words";

const NAMES: Record<Drawing, string> = { a: "The poster", b: "The evidence board" };

/**
 * The bench around the two drawings: a thin strip to switch between them, the
 * drawing itself, and the place the film would start under it.
 *
 * With full on, the strip is gone and the drawing starts at the top of the
 * window exactly as the home page would, which is the view to judge it in.
 */
export function Bench({ data, drawing, full }: { data: FirstScreenData; drawing: Drawing; full: boolean }) {
  const Drawn = drawing === "a" ? Poster : Board;

  return (
    <div data-first-screen-bench={drawing}>
      {full ? null : (
        <nav
          aria-label="First screen drawings"
          className="flex flex-wrap items-center gap-x-5 gap-y-2 border-b border-line bg-bg-raised px-5 py-2 font-mono text-[10px] uppercase tracking-[0.2em] text-text-faint sm:px-8 lg:px-14"
        >
          <span className="flex items-center gap-2 text-accent">
            <span className="motif h-[8px] w-[8px]" />
            First screen bench
          </span>
          <span className="flex items-center gap-1">
            {(["a", "b"] as const).map((key) => (
              <Link
                key={key}
                href={`/lab/first-screen?d=${key}`}
                aria-current={key === drawing ? "page" : undefined}
                className={`inline-flex h-11 items-center rounded-[8px] px-3 transition-colors duration-200 ${
                  key === drawing ? "bg-accent text-accent-ink" : "hover:text-accent"
                }`}
              >
                {key.toUpperCase()}. {NAMES[key]}
              </Link>
            ))}
          </span>
          <Link
            href={`/lab/first-screen?d=${drawing}&full=1`}
            className="inline-flex h-11 items-center transition-colors duration-200 hover:text-accent"
          >
            Open at the real viewport
          </Link>
        </nav>
      )}

      <Drawn finding={data.finding} copy={data.copy} samples={data.samples} />

      <FilmFollows />
    </div>
  );
}

/**
 * Where the film would begin.
 *
 * The film cannot be mounted under another screen without changing it: it
 * pins itself to the whole window, hides the footer until its last beat and
 * restyles the header from the body down. So the bench marks the seam and says
 * so rather than showing a film that behaves differently from the one that ships.
 */
function FilmFollows() {
  return (
    <section
      data-film-follows
      data-motif="seal"
      className="story grain relative flex min-h-[60svh] flex-col justify-center overflow-hidden border-t border-line px-5 py-16 sm:px-8 lg:px-14"
    >
      <div className="mx-auto w-full max-w-[100rem]">
        <p className="flex items-center gap-4 font-mono text-[11px] uppercase tracking-[0.28em] text-accent">
          <span className="motif h-[10px] w-[10px]" />
          <span aria-hidden className="h-px w-16 bg-accent/60" />
          {WORDS.filmFollows}
        </p>
        <p className="mt-6 max-w-[22ch] font-display text-[clamp(2rem,5vw,4.5rem)] font-semibold uppercase leading-[0.92] tracking-[-0.04em] text-text-muted">
          Nine beats of one picture getting its passport.
        </p>
        <p className="mt-6 max-w-[60ch] text-sm leading-relaxed text-text-faint">
          Bench note: the home page film pins itself to the whole window, hides the footer and restyles the header,
          so it is not mounted here. On the home page it starts at this line, under the screen above.
        </p>
      </div>
    </section>
  );
}
