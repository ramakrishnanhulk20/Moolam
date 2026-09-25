import type { CSSProperties } from "react";
import { CHAPTER_WORDS } from "@/components/story/chapter";

/** Before the film is in view each line waits on the first frame of its rise, so nothing moves when it starts. */
const WAITING = { opacity: 0, transform: "translateY(28px)" } as const;

/**
 * The chapter cut's first frame: a chapter title, not a poster.
 *
 * The page above it has already said what Moolam is and offered both actions,
 * so the film opens the way a chapter in a book does. The heading is the same
 * size as every beat title after it, and the rule under it draws across once
 * the words have landed, which is the film's cue that the camera is about to
 * move. The page's one h1 is the first screen's headline, so this is an h2.
 */
export function ChapterOpening({ arrived }: { arrived: boolean }) {
  const enter = (delay: number): { className: string; style?: CSSProperties } =>
    arrived
      ? { className: "story-enter", style: delay === 0 ? undefined : { animationDelay: `${delay}ms` } }
      : { className: "", style: WAITING };
  const kick = enter(0);
  const name = enter(90);

  return (
    <div data-film-chapter={arrived ? "entered" : "waiting"}>
      <p
        data-story-line="kicker"
        className={`${kick.className} flex items-center gap-3 font-mono text-[11px] uppercase tracking-[0.24em] text-accent`}
        style={kick.style}
      >
        <span className="motif h-[9px] w-[9px]" />
        {CHAPTER_WORDS.kicker}
      </p>
      <h2
        data-story-line="title"
        className={`${name.className} mt-5 max-w-[12ch] font-display text-[clamp(2rem,5.4vw,4.4rem)] font-semibold leading-[0.98] tracking-[-0.04em]`}
        style={name.style}
      >
        {CHAPTER_WORDS.title}
      </h2>
      <span
        aria-hidden
        className="mt-7 block h-px w-[min(18rem,60vw)] origin-left bg-accent/70 rtl:origin-right"
        style={{
          transform: arrived ? "scaleX(1)" : "scaleX(0)",
          transition: "transform 1.1s cubic-bezier(0.16, 1, 0.3, 1) 420ms",
        }}
      />
    </div>
  );
}
