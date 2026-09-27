"use client";

import { useTranslations } from "next-intl";
import { useEffect, useRef, useState, type DragEvent } from "react";
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
  | { kind: "pending"; name: string }
  | { kind: "error"; message: string }
  | { kind: "done"; name: string; answer: VerifyResponse; title: string | null };

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
  const shell = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const preview = useRef<string | null>(null);
  const [state, setState] = useState<State>({ kind: "idle" });
  const [over, setOver] = useState(false);

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
  function take(file: File) {
    const refused = localRefusal(file);
    if (refused !== null) {
      setState({ kind: "error", message: t(refused) });
      return;
    }
    void check(file);
  }

  async function check(file: File, known: string | null = null) {
    if (preview.current !== null) {
      URL.revokeObjectURL(preview.current);
    }
    preview.current = URL.createObjectURL(file);
    onPreview(preview.current);

    publish("pending");
    setState({ kind: "pending", name: file.name });

    try {
      const answer = await verify({ file });
      const matched = answer.result.exact !== null || answer.result.best !== null;
      publish(matched ? "matched" : "refused", answer.result.confidence);
      setState({ kind: "done", name: file.name, answer, title: known });
      void readTitle(answer);
    } catch (error) {
      publish("refused");
      setState({ kind: "error", message: refusal(error, t) });
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
    const title = passport?.title;
    if (title === undefined) {
      return;
    }
    // The reader may have dropped another file while the registry answered, so
    // the name is only applied to the answer it belongs to.
    setState((current) => (current.kind === "done" && current.answer === answer ? { ...current, title } : current));
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
    setState({ kind: "pending", name: sample.title ?? shortHex(sample.id, 10, 8) });

    let file: File;
    try {
      file = await fileFromSample(sample);
    } catch {
      publish("refused");
      setState({ kind: "error", message: t("sampleFailed") });
      return;
    }

    await check(file, sample.title ?? null);
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
      <div className="mx-auto w-full max-w-[100rem]">
        <div
          onDragOver={(event) => {
            event.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={onDrop}
          className={`pointer-events-auto w-full max-w-[27rem] border border-dashed bg-black/55 p-5 backdrop-blur-md transition-colors duration-200 sm:ms-auto sm:p-6 ${
            over ? "border-accent bg-accent-soft" : "border-line-strong"
          }`}
        >
          <p className="flex items-center gap-3 font-mono text-[11px] uppercase tracking-[0.24em] text-accent">
            <span className="motif h-[9px] w-[9px]" />
            {t("kicker")}
          </p>
          <div className="mt-4 flex items-start gap-3">
            <DropGlyph over={over} />
            <p className="font-display text-[clamp(1.35rem,2.6vw,2.1rem)] font-semibold leading-[1.05] tracking-[-0.035em]">
              {t("title")}
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

          <button
            type="button"
            onClick={() => input.current?.click()}
            className="mt-5 w-full rounded-[8px] border border-line px-5 py-3 text-[11px] uppercase tracking-[0.2em] text-text-muted transition-colors duration-200 hover:border-accent hover:text-accent"
          >
            {t("choose")}
          </button>

          {samples.length > 0 && (
            <div className="mt-5">
              <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-text-faint">{t("samples")}</p>
              <ul className="mt-2.5 flex gap-2.5">
                {samples.map((sample) => (
                  <li key={sample.id} className="flex-1">
                    <button
                      type="button"
                      onClick={() => void takeSample(sample)}
                      className="group block w-full overflow-hidden border border-line transition-colors duration-200 hover:border-accent focus-visible:border-accent"
                    >
                      <span className="sr-only">{shortHex(sample.id, 10, 8)}</span>
                      {/* Registered images, read through the optimizer. The
                          file itself is still fetched from the gateway when a
                          reader picks one, because the verifier has to be
                          handed the exact bytes that were registered. */}
                      <span className="relative block aspect-[4/3] w-full overflow-hidden">
                        <Picture
                          sources={pictureSources(sample.url)}
                          sizes="(min-width: 1024px) 8rem, 30vw"
                          className="object-cover opacity-80 transition duration-300 group-hover:scale-[1.06] group-hover:opacity-100"
                        />
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="mt-5 min-h-[5.5rem] border-t border-line pt-4">
            {state.kind === "idle" && <p className="text-sm leading-relaxed text-text-faint">{t("hint")}</p>}

            {state.kind === "pending" && (
              <p className="font-mono text-[12px] uppercase tracking-[0.16em] text-accent">
                {t("pending")}
                <span className="ms-2 inline-block h-2 w-2 animate-pulse bg-accent align-middle" />
              </p>
            )}

            {state.kind === "error" && <p className="text-sm leading-relaxed text-failed">{state.message}</p>}

            {state.kind === "done" && <Answer answer={state.answer} name={state.name} title={state.title} />}
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

/** What went wrong, in a sentence rather than a status code. */
function refusal(error: unknown, t: (key: string, values?: Record<string, string>) => string): string {
  if (error instanceof VerifierError) {
    const key = REFUSALS[error.code];
    return key === undefined ? t("error", { reason: error.message }) : t(key);
  }
  return t("error", { reason: error instanceof Error ? error.message : String(error) });
}

function Answer({ answer, name, title }: { answer: VerifyResponse; name: string; title: string | null }) {
  const t = useTranslations("story.tryIt");
  const v = useTranslations("verify");
  const id = answer.result.exact ?? answer.result.best?.id ?? null;
  // The verify page's own reader, so the challenge is found on the matched row
  // by the one rule rather than by a second copy of it here.
  const read = readAnswer(answer);

  if (id === null) {
    return (
      <div>
        <p className="font-display text-[clamp(1.6rem,3vw,2.4rem)] font-semibold leading-[1] tracking-[-0.04em] text-failed">
          {t("noMatch")}
        </p>
        <StaleIndex minutes={read.staleMinutes} className="mt-2" />
        <p className="mt-2 break-all font-mono text-[11px] text-text-faint">{name}</p>
        <p className="mt-2 text-sm leading-relaxed text-text-muted">{t("noMatchBody")}</p>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-end gap-3">
        <span className="font-display text-[clamp(2rem,4vw,3rem)] font-semibold leading-[0.85] tracking-[-0.05em] tabular-nums text-verified">
          {answer.result.confidence.toFixed(2)}
        </span>
        <span className="pb-1 font-mono text-[11px] uppercase tracking-[0.16em] text-text-faint">
          {answer.result.exact !== null ? t("exact") : t("match")}
        </span>
      </div>
      <StaleIndex minutes={read.staleMinutes} className="mt-2" />
      {/* The same line the verify card prints when a match was made on the bytes alone: the 1.00
          above is a byte match, not a comparison of how the two pictures look. */}
      {read.kind !== "miss" && read.pixelsUnread ? (
        <p data-pixels-unread className="mt-2 max-w-[40ch] text-xs leading-relaxed text-text-muted">
          {v("pixelsUnread")}
        </p>
      ) : null}
      {/* What was matched, by its own name. The registry answers with a hex
          word, which tells a reader nothing, so the picture's pinned title is
          read after the answer lands and takes its place the moment it does. */}
      {title !== null && (
        <p className="mt-3 max-w-[26ch] font-display text-[1.05rem] font-semibold leading-[1.15] tracking-[-0.02em] text-text">
          {title}
        </p>
      )}

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
      <DisputeLine dispute={read.kind === "miss" ? undefined : read.dispute} className="mt-3" />

      {!answer.manifest.present && <p className="mt-3 text-sm leading-relaxed text-text-faint">{t("noManifest")}</p>}
    </div>
  );
}
