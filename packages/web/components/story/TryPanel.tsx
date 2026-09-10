"use client";

import { useTranslations } from "next-intl";
import { useEffect, useRef, useState, type DragEvent } from "react";
import { forwardTouchMove, forwardTouchStart, forwardWheel, probe, progress, resetProbe } from "@/components/story/signals";
import { Link } from "@/lib/i18n/routing";
import { shortHex } from "@/lib/chain/client";
import { checkImage } from "@/lib/upload/checkImage";
import { VerifierError, verify, type VerifierCode, type VerifyResponse } from "@/lib/verifier/client";

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
export function TryPanel({ onPreview, pinned = true }: { onPreview: (url: string | null) => void; pinned?: boolean }) {
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

    probe.state = "pending";
    probe.confidence = 0;
    setState({ kind: "pending", name: file.name });

    try {
      const answer = await verify({ file });
      const matched = answer.result.exact !== null || answer.result.best !== null;
      probe.state = matched ? "matched" : "refused";
      probe.confidence = answer.result.confidence;
      setState({ kind: "done", name: file.name, answer });
    } catch (error) {
      probe.state = "refused";
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
      className={
        pinned
          ? "pointer-events-none absolute inset-0 z-30 flex items-center px-5 opacity-0 sm:px-8 lg:px-14"
          : "px-0"
      }
    >
      <div className="mx-auto w-full max-w-[100rem]">
        <div
          onDragOver={(event) => {
            event.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={onDrop}
          onWheel={pinned ? forwardWheel : undefined}
          onTouchStart={pinned ? forwardTouchStart : undefined}
          onTouchMove={pinned ? forwardTouchMove : undefined}
          className={`pointer-events-auto w-full max-w-[27rem] border bg-black/55 p-6 backdrop-blur-md transition-colors duration-200 sm:ms-auto ${
            over ? "border-accent" : "border-line"
          }`}
        >
          <p className="flex items-center gap-3 font-mono text-[11px] uppercase tracking-[0.24em] text-accent">
            <span className="motif h-[9px] w-[9px]" />
            {t("kicker")}
          </p>
          <p className="mt-4 font-display text-[clamp(1.5rem,2.6vw,2.1rem)] font-semibold leading-[1] tracking-[-0.035em]">
            {t("title")}
          </p>

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
