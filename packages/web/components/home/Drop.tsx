"use client";

import { useLocale, useTranslations } from "next-intl";
import { useEffect, useRef, useState, type DragEvent } from "react";
import type { Stage } from "@/components/verify/AnswerCard";
import { Picture } from "@/components/passport/Picture";
import { pictureSources } from "@/lib/images";
import type { TrySample } from "@/lib/data/samples";

const ACCEPT = "image/jpeg,image/png,image/webp";

type Check = typeof import("./check");

/** A passport id as the verify page shortens it, without bringing the chain client along. */
function shortId(id: string): string {
  return id.length <= 12 ? id : `${id.slice(0, 8)}…${id.slice(-4)}`;
}

/**
 * The action on the first screen: drop a copy, or press a real passport, and
 * the answer turns over inside the same frame.
 *
 * The check is the verify page's own, piece for piece: the same refusal of a
 * file the service would refuse, the same upload straight from this browser to
 * the verify service, the same read of the passport from Monad and the same
 * card. Only the frame around it is new, so a first visitor and a reader of the
 * verify page are told exactly the same facts about the same picture.
 *
 * Nothing in here is hidden until the script runs. The frame, the words and the
 * three pictures are in the server's markup and enter on a CSS rise, so a slow
 * phone reads them before it can press them.
 *
 * The check itself is not. The card, the verify client and the chain reads
 * behind them are fetched on the first press or drop (check.ts), because most
 * visitors never start one and a phone paid for them on every load: the page
 * scored 79 on Lighthouse with them and 91 before the drop was here. Until
 * that code has arrived the pressed control says it is working.
 */
export function Drop({ samples, look }: { samples: TrySample[]; look: "poster" | "board" }) {
  const t = useTranslations("home.first");
  const input = useRef<HTMLInputElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  const [over, setOver] = useState(false);
  const [stage, setStage] = useState<Stage>({ kind: "idle" });
  const [pressed, setPressed] = useState<string | null>(null);
  const [Card, setCard] = useState<Check["AnswerCard"] | null>(null);
  const [unstarted, setUnstarted] = useState(false);
  const code = useRef<Promise<Check> | null>(null);
  const busy = stage.kind === "checking";
  const landed = stage.kind === "answer" || stage.kind === "problem";

  // On a phone the card can grow past the bottom of the window. It is brought
  // up to meet the reader rather than left for them to find.
  useEffect(() => {
    const node = frame.current;
    if (!landed || node === null) {
      return;
    }
    const box = node.getBoundingClientRect();
    if (box.top >= 0 && box.top <= window.innerHeight * 0.5) {
      return;
    }
    node.scrollIntoView({ block: "start", behavior: "smooth" });
  }, [landed]);

  // Asked for once, on the first press, and shared by every check after it. A
  // fetch that failed is forgotten so the next press asks again.
  function load(): Promise<Check> {
    if (code.current === null) {
      code.current = import("./check").then(
        (loaded) => {
          setCard(() => loaded.AnswerCard);
          return loaded;
        },
        (error: unknown) => {
          code.current = null;
          throw error;
        },
      );
    }
    return code.current;
  }

  // Started as the pointer goes down, so the code is on its way before the
  // click, the file picker or the drop has finished.
  function warm() {
    load().catch(() => undefined);
  }

  // Without the code there is no card to say anything on, so the frame goes
  // back to how it was, says the check did not run, and the next press tries
  // again.
  async function loaded(): Promise<Check | null> {
    try {
      return await load();
    } catch {
      reset();
      setUnstarted(true);
      return null;
    }
  }

  function take(chosen: File | undefined) {
    if (chosen === undefined) {
      return;
    }
    void check(chosen);
  }

  async function pick(sample: TrySample) {
    setPressed(sample.id);
    setUnstarted(false);
    setStage({ kind: "checking", name: sample.title ?? sample.id });
    const run = await loaded();
    if (run === null) {
      return;
    }
    const file = await run.sampleFile(sample);
    if (file === null) {
      setStage({ kind: "problem", problem: { key: "sampleFailed" } });
      return;
    }
    setStage({ kind: "checking", name: file.name });
    setStage(await run.answerFor(file));
  }

  async function check(chosen: File) {
    setStage({ kind: "checking", name: chosen.name });
    setUnstarted(false);
    const run = await loaded();
    if (run === null) {
      return;
    }
    setStage(await run.answerFor(chosen));
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setOver(false);
    setPressed(null);
    take(event.dataTransfer.files?.[0]);
  }

  function reset() {
    setStage({ kind: "idle" });
    setPressed(null);
  }

  return (
    <div data-first-drop className="relative">
      <input
        ref={input}
        type="file"
        accept={ACCEPT}
        className="hidden"
        onChange={(event) => {
          setPressed(null);
          take(event.target.files?.[0]);
          event.target.value = "";
        }}
      />

      <div
        ref={frame}
        onDragEnter={warm}
        onDragOver={(event) => {
          event.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
        className="scroll-mt-24"
      >
        {stage.kind === "idle" || Card === null ? (
          <Still
            over={over}
            look={look}
            waiting={busy && pressed === null}
            unstarted={unstarted}
            onWarm={warm}
            onChoose={() => input.current?.click()}
          />
        ) : (
          // On a wide screen the card turns over inside the frame the press was in
          // and scrolls within it, so the headline beside it never moves. A phone
          // has nothing beside it and lets the card run down the page.
          <div
            data-first-answer
            className="rise lg:max-h-[min(58svh,34rem)] lg:overflow-y-auto lg:overscroll-contain"
            data-lenis-prevent
          >
            <Card stage={stage} />
          </div>
        )}
      </div>

      {stage.kind === "idle" || Card === null ? null : (
        <button
          type="button"
          onClick={reset}
          disabled={busy}
          className="mt-3 inline-flex h-11 items-center rounded-[8px] border border-line-strong px-5 text-[11px] uppercase tracking-[0.18em] text-text-muted transition-colors duration-200 hover:border-accent hover:text-accent disabled:opacity-50"
        >
          {t("again")}
        </button>
      )}

      <Strip
        samples={samples}
        look={look}
        busy={busy}
        pressed={pressed}
        onWarm={warm}
        onPick={(sample) => void pick(sample)}
      />
    </div>
  );
}

/**
 * The drop target, framed as a film still: four corner marks, a slate line, the one sentence.
 *
 * waiting is a chosen or dropped file whose check code is still on its way,
 * and the button says so in the verify page's own word for it.
 */
function Still({
  over,
  look,
  waiting,
  unstarted,
  onWarm,
  onChoose,
}: {
  over: boolean;
  look: "poster" | "board";
  waiting: boolean;
  /** The check's own code would not load, so the last press did nothing. */
  unstarted: boolean;
  onWarm: () => void;
  onChoose: () => void;
}) {
  const t = useTranslations("home.first");
  const verify = useTranslations("verify");
  // Tamil letters carry marks above and below the line, so the display face's
  // tight Latin leading makes two lines of them touch.
  // Tamil's words are also two or three Latin zeros wide, so it takes a wider
  // measure at a smaller size.
  const tamil = useLocale() === "ta";
  const type = tamil
    ? "max-w-[18ch] text-[clamp(1.3rem,1.9vw,1.75rem)] leading-[1.2]"
    : "max-w-[13ch] text-[clamp(1.55rem,2.5vw,2.3rem)] leading-[1]";

  return (
    <div
      className={`grain group/still relative overflow-hidden border transition-colors duration-300 ${
        over ? "border-accent bg-accent-soft" : "border-line-strong bg-bg/70 hover:border-accent/70"
      } ${look === "poster" ? "backdrop-blur-md" : ""}`}
    >
      <Corners />
      <div
        className={`relative flex gap-5 p-6 sm:p-7 lg:p-6 ${
          look === "board" ? "flex-col sm:flex-row sm:items-end sm:justify-between" : "flex-col"
        }`}
      >
        <div>
          <p className="flex items-center justify-between gap-6 font-mono text-[10px] uppercase tracking-[0.24em] text-text-faint">
            <span className="flex items-center gap-2">
              <span aria-hidden className={`h-1.5 w-1.5 bg-accent ${over ? "" : "animate-pulse"}`} />
              {verify("rail")}
            </span>
            {look === "poster" ? <span>Still 01</span> : null}
          </p>
          {/* A phone cannot drop a file, so below the laptop width the box
              asks for a check instead. Both are in the server's markup and
              CSS picks one, so neither flashes in after the script runs. */}
          <p className={`mt-4 font-display font-semibold tracking-[-0.035em] ${type}`}>
            {over ? (
              t("dropping")
            ) : (
              <>
                <span data-first-title="phone" className="lg:hidden">
                  {t("check")}
                </span>
                <span data-first-title="laptop" className="hidden lg:inline">
                  {t("drop")}
                </span>
              </>
            )}
          </p>
        </div>
        <div className="flex flex-col items-start gap-3">
          <button
            type="button"
            onPointerDown={onWarm}
            onClick={onChoose}
            disabled={waiting}
            aria-busy={waiting}
            data-hero-call="choose"
            className="inline-flex h-11 items-center gap-2 rounded-[8px] bg-accent px-6 text-xs font-semibold uppercase tracking-[0.14em] text-accent-ink transition-transform duration-200 hover:-translate-y-0.5 active:translate-y-0 disabled:cursor-wait disabled:hover:translate-y-0"
          >
            {waiting ? <span aria-hidden className="h-1.5 w-1.5 animate-pulse bg-accent-ink" /> : null}
            {waiting ? verify("busy") : verify("choose")}
          </button>
          {unstarted ? (
            <p role="alert" data-first-unstarted className="max-w-[34ch] text-xs font-semibold leading-relaxed text-failed">
              {verify("problemLabel")}
            </p>
          ) : (
            <p className="max-w-[34ch] text-xs leading-relaxed text-text-muted">{t("hint")}</p>
          )}
        </div>
      </div>
    </div>
  );
}

/** The registration marks of a film still, in the accent. Decoration, so hidden from a screen reader. */
function Corners() {
  const mark = "pointer-events-none absolute h-3 w-3 border-accent transition-all duration-300 group-hover/still:h-4 group-hover/still:w-4";
  return (
    <>
      <span aria-hidden className={`${mark} left-2 top-2 border-l border-t`} />
      <span aria-hidden className={`${mark} right-2 top-2 border-r border-t`} />
      <span aria-hidden className={`${mark} bottom-2 left-2 border-b border-l`} />
      <span aria-hidden className={`${mark} bottom-2 right-2 border-b border-r`} />
    </>
  );
}

/**
 * The three real passports the verify page offers, as a strip of stills.
 *
 * Each box is sized before its picture arrives, so nothing moves when it does.
 */
function Strip({
  samples,
  look,
  busy,
  pressed,
  onWarm,
  onPick,
}: {
  samples: TrySample[];
  look: "poster" | "board";
  busy: boolean;
  pressed: string | null;
  onWarm: () => void;
  onPick: (sample: TrySample) => void;
}) {
  const t = useTranslations("home.first");
  const verify = useTranslations("verify");

  if (samples.length === 0) {
    return null;
  }

  return (
    <div data-first-samples className="mt-4">
      <p className="flex items-center gap-3 font-mono text-[10px] uppercase tracking-[0.24em] text-text-faint">
        <span className="motif h-[8px] w-[8px]" />
        {t("samples")}
      </p>
      <ul
        className={`mt-3 grid grid-cols-3 gap-2 ${
          look === "poster" ? "border-y border-line-strong bg-bg/55 px-2 py-2 backdrop-blur-md" : "max-w-[27rem] sm:gap-3 lg:max-w-[24rem]"
        }`}
      >
        {samples.map((sample, index) => {
          const name = sample.title ?? shortId(sample.id);
          const checking = busy && pressed === sample.id;
          return (
            <li key={sample.id} className="rise min-w-0" style={{ animationDelay: `${420 + index * 70}ms` }}>
              <button
                type="button"
                onPointerDown={onWarm}
                onClick={() => onPick(sample)}
                disabled={busy}
                aria-busy={checking}
                title={name}
                className="group block min-h-11 w-full text-start disabled:cursor-wait"
              >
                <span className="grain relative block aspect-[4/3] w-full overflow-hidden border border-line transition-colors duration-200 group-hover:border-accent group-focus-visible:border-accent">
                  <Picture
                    sources={pictureSources(sample.url)}
                    alt={name}
                    sizes="(min-width: 1024px) 10rem, 30vw"
                    className="object-cover opacity-85 transition duration-500 group-hover:scale-[1.06] group-hover:opacity-100"
                  />
                  <span className="scrim pointer-events-none absolute inset-0 opacity-60" />
                  {checking ? (
                    <span className="absolute inset-x-0 bottom-0 flex items-center gap-2 bg-bg/80 px-2 py-1 font-mono text-[9px] uppercase tracking-[0.2em] text-accent">
                      <span aria-hidden className="h-1.5 w-1.5 animate-pulse bg-accent" />
                      {verify("busy")}
                    </span>
                  ) : null}
                </span>
                {/* A name is a title somebody chose, so it is shown whole: it
                    wraps at its spaces to as many lines as it needs. */}
                <span className="mt-1.5 block hyphens-none text-[11px] leading-snug text-text-muted [overflow-wrap:normal] [word-break:normal] transition-colors duration-200 group-hover:text-accent group-focus-visible:text-accent sm:text-xs">
                  {name}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
