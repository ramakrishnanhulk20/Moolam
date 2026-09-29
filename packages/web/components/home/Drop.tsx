"use client";

import { useLocale, useTranslations } from "next-intl";
import { useEffect, useEffectEvent, useRef, useState, type DragEvent } from "react";
import type { Stage } from "@/components/verify/AnswerCard";
import { Picture } from "@/components/passport/Picture";
import { pictureSources } from "@/lib/images";
import type { TrySample } from "@/lib/data/samples";

const ACCEPT = "image/jpeg,image/png,image/webp";

type Check = typeof import("./check");

/** Room left between the header's foot and the card's top when the window is moved to the card. */
const CARD_GAP = 12;

/**
 * How far to move the window so the card's top sits just under the header, or
 * null when the top is already on screen.
 *
 * A card whose top can be seen is left where it is, however tall it grows: the
 * reader is already looking at it, and on a laptop moving the page would take
 * the headline off the screen for nothing. Only a top hidden above the header or
 * below the window's foot is brought to meet the reader.
 */
export function cardScroll(top: number, header: number, foot: number): number | null {
  if (top >= header && top <= foot) {
    return null;
  }
  return top - header - CARD_GAP;
}

/** The answer a new check is running over, and the height the frame had while that answer was up. */
export interface Held {
  height: number;
  under: Stage;
}

/**
 * What the frame keeps of the last answer while the next check runs, if anything.
 *
 * On a phone an answer is about four times the height of the checking face, so
 * letting the card shrink back pulled everything under it, the pressed sample
 * included, far up past the top of the window. The frame keeps the answer's
 * height and shows it dimmed under the checking face until the new answer lands.
 */
export function heldFrame(stage: Stage, held: Held | null): Held | null {
  return stage.kind === "checking" ? held : null;
}

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
  // True while a file is dragged anywhere over the page. The box's words and
  // button then stop taking the pointer, so the drag only enters and leaves
  // the box itself and its title does not flicker as the pointer crosses them.
  const [dragging, setDragging] = useState(false);
  const [held, setHeld] = useState<Held | null>(null);
  const [stage, setStage] = useState<Stage>({ kind: "idle" });
  const [pressed, setPressed] = useState<string | null>(null);
  const [Card, setCard] = useState<Check["AnswerCard"] | null>(null);
  const [unstarted, setUnstarted] = useState(false);
  const code = useRef<Promise<Check> | null>(null);
  // Bumped by every press, choice, drop and reset. A check only writes to the
  // frame while its number is still the newest, so the frame always ends on
  // the answer to the last thing the reader did, never on a slower earlier one.
  const run = useRef(0);
  const busy = stage.kind === "checking";
  const landed = stage.kind === "answer" || stage.kind === "problem";
  const hold = heldFrame(stage, held);

  // On a phone a new answer can land with its top above the window, or a card
  // can start below it. Its top is brought to meet the reader only when it
  // cannot be seen.
  useEffect(() => {
    const node = frame.current;
    if (!landed || node === null) {
      return;
    }
    const header = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--header-h")) || 0;
    const by = cardScroll(node.getBoundingClientRect().top, header, window.innerHeight);
    if (by === null) {
      return;
    }
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    window.scrollTo({ top: window.scrollY + by, behavior: still ? "instant" : "smooth" });
  }, [landed]);

  const strayDrop = useEffectEvent((file: File | undefined) => take(file));

  // A file let go anywhere else on the page would otherwise replace the site
  // with the picture. On the first screen's left column it is taken as though
  // it had landed in the box; anywhere else it is ignored. A drop another zone
  // already took, such as the film's own panel, is left to that zone.
  useEffect(() => {
    const box = frame.current;
    if (box === null) {
      return;
    }
    const column = box.closest("[data-drop-column]") ?? box;
    const carriesFile = (event: globalThis.DragEvent) => event.dataTransfer?.types.includes("Files") === true;
    const inside = (area: Element, target: EventTarget | null) => target instanceof Node && area.contains(target);

    const enter = (event: globalThis.DragEvent) => {
      if (carriesFile(event)) {
        setDragging(true);
      }
    };
    const hover = (event: globalThis.DragEvent) => {
      if (!carriesFile(event)) {
        return;
      }
      if (!inside(box, event.target)) {
        setOver(false);
      }
      if (event.defaultPrevented) {
        return;
      }
      event.preventDefault();
      if (event.dataTransfer !== null) {
        event.dataTransfer.dropEffect = inside(column, event.target) ? "copy" : "none";
      }
    };
    const drop = (event: globalThis.DragEvent) => {
      setOver(false);
      setDragging(false);
      if (event.defaultPrevented || !carriesFile(event)) {
        return;
      }
      event.preventDefault();
      if (inside(column, event.target)) {
        strayDrop(event.dataTransfer?.files[0]);
      }
    };
    // No mouse event reaches the page during a drag, so the first one after it
    // means the drag is over, however it ended.
    const done = () => {
      setOver(false);
      setDragging(false);
    };

    window.addEventListener("dragenter", enter);
    window.addEventListener("dragover", hover);
    window.addEventListener("drop", drop);
    window.addEventListener("dragend", done);
    window.addEventListener("pointermove", done);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragover", hover);
      window.removeEventListener("drop", drop);
      window.removeEventListener("dragend", done);
      window.removeEventListener("pointermove", done);
    };
  }, []);

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

  /** Starts a new run, which every earlier one gives way to. pressed names the sample it is for, if any. */
  function begin(sample: string | null): number {
    run.current += 1;
    setPressed(sample);
    setUnstarted(false);
    const node = frame.current;
    if (landed && node !== null) {
      setHeld({ height: node.getBoundingClientRect().height, under: stage });
    }
    return run.current;
  }

  function owns(mine: number): boolean {
    return run.current === mine;
  }

  /** The run's last word, written only if nothing has started since. */
  function end(mine: number, last: Stage) {
    if (!owns(mine)) {
      return;
    }
    setStage(last);
    setPressed(null);
    setHeld(null);
  }

  // Without the code there is no card to say anything on, so the frame goes
  // back to how it was, says the check did not run, and the next press tries
  // again.
  async function loaded(mine: number): Promise<Check | null> {
    try {
      const check = await load();
      return owns(mine) ? check : null;
    } catch {
      if (owns(mine)) {
        end(mine, { kind: "idle" });
        setUnstarted(true);
      }
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
    const mine = begin(sample.id);
    setStage({ kind: "checking", name: sample.title ?? sample.id });
    const steps = await loaded(mine);
    if (steps === null) {
      return;
    }
    const file = await steps.sampleFile(sample);
    if (!owns(mine)) {
      return;
    }
    if (file === null) {
      end(mine, { kind: "problem", problem: { key: "sampleFailed" } });
      return;
    }
    setStage({ kind: "checking", name: file.name });
    end(mine, await steps.answerFor(file));
  }

  async function check(chosen: File) {
    const mine = begin(null);
    setStage({ kind: "checking", name: chosen.name });
    const steps = await loaded(mine);
    if (steps === null) {
      return;
    }
    end(mine, await steps.answerFor(chosen));
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setOver(false);
    setDragging(false);
    take(event.dataTransfer.files?.[0]);
  }

  // Only the box's own edge counts. A leave that starts on the words or the
  // button inside is the pointer passing over them, not leaving the box.
  function onDragLeave(event: DragEvent<HTMLDivElement>) {
    if (event.target === event.currentTarget) {
      setOver(false);
    }
  }

  function reset() {
    end(begin(null), { kind: "idle" });
  }

  return (
    <div data-first-drop className="relative">
      <input
        ref={input}
        type="file"
        accept={ACCEPT}
        className="hidden"
        onChange={(event) => {
          take(event.target.files?.[0]);
          event.target.value = "";
        }}
      />

      <div
        ref={frame}
        data-first-frame
        onDragEnter={(event) => {
          warm();
          if (event.dataTransfer.types.includes("Files")) {
            setOver(true);
          }
        }}
        onDragOver={(event) => {
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
          setOver(true);
        }}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        style={hold === null ? undefined : { minHeight: hold.height }}
        className={`relative ${dragging ? "[&_*]:pointer-events-none" : ""}`}
      >
        {stage.kind === "idle" || Card === null ? (
          <Still
            over={over}
            look={look}
            waiting={busy}
            unstarted={unstarted}
            offered={samples.length > 0}
            onWarm={warm}
            onChoose={() => input.current?.click()}
          />
        ) : (
          <>
            {hold === null ? null : (
              // The answer being replaced, dimmed and out of reach, so the
              // frame keeps its size and the pressed sample stays where the
              // reader's thumb is.
              <div
                aria-hidden
                inert
                data-first-held
                className="pointer-events-none absolute inset-x-0 top-0 overflow-clip opacity-25 saturate-50"
                style={{ height: hold.height }}
              >
                <Card stage={hold.under} />
              </div>
            )}
            {/* On a wide screen the card turns over inside the frame the press
                was in and scrolls within it, so the headline beside it never
                moves. A phone has nothing beside it and lets the card run down
                the page. Over a held answer the checking face stays in the
                window, beside the sample that was pressed. */}
            <div
              data-first-answer
              className={`rise lg:max-h-[min(58svh,34rem)] lg:overflow-y-auto lg:overscroll-contain ${
                hold === null ? "" : "sticky top-[calc(var(--header-h)+0.75rem)] z-10"
              }`}
              data-lenis-prevent
            >
              <Card stage={stage} />
            </div>
          </>
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
 * waiting is any check in flight whose card is not up yet, a pressed sample's
 * as well as a chosen or dropped file's, and the button says so in the verify
 * page's own word for it.
 */
function Still({
  over,
  look,
  waiting,
  unstarted,
  offered,
  onWarm,
  onChoose,
}: {
  over: boolean;
  look: "poster" | "board";
  waiting: boolean;
  /** The check's own code would not load, so the last press did nothing. */
  unstarted: boolean;
  /** Real passports sit under the box to press, so the hint may point at them. */
  offered: boolean;
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
            // With no passports to offer, the verify page's own hint, which
            // points at nothing below it.
            <p data-first-hint className="max-w-[34ch] text-xs leading-relaxed text-text-muted">
              {offered ? t("hint") : verify("hint")}
            </p>
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
