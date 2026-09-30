"use client";

import { useReducedMotion } from "framer-motion";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { PROMPT_MAX, picturePath, submitWeave } from "./outcome";

const EXAMPLES = [
  {
    label: "Glass lighthouse",
    prompt:
      "A lighthouse made of stained glass glowing at dusk, whales drifting through the clouds around it, dreamy and bright",
  },
  {
    label: "Fox librarian",
    prompt:
      "A tiny fox librarian reading by candlelight in a treehouse stacked with books, cosy watercolor, warm light",
  },
  {
    label: "Floating city",
    prompt: "A city of floating islands at sunrise, waterfalls pouring up into the sky, painted in bold bright gouache",
  },
] as const;

type Phase =
  { kind: "idle" } | { kind: "weaving"; since: number } | { kind: "refused"; words: string } | { kind: "woven" };

export function PromptBox() {
  const router = useRouter();
  const [prompt, setPrompt] = useState("");
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const field = useRef<HTMLTextAreaElement>(null);
  const typing = useRef<{ frame: number; text: string } | null>(null);
  const still = useReducedMotion() ?? false;
  const busy = phase.kind === "weaving" || phase.kind === "woven";

  useEffect(
    () => () => {
      stopTyping();
    },
    [],
  );

  /** Stops an example mid-type and returns its full text, so a fast press still sends the whole prompt. */
  function stopTyping(): string | null {
    const current = typing.current;
    if (current === null) {
      return null;
    }
    cancelAnimationFrame(current.frame);
    typing.current = null;
    return current.text;
  }

  /** An example types itself into the box, so a visitor sees the box is the thing to write in. */
  function fill(text: string) {
    if (busy) {
      return;
    }
    stopTyping();
    setPhase({ kind: "idle" });
    field.current?.focus();
    if (still) {
      setPrompt(text);
      return;
    }
    const start = performance.now();
    const duration = 520;
    const step = (at: number) => {
      const shown = Math.min(text.length, Math.ceil(((at - start) / duration) * text.length));
      setPrompt(text.slice(0, shown));
      typing.current = shown < text.length ? { frame: requestAnimationFrame(step), text } : null;
    };
    typing.current = { frame: requestAnimationFrame(step), text };
  }

  async function weave(event?: FormEvent) {
    event?.preventDefault();
    if (busy) {
      return;
    }
    const typed = stopTyping();
    const text = typed ?? prompt;
    if (typed !== null) {
      setPrompt(typed);
    }
    setPhase({ kind: "weaving", since: Date.now() });
    const outcome = await submitWeave(text);
    if (outcome.kind === "woven") {
      setPhase({ kind: "woven" });
      router.push(picturePath(outcome.pictureId));
      return;
    }
    setPhase({ kind: "refused", words: outcome.words });
  }

  return (
    <form className="relative" onSubmit={weave} aria-busy={busy}>
      <div
        data-busy={busy}
        className="weave-ring rounded-[calc(var(--radius-soft)+3px)] p-[3px] shadow-[0_30px_80px_-30px_rgba(90,59,255,0.55)]"
      >
        <div className="rounded-soft bg-card p-3 sm:p-4">
          <label htmlFor="dream" className="sr-only">
            Describe your dream
          </label>
          <textarea
            id="dream"
            ref={field}
            value={prompt}
            onChange={(event) => {
              stopTyping();
              setPrompt(event.target.value);
              if (phase.kind === "refused") {
                setPhase({ kind: "idle" });
              }
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                void weave();
              }
            }}
            readOnly={busy}
            maxLength={PROMPT_MAX}
            rows={3}
            placeholder="A lighthouse made of glass, whales swimming through the clouds at dusk..."
            aria-describedby="weave-status"
            className="block w-full resize-none bg-transparent px-2 pt-1 text-lg leading-snug text-ink placeholder:text-ink-soft/55 focus:outline-none read-only:text-ink-soft sm:text-[1.35rem]"
          />
          <div className="mt-3 flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-between">
            <span className="px-2 text-sm tabular-nums text-ink-soft">
              {prompt.trim().length} / {PROMPT_MAX}
            </span>
            <button
              type="submit"
              disabled={busy}
              className="bg-daybreak group inline-flex h-14 w-full cursor-pointer items-center justify-center gap-2 rounded-full px-8 font-display text-lg font-bold text-white shadow-[0_12px_30px_-10px_rgba(255,106,31,0.7)] transition-[transform,box-shadow,opacity] duration-200 hover:-translate-y-0.5 hover:shadow-[0_18px_40px_-12px_rgba(90,59,255,0.7)] focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-violet active:translate-y-0 disabled:cursor-progress disabled:opacity-85 disabled:hover:translate-y-0 sm:w-auto"
            >
              {busy ? "Weaving" : "Weave it"}
              {busy ? <Spinner /> : <Arrow />}
            </button>
          </div>
        </div>
      </div>

      <div id="weave-status" role="status" aria-live="polite" className="min-h-0">
        {phase.kind === "weaving" && <WeavingNote since={phase.since} />}
        {phase.kind === "woven" && (
          <p className="mt-4 px-2 text-base font-semibold text-violet">Your picture is ready. Opening it now.</p>
        )}
        {phase.kind === "refused" && (
          <p className="mt-4 rounded-2xl border-2 border-alert/20 bg-alert/5 px-4 py-3 text-base font-medium text-alert">
            {phase.words}
          </p>
        )}
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-2">
        <span className="mr-1 text-sm font-semibold text-ink-soft">Try one</span>
        {EXAMPLES.map((example) => (
          <button
            key={example.label}
            type="button"
            disabled={busy}
            onClick={() => fill(example.prompt)}
            className="min-h-11 cursor-pointer rounded-full border-2 border-ink/10 bg-card px-4 py-2 text-sm font-semibold text-ink transition duration-200 hover:-translate-y-0.5 hover:rotate-[-1.5deg] hover:border-tangerine hover:bg-sun/40 focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-violet disabled:cursor-not-allowed disabled:opacity-50"
          >
            {example.label}
          </button>
        ))}
      </div>
    </form>
  );
}

/** A picture takes several seconds, so the wait is named and counted rather than left to look like a hang. */
function WeavingNote({ since }: { since: number }) {
  const [now, setNow] = useState(since);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const seconds = Math.max(0, Math.floor((now - since) / 1000));
  return (
    <p className="mt-4 px-2 text-base text-ink">
      <span className="font-semibold">Weaving your picture.</span>{" "}
      <span className="text-ink-soft">
        A picture can take up to a minute. <span className="tabular-nums">{seconds} s</span> so far.
      </span>
    </p>
  );
}

function Arrow() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      className="size-5 transition-transform duration-200 group-hover:translate-x-1"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M5 12h14M13 6l6 6-6 6" />
    </svg>
  );
}

function Spinner() {
  return (
    <svg aria-hidden viewBox="0 0 24 24" className="size-5 animate-spin motion-reduce:animate-none" fill="none">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.35" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}
