"use client";

import { useTranslations } from "next-intl";
import { useEffect, useRef, useState, type DragEvent } from "react";
import type { Hex } from "viem";
import { probe, progress, resetProbe, type ProbeState } from "@/components/story/signals";
import { Picture } from "@/components/passport/Picture";
import { pictureSources } from "@/lib/images";
import { Link } from "@/lib/i18n/routing";
import { shortHex } from "@/lib/chain/client";
import { checkImage } from "@/lib/upload/checkImage";
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
  | { kind: "done"; name: string; answer: VerifyResponse };

/**
 * The beat a judge can touch: drop any copy of any image and the running
 * verifier answers, on the plate and in words.
 *
 * The panel is pinned over the scene and fades in with the offer beat, straight
 * from the beats table. Opacity alone would leave the button in the tab order
 * while the camera is still flying, so the whole subtree is inert until it is
 * actually on screen.
 */
/** One registered image the panel offers, for a judge with no file to hand. */
export interface TrySample {
  id: Hex;
  url: string;
}

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

  async function check(file: File) {
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
      setState({ kind: "done", name: file.name, answer });
    } catch (error) {
      publish("refused");
      setState({ kind: "error", message: refusal(error, t) });
    }
  }

  /**
   * One of the offered pictures, fetched back out of the gateway and put through
   * the same check a dropped file gets.
   *
   * The gateway serves the 512 pixel copy the metadata carries, so this is a
   * resized copy of a registered image rather than the file itself: the answer
   * a judge sees is a real near-match, not a byte-for-byte lookup.
   */
  async function takeSample(sample: TrySample) {
    setState({ kind: "pending", name: shortHex(sample.id, 10, 8) });
    try {
      const response = await fetch(sample.url);
      if (!response.ok) {
        throw new Error(`the gateway answered ${response.status}`);
      }
      const blob = await response.blob();
      const kind = blob.type === "" ? "image/jpeg" : blob.type;
      await check(new File([blob], `${shortHex(sample.id, 6, 4)}.${kind.split("/")[1] ?? "jpg"}`, { type: kind }));
    } catch (error) {
      publish("refused");
      setState({ kind: "error", message: refusal(error, t) });
    }
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

            {state.kind === "done" && <Answer answer={state.answer} name={state.name} />}
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
 * The line for a file this browser refuses on its own, or null when the file is
 * worth sending. It answers with the same message keys a refusal from the
 * service uses, so one problem reads as one sentence however it was caught.
 */
export function localRefusal(file: File): string | null {
  const refusal = checkImage(file);
  if (refusal === null) {
    return null;
  }
  // Both codes the shared check can raise are named in the table above.
  return REFUSALS[refusal.code] ?? "error";
}

/** What went wrong, in a sentence rather than a status code. */
function refusal(error: unknown, t: (key: string, values?: Record<string, string>) => string): string {
  if (error instanceof VerifierError) {
    const key = REFUSALS[error.code];
    return key === undefined ? t("error", { reason: error.message }) : t(key);
  }
  return t("error", { reason: error instanceof Error ? error.message : String(error) });
}

function Answer({ answer, name }: { answer: VerifyResponse; name: string }) {
  const t = useTranslations("story.tryIt");
  const id = answer.result.exact ?? answer.result.best?.id ?? null;

  if (id === null) {
    return (
      <div>
        <p className="font-display text-[clamp(1.6rem,3vw,2.4rem)] font-semibold leading-[1] tracking-[-0.04em] text-failed">
          {t("noMatch")}
        </p>
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
      <Link
        href={`/passport/${id}`}
        className="mt-3 inline-block break-all font-mono text-[12px] text-text-muted underline decoration-line underline-offset-4 transition-colors duration-200 hover:text-accent"
      >
        {shortHex(id, 10, 8)}
      </Link>
      <p className="mt-2 break-all font-mono text-[11px] text-text-faint">{name}</p>
      {!answer.manifest.present && <p className="mt-3 text-sm leading-relaxed text-text-faint">{t("noManifest")}</p>}
    </div>
  );
}
