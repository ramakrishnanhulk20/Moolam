"use client";

import { useTranslations } from "next-intl";
import { useEffect, useRef, useState, type DragEvent } from "react";
import { WarningMark } from "@/components/WarningMark";
import { FailureDetails } from "@/components/studio/FailureDetails";
import { probe, progress, resetProbe, type ProbeState } from "@/components/story/signals";
import { Picture } from "@/components/passport/Picture";
import { DisputeLine } from "@/components/verify/DisputeLine";
import { readAnswer } from "@/components/verify/answer";
import { StaleIndex } from "@/components/verify/StaleIndex";
import { fileFromSample } from "@/components/verify/sample";
import { pictureSources } from "@/lib/images";
import { Link } from "@/lib/i18n/routing";
import { shortHex } from "@/lib/chain/client";
import { checkImage, type RefusalCode } from "@/lib/upload/checkImage";
import type { TrySample } from "@/lib/data/samples";
import { VerifierError, verify, type VerifierCode, type VerifyResponse } from "@/lib/verifier/client";

/**
 * The plate in the scene reads the answer from the shared signal, and it is
 * written here rather than in the component so the whole exchange is one call
 * with one name on it.
 */
function publish(state: ProbeState, confidence = 0) {
  probe.state = state;
  probe.confidence = confidence;
}

type State =
  | { kind: "idle" }
  /** sample is the offered picture being checked, so its plate can say so. */
  | { kind: "pending"; name: string; sample: string | null }
  /** reason is the service's or the browser's own words, shown folded under the sentence. */
  | { kind: "error"; message: string; reason: string | null }
  /** named turns true once the matched passport's title has been asked for, found or not. */
  | { kind: "done"; name: string; answer: VerifyResponse; title: string | null; named: boolean };

/**
 * Whether a check may still write to the panel. Every press, drop and choice
 * takes a new number and only the newest may write, so a slow first sample can
 * never land its answer and its plate colour under a second one.
 */
export function stillCurrent(run: number, mine: number): boolean {
  return run === mine;
}

/**
 * One registered image the panel offers, for a judge with no file to hand. The
 * shape and the rule that picks the three live in lib/data/samples, because the
 * verify page offers the same pictures and the two must never disagree.
 */
export type { TrySample };

/**
 * The beat a judge can touch: drop any copy of any image and the running
 * verifier answers, on the plate and in words.
 *
 * The panel is pinned over the scene and fades in with the offer beat, straight
 * from the beats table. Opacity alone would leave the button in the tab order
 * while the camera is still flying, so the whole subtree is inert until it is
 * actually on screen.
 */
export function TryPanel({
  onPreview,
  samples = [],
  pinned = true,
}: {
  onPreview: (url: string | null) => void;
  /** Real records from the index. Empty is a normal answer: the index may be down. */
  samples?: TrySample[];
  pinned?: boolean;
}) {
  const t = useTranslations("story.tryIt");
  const first = useTranslations("home.first");
  const v = useTranslations("verify");
  const shell = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const preview = useRef<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const said = useRef<HTMLDivElement>(null);
  const run = useRef(0);
  const [state, setState] = useState<State>({ kind: "idle" });
  const [over, setOver] = useState(false);
  const busy = state.kind === "pending";

  useEffect(() => {
    if (!pinned) {
      return;
    }
    let frame = 0;
    let hidden: boolean | null = null;

    const loop = () => {
      const node = shell.current;
      if (node !== null) {
        const shown = Math.min(progress.offer, 1 - progress.close);
        node.style.opacity = String(shown);
        const next = shown <= 0.5;
        if (next !== hidden) {
          hidden = next;
          node.inert = next;
          if (next) {
            node.setAttribute("aria-hidden", "true");
          } else {
            node.removeAttribute("aria-hidden");
          }
        }
      }
      frame = requestAnimationFrame(loop);
    };

    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, [pinned]);

  // On a phone the pinned panel has only the room above the bar, so it scrolls
  // inside itself, and a new answer is brought up to meet the reader there.
  // Only the panel moves: the film's own scroll is never touched.
  useEffect(() => {
    const frame = box.current;
    const answer = said.current;
    if (!pinned || state.kind === "idle" || frame === null || answer === null) {
      return;
    }
    const by = answerScroll(answer.offsetTop, answer.offsetHeight, frame.scrollTop, frame.clientHeight);
    if (by !== null) {
      const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      frame.scrollTo({ top: by, behavior: still ? "instant" : "smooth" });
    }
  }, [pinned, state]);

  useEffect(
    () => () => {
      if (preview.current !== null) {
        URL.revokeObjectURL(preview.current);
      }
      resetProbe();
    },
    [],
  );

  /**
   * A file this browser already knows the service would refuse never leaves the
   * machine: the panel answers on the spot, with the same sentence a refusal
   * from the service would have printed.
   */
  function begin(): number {
    run.current += 1;
    return run.current;
  }

  function take(file: File) {
    const mine = begin();
    const refused = localRefusal(file);
    if (refused !== null) {
      setState({ kind: "error", message: t(refused), reason: null });
      return;
    }
    void check(file, mine);
  }

  async function check(file: File, mine: number, sample: TrySample | null = null) {
    if (preview.current !== null) {
      URL.revokeObjectURL(preview.current);
    }
    preview.current = URL.createObjectURL(file);
    onPreview(preview.current);

    publish("pending");
    setState({ kind: "pending", name: file.name, sample: sample?.id ?? null });

    try {
      const answer = await verify({ file });
      if (!stillCurrent(run.current, mine)) {
        return;
      }
      const matched = answer.result.exact !== null || answer.result.best !== null;
      const known = sample?.title ?? null;
      publish(matched ? "matched" : "refused", answer.result.confidence);
      setState({ kind: "done", name: file.name, answer, title: known, named: known !== null });
      if (known === null) {
        void readTitle(answer);
      }
    } catch (error) {
      if (!stillCurrent(run.current, mine)) {
        return;
      }
      publish("refused");
      setState({ kind: "error", ...refusal(error, t) });
    }
  }

  /**
   * The matched picture's own name, so the result is not a hex string a reader
   * has to take on faith.
   *
   * It is the same read the verify page's card makes, imported only once there
   * is something to name: the landing page is the one screen that must not
   * carry a byte it does not need before the first frame.
   */
  async function readTitle(answer: VerifyResponse) {
    const id = answer.result.exact ?? answer.result.best?.id ?? null;
    if (id === null) {
      return;
    }
    const { matchedPassport } = await import("@/components/verify/lookup");
    const passport = await matchedPassport(id).catch(() => null);
    const title = passport?.title ?? null;
    // The reader may have dropped another file while the registry answered, so
    // the name is only applied to the answer it belongs to.
    setState((current) =>
      current.kind === "done" && current.answer === answer ? { ...current, title: title ?? current.title, named: true } : current,
    );
  }

  /**
   * One of the offered pictures, fetched back out of the gateway as the pinned
   * bytes and put through the same check a dropped file gets.
   *
   * The gateway serves the 512 pixel copy the metadata carries, so this is a
   * resized copy of a registered image rather than the file itself: the answer
   * a judge sees is a real near-match, not a byte-for-byte lookup.
   *
   * The fetch goes through the gateway walk rather than straight at one address.
   * A Pinata gateway that takes the connection and then never answers left this
   * panel reading "fingerprinting" for as long as a reader was willing to watch,
   * with nothing on its way to the verify service.
   */
  async function takeSample(sample: TrySample) {
    const mine = begin();
    setState({ kind: "pending", name: sample.title ?? shortHex(sample.id, 10, 8), sample: sample.id });

    let file: File;
    try {
      file = await fileFromSample(sample);
    } catch (error) {
      if (!stillCurrent(run.current, mine)) {
        return;
      }
      publish("refused");
      setState({ kind: "error", message: t("sampleFailed"), reason: error instanceof Error ? error.message : null });
      return;
    }
    if (!stillCurrent(run.current, mine)) {
      return;
    }

    await check(file, mine, sample);
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setOver(false);
    const file = event.dataTransfer.files?.[0];
    if (file !== undefined) {
      take(file);
    }
  }

  return (
    <div
      ref={shell}
      inert={pinned ? true : undefined}
      aria-hidden={pinned ? "true" : undefined}
      style={pinned ? { opacity: 0 } : undefined}
      className={pinned ? "story-lower pointer-events-none z-30 px-5 opacity-0 sm:px-8 lg:px-14" : "px-0"}
    >
      {/* Pinned, the panel is held to the room the film gives its words and
          scrolls inside it, so an answer never runs under the bar on a phone. */}
      <div className={`mx-auto w-full max-w-[100rem] ${pinned ? "flex max-h-full flex-col" : ""}`}>
        <div
          ref={box}
          data-try-panel
          onDragOver={(event) => {
            event.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={onDrop}
          className={`pointer-events-auto relative w-full max-w-[27rem] border border-dashed bg-black/55 p-5 backdrop-blur-md transition-colors duration-200 sm:ms-auto sm:p-6 ${
            pinned ? "min-h-0 overflow-y-auto" : ""
          } ${over ? "border-accent bg-accent-soft" : "border-line-strong"}`}
        >
          <p className="flex items-center gap-3 font-mono text-[11px] uppercase tracking-[0.24em] text-accent">
            <span className="motif h-[9px] w-[9px]" />
            {t("kicker")}
          </p>
          <div className="mt-4 flex items-start gap-3">
            <DropGlyph over={over} />
            {/* A phone cannot drop a file, so below the laptop width the panel
                asks for a check, as the first screen does. CSS picks one, so
                neither flashes in after the script runs. */}
            <p className="font-display text-[clamp(1.35rem,2.6vw,2.1rem)] font-semibold leading-[1.05] tracking-[-0.035em]">
              <span data-try-title="phone" className="lg:hidden">
                {first("check")}
              </span>
              <span data-try-title="laptop" className="hidden lg:inline">
                {t("title")}
              </span>
            </p>
          </div>

          <input
            ref={input}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file !== undefined) {
                take(file);
              }
            }}
          />

          {/* The first screen's own Choose button, filled, in its words. */}
          <button
            type="button"
            data-try-choose
            onClick={() => input.current?.click()}
            disabled={busy}
            aria-busy={busy}
            className="mt-5 inline-flex h-11 w-full items-center justify-center gap-2 rounded-[8px] bg-accent px-6 text-xs font-semibold uppercase tracking-[0.14em] text-accent-ink transition-transform duration-200 hover:-translate-y-0.5 active:translate-y-0 disabled:cursor-wait disabled:hover:translate-y-0"
          >
            {busy ? <span aria-hidden className="h-1.5 w-1.5 animate-pulse bg-accent-ink" /> : null}
            {busy ? v("busy") : v("choose")}
          </button>

          {samples.length > 0 && (
            <div className="mt-5">
              <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-text-faint">{t("samples")}</p>
              <ul data-try-samples className="mt-2.5 grid grid-cols-3 gap-2.5">
                {samples.map((sample) => {
                  const name = sample.title ?? shortHex(sample.id, 10, 8);
                  const checking = state.kind === "pending" && state.sample === sample.id;
                  return (
                    <li key={sample.id} className="min-w-0">
                      <button
                        type="button"
                        onClick={() => void takeSample(sample)}
                        disabled={busy}
                        aria-busy={checking}
                        title={name}
                        className="group block min-h-11 w-full text-start disabled:cursor-wait"
                      >
                        {/* Registered images, read through the optimizer. The
                            file itself is still fetched from the gateway when a
                            reader picks one, because the verifier has to be
                            handed the exact bytes that were registered. */}
                        <span className="relative block aspect-[4/3] w-full overflow-hidden border border-line transition-colors duration-200 group-hover:border-accent group-focus-visible:border-accent">
                          <Picture
                            sources={pictureSources(sample.url)}
                            alt={name}
                            sizes="(min-width: 1024px) 8rem, 30vw"
                            className="object-cover opacity-80 transition duration-300 group-hover:scale-[1.06] group-hover:opacity-100"
                          />
                          {checking ? (
                            <span className="absolute inset-x-0 bottom-0 flex items-center gap-1.5 bg-bg/80 px-1.5 py-1 font-mono text-[11px] uppercase tracking-[0.12em] text-accent">
                              <span aria-hidden className="h-1.5 w-1.5 animate-pulse bg-accent" />
                              {v("busy")}
                            </span>
                          ) : null}
                        </span>
                        <span className="mt-1.5 block hyphens-none text-[11px] leading-snug text-text-muted [overflow-wrap:normal] [word-break:normal] transition-colors duration-200 group-hover:text-accent group-focus-visible:text-accent">
                          {name}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          <div ref={said} data-try-answer className="mt-5 min-h-[5.5rem] border-t border-line pt-4">
            {state.kind === "idle" && <p className="text-base leading-relaxed text-text-faint">{t("hint")}</p>}

            {state.kind === "pending" && (
              <p className="font-mono text-[12px] uppercase tracking-[0.16em] text-accent">
                {t("pending")}
                <span className="ms-2 inline-block h-2 w-2 animate-pulse bg-accent align-middle" />
              </p>
            )}

            {state.kind === "error" && (
              <div data-try-failed>
                <p role="alert" className="flex items-start gap-2.5 text-base leading-relaxed text-failed">
                  <WarningMark className="mt-[3px]" />
                  <span>{state.message}</span>
                </p>
                {state.reason === null ? null : <FailureDetails reason={state.reason} className="ms-[23px] mt-3 [&_summary]:text-[11px]" />}
              </div>
            )}

            {state.kind === "done" && (
              <Answer answer={state.answer} name={state.name} title={state.title} named={state.named} />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * The one drawing on the panel: a plate with an arrow coming up out of it.
 *
 * Drawn here rather than pulled from an icon set, so it carries the same stroke
 * weight and the same accent as everything else on the shot and costs no font.
 */
function DropGlyph({ over }: { over: boolean }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      className={`mt-0.5 h-6 w-6 shrink-0 transition-colors duration-200 ${over ? "text-accent" : "text-text-faint"}`}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.25"
      strokeLinecap="square"
    >
      <path d="M4 15v4.5h16V15" />
      <path d="M12 3.5v11" />
      <path d="M7.5 8 12 3.5 16.5 8" />
    </svg>
  );
}

/**
 * The refusals a reader can act on, in this app's words. Anything outside this
 * table has no advice worth giving, so the service's own sentence travels
 * through instead of being paraphrased into something vaguer.
 */
const REFUSALS: Partial<Record<VerifierCode, string>> = {
  offline: "offline",
  "too-large": "tooLarge",
  "not-an-image": "notAnImage",
  "rate-limited": "rateLimited",
};

/**
 * The same sentences for a file this browser refuses before sending it.
 *
 * It is a table of its own rather than a lookup in the one above, and it names
 * every code the shared check can raise: when a new refusal appears, the
 * compiler asks for its sentence here instead of a reader getting a blank one.
 */
const LOCAL_REFUSALS: Record<RefusalCode, string> = {
  "too-large": "tooLarge",
  "not-an-image": "notAnImage",
  empty: "empty",
};

/**
 * The line for a file this browser refuses on its own, or null when the file is
 * worth sending. It answers with the same message keys a refusal from the
 * service uses, so one problem reads as one sentence however it was caught.
 */
export function localRefusal(file: File): string | null {
  const refusal = checkImage(file);
  return refusal === null ? null : LOCAL_REFUSALS[refusal.code];
}

/**
 * What went wrong: a sentence in the reader's language, and the service's or
 * the browser's own words, which stay English and go under Details.
 */
function refusal(error: unknown, t: (key: string) => string): { message: string; reason: string | null } {
  if (error instanceof VerifierError) {
    const key = REFUSALS[error.code];
    return key === undefined ? { message: t("error"), reason: error.message } : { message: t(key), reason: null };
  }
  return { message: t("error"), reason: error instanceof Error ? error.message : String(error) };
}

/**
 * Where to scroll the pinned panel so a new answer can be read, or null when it
 * already can. The answer's top is brought into view, and as much of it under
 * that as the panel has room for.
 */
export function answerScroll(top: number, height: number, scrolled: number, room: number): number | null {
  const seen = top >= scrolled && top + Math.min(height, room) <= scrolled + room;
  return seen ? null : Math.max(0, top - 12);
}

/**
 * The answer in the first screen's shape: the verdict in words first, then how
 * many of the 64 bits the two fingerprints differ by, never a bare confidence.
 */
function Answer({ answer, name, title, named }: { answer: VerifyResponse; name: string; title: string | null; named: boolean }) {
  const t = useTranslations("story.tryIt");
  const v = useTranslations("verify");
  const id = answer.result.exact ?? answer.result.best?.id ?? null;
  // The verify page's own reader, so the challenge is found on the matched row
  // by the one rule rather than by a second copy of it here.
  const read = readAnswer(answer);

  if (id === null || read.kind === "miss") {
    return (
      <div>
        <p className="font-display text-[clamp(1.6rem,3vw,2.4rem)] font-semibold leading-[1] tracking-[-0.04em] text-failed">
          {t("noMatch")}
        </p>
        <StaleIndex minutes={read.staleMinutes} className="mt-2" />
        <p className="mt-2 break-all font-mono text-[11px] text-text-faint">{name}</p>
        <p className="mt-2 text-base leading-relaxed text-text-muted">{t("noMatchBody")}</p>
      </div>
    );
  }

  // Until the registry has named the picture the verdict says only that a
  // match was found, so the words never name it Untitled and then change.
  const said = !named
    ? v("matched")
    : v(read.kind === "exact" ? "verdictExact" : "verdict", { title: title ?? v("untitled") });

  return (
    <div>
      <p data-try-verdict className="max-w-[24ch] font-display text-[clamp(1.2rem,2.2vw,1.6rem)] font-semibold leading-[1.08] tracking-[-0.03em] text-verified">
        {said}
      </p>
      {read.pixelsUnread ? null : (
        <div data-try-bits className="mt-4">
          <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-text-faint">{v("phashDistance")}</p>
          <p className="mt-1 font-display text-[clamp(1.5rem,2.8vw,2.2rem)] font-semibold leading-[1] tracking-[-0.04em] tabular-nums text-accent">
            {v("bits", { count: read.phashDistance, of: 64 })}
          </p>
        </div>
      )}
      <StaleIndex minutes={read.staleMinutes} className="mt-2" />
      {/* The same line the verify card prints when a match was made on the bytes
          alone: nothing about how the two pictures look was compared. */}
      {read.pixelsUnread ? (
        <p data-pixels-unread className="mt-2 max-w-[40ch] text-base leading-relaxed text-text-muted">
          {v("pixelsUnread")}
        </p>
      ) : null}
      {/* The link says where it goes. A truncated hex word on its own was the
          only next step this panel offered, and nothing about it read as one. */}
      <Link
        href={`/passport/${id}`}
        className="group mt-3 inline-flex flex-wrap items-baseline gap-x-2 gap-y-1 text-[12px] text-text-muted transition-colors duration-200 hover:text-accent"
      >
        <span className="underline decoration-line underline-offset-4 transition-colors duration-200 group-hover:decoration-accent">
          {t("openPassport")}
        </span>
        <span className="break-all font-mono text-[11px] text-text-faint transition-colors duration-200 group-hover:text-accent">
          {shortHex(id, 10, 8)}
        </span>
      </Link>
      <p className="mt-2 break-all font-mono text-[11px] text-text-faint">{name}</p>

      {/* The same sentence the verify card prints, from the same field and the
          same words: a record under challenge is worth knowing about here too,
          not only on the page a reader might never open. */}
      <DisputeLine dispute={read.dispute} className="mt-3" />

      {!answer.manifest.present && <p className="mt-3 text-base leading-relaxed text-text-faint">{t("noManifest")}</p>}
    </div>
  );
}
