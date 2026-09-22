"use client";

import { motion } from "framer-motion";
import { BENCH_STATES, STATE_WORDS, type BenchState, type Path } from "./fixtures";

const PATHS: { path: Path; label: string }[] = [
  { path: "upload", label: "A picture I made" },
  { path: "generate", label: "The agent draws it" },
];

/**
 * The dial: the path on the left, the ten states along it, and the button that
 * plays a whole run at the speeds a real one takes.
 *
 * One dial drives both drawings, so what is on screen in each of them is the
 * same moment and the comparison is about shape rather than timing. It is
 * pinned under the bar, because a picker Ram has to scroll back up to is a
 * picker he stops using on the third state.
 */
export function StateDial({
  path,
  state,
  running,
  onPath,
  onState,
  onPlay,
}: {
  path: Path;
  state: BenchState;
  running: boolean;
  onPath: (path: Path) => void;
  onState: (state: BenchState) => void;
  onPlay: () => void;
}) {
  return (
    <div data-bench-dial className="sticky top-[var(--bench-header,var(--header-h))] z-40 border-y border-line bg-bg/90 py-2.5 backdrop-blur-md">
      <div className="mx-auto w-full max-w-[100rem] px-5 sm:px-8 lg:px-14">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-1 rounded-[8px] border border-line p-1">
            {PATHS.map((one) => (
              <button
                key={one.path}
                type="button"
                data-path-button={one.path}
                aria-pressed={path === one.path}
                onClick={() => onPath(one.path)}
                className={`relative rounded-[6px] px-3 py-2 font-mono text-[10px] uppercase tracking-[0.16em] transition-colors duration-200 ${
                  path === one.path ? "text-bg" : "text-text-faint hover:text-accent"
                }`}
              >
                {path === one.path ? (
                  <motion.span
                    layoutId="studio-bench-path"
                    className="absolute inset-0 rounded-[6px] bg-accent"
                    transition={{ type: "spring", stiffness: 420, damping: 34 }}
                  />
                ) : null}
                <span className="relative whitespace-nowrap">{one.label}</span>
              </button>
            ))}
          </div>

          <button
            type="button"
            onClick={onPlay}
            className="ms-auto shrink-0 rounded-[8px] border border-line px-4 py-2 font-mono text-[10px] uppercase tracking-[0.16em] text-text-muted transition-colors duration-200 hover:border-accent hover:text-accent"
          >
            {running ? "Playing" : "Play the run"}
          </button>
        </div>

        {/* One line, whatever the window: a picker that wraps to a third of a
            phone screen is a picker that hides the thing it is picking for. */}
        <ul className="mt-2 flex items-center gap-1 overflow-x-auto">
          {BENCH_STATES.map((one) => (
            <li key={one} className="shrink-0">
              <button
                type="button"
                data-state-button={one}
                aria-pressed={state === one}
                onClick={() => onState(one)}
                className={`whitespace-nowrap rounded-[6px] border px-3 py-2 font-mono text-[10px] uppercase tracking-[0.14em] transition-colors duration-200 ${
                  state === one
                    ? "border-accent text-accent"
                    : "border-transparent text-text-faint hover:border-line hover:text-text"
                }`}
              >
                {STATE_WORDS[one]}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
