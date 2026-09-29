"use client";

import { MotionConfig, motion } from "framer-motion";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { verify, verifierHost } from "@/lib/verifier/client";
import type { TrySample } from "@/lib/data/samples";
import { AnswerCard, type Stage } from "./AnswerCard";
import { chosenProblem, passportFor, readAnswer, verifyProblem, type Problem } from "./answer";
import { matchedPassport } from "./lookup";
import { fileFromSample } from "./sample";
import { Samples } from "./Samples";
import { sizeLabel, uploadProblem } from "./upload";

/** Stands in for the host while the sentence is translated, so the host can be set as one piece. */
const HOST_MARK = "\u0000host\u0000";

/**
 * The privacy line with the service's host kept whole: it moves to the next
 * line as one piece rather than breaking at a hyphen, and only a host wider
 * than the whole column breaks inside itself.
 */
export function Privacy({ line, host }: { line: string; host: string }) {
  const at = line.indexOf(HOST_MARK);
  if (at < 0) {
    return <>{line}</>;
  }
  return (
    <>
      {line.slice(0, at)}
      <span data-privacy-host className="inline-block max-w-full [overflow-wrap:anywhere]">
        {host}
      </span>
      {line.slice(at + HOST_MARK.length)}
    </>
  );
}

const ACCEPT = "image/jpeg,image/png,image/webp";

/**
 * Drop any copy of any image and the running verifier says which passport it
 * belongs to. A reader with no Moolam picture of their own presses one of the
 * offered plates instead, which fetches that picture's pinned bytes and puts
 * them through the same check.
 *
 * One step on purpose: choosing or dropping a file starts the check. A second
 * button between the file and the answer taught nobody anything, and the panel
 * on the home page already answers in place, so the two behaved differently for
 * no reason.
 *
 * The file goes straight from this browser to the verify service, and the
 * passport behind the answer is read from Monad by this browser too, so the
 * app's own server is not in the middle of a check at any point.
 */
export function VerifyScreen({ samples = [] }: { samples?: TrySample[] }) {
  const t = useTranslations("verify");
  const input = useRef<HTMLInputElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [over, setOver] = useState(false);
  const [stage, setStage] = useState<Stage>({ kind: "idle" });
  // Bumped by every plate pressed and every file chosen or dropped. A check
  // only writes to the card while its number is still the newest, so the card
  // ends on the answer to the last thing the reader did, never on a slower
  // earlier one.
  const run = useRef(0);
  const busy = stage.kind === "checking";
  const landed = stage.kind === "answer" || stage.kind === "problem";

  // On a phone the answer lands a screen and a half below the picture, where
  // nobody scrolled to look for it. It is brought up to meet the reader. On a
  // wide screen the card is already beside the picture, so nothing moves.
  useEffect(() => {
    const node = card.current;
    if (!landed || node === null) {
      return;
    }
    const box = node.getBoundingClientRect();
    if (box.top >= 0 && box.bottom <= window.innerHeight) {
      return;
    }
    // Read at the moment of the jump, so a setting changed while the page is
    // open counts, and the same way the Studio's own scroll reads it.
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    node.scrollIntoView({ block: "start", behavior: reduced ? "instant" : "smooth" });
  }, [landed]);

  // The chosen picture is drawn from the file itself, so nothing is uploaded to
  // preview it. The URL is handed back to the browser when the file changes.
  const preview = useMemo(() => (file === null ? null : URL.createObjectURL(file)), [file]);
  useEffect(
    () => () => {
      if (preview !== null) {
        URL.revokeObjectURL(preview);
      }
    },
    [preview],
  );

  function owns(mine: number): boolean {
    return run.current === mine;
  }

  /** A file from the input, the drop target or a plate. A plate hands over the run it already started. */
  function take(chosen: File | undefined, started?: number) {
    if (chosen === undefined) {
      return;
    }
    // A plate's bytes are a registered picture read back from its pin, which the
    // service has already decoded once, so only a reader's own file has its
    // first bytes read before it is sent.
    if (started !== undefined) {
      const problem = chosenProblem(chosen);
      if (problem !== null) {
        refuse(chosen, problem);
        return;
      }
      setFile(chosen);
      void check(chosen, started);
      return;
    }
    const mine = ++run.current;
    void screen(chosen, mine);
  }

  /**
   * A file the service would refuse is refused here instead, so the answer is
   * instant and nothing is uploaded to earn it.
   */
  async function screen(chosen: File, mine: number) {
    const problem = await uploadProblem(chosen);
    if (!owns(mine)) {
      return;
    }
    if (problem !== null) {
      refuse(chosen, problem);
      return;
    }
    setFile(chosen);
    void check(chosen, mine);
  }

  function refuse(chosen: File, problem: Problem) {
    setFile(null);
    const reason = [chosen.name, sizeLabel(chosen.size)].filter((part) => part !== "").join(" ");
    setStage({ kind: "problem", problem: { ...problem, reason } });
  }

  /**
   * An offered picture, fetched from the gateway and handed to `take`, which is
   * the same function the file input and the drop target call. Nothing about
   * the check that follows knows where the bytes came from.
   */
  async function pick(sample: TrySample) {
    const mine = ++run.current;
    setStage({ kind: "checking", name: sample.title ?? sample.id });
    let file: File;
    try {
      file = await fileFromSample(sample);
    } catch {
      if (owns(mine)) {
        setFile(null);
        setStage({ kind: "problem", problem: { key: "sampleFailed" } });
      }
      return;
    }
    if (owns(mine)) {
      take(file, mine);
    }
  }

  async function check(chosen: File, mine: number) {
    setStage({ kind: "checking", name: chosen.name });

    let answer;
    try {
      answer = readAnswer(await verify({ file: chosen }));
    } catch (error) {
      if (owns(mine)) {
        setStage({ kind: "problem", problem: verifyProblem(error) });
      }
      return;
    }
    // The service answers with an id and nothing else, so the passport behind
    // it is read from the chain while the card is still turning. That read
    // failing leaves the answer standing.
    const passport = await passportFor(answer, matchedPassport);
    if (owns(mine)) {
      setStage({ kind: "answer", answer, passport });
    }
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setOver(false);
    take(event.dataTransfer.files?.[0]);
  }

  return (
    <MotionConfig reducedMotion="user">
      <div
        data-verify-tool
        className="mt-7 grid gap-12 sm:mt-8 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)] lg:gap-16"
      >
        {/* The CSS rise rather than a motion component, so the server's HTML
            carries the drop box visible and a slow phone can use it before the
            script arrives. The reduced-motion rule in globals.css turns it off. */}
        <section data-verify-drop className="rise" style={{ animationDelay: "200ms" }}>
          <input
            ref={input}
            type="file"
            accept={ACCEPT}
            className="hidden"
            onChange={(event) => take(event.target.files?.[0])}
          />

          <div
            onDragOver={(event) => {
              event.preventDefault();
              setOver(true);
            }}
            onDragLeave={() => setOver(false)}
            onDrop={onDrop}
            className={`grain relative overflow-hidden border border-dashed transition-colors duration-200 ${
              over ? "border-accent bg-accent-soft" : "border-line-strong"
            }`}
          >
            {preview === null ? (
              <div className="flex flex-col items-start gap-5 p-6 sm:p-9">
                <p className="max-w-[18ch] font-display text-[clamp(1.6rem,3.4vw,2.6rem)] font-semibold leading-[1.05] tracking-[-0.03em]">
                  {t("dropTitle")}
                </p>
                <button
                  type="button"
                  onClick={() => input.current?.click()}
                  className="rounded-[8px] bg-accent px-6 py-3.5 text-sm font-semibold uppercase tracking-[0.14em] text-accent-ink transition-transform duration-200 hover:-translate-y-0.5"
                >
                  {t("choose")}
                </button>
                <p className="max-w-[46ch] text-xs leading-relaxed text-text-muted">{t("hint")}</p>
              </div>
            ) : (
              <div className="relative">
                {/* The visitor's own file, drawn before it is sent anywhere. It
                    is a blob address in this browser, so there is nothing for
                    the optimizer to fetch and no gateway read behind it. */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={preview} alt="" className="max-h-[30rem] w-full object-cover" />
                <div className="scrim pointer-events-none absolute inset-0" />
                <div className="absolute inset-x-0 bottom-0 flex flex-wrap items-end justify-between gap-3 p-5">
                  {/* A file name wraps at its hyphens and dots like words do,
                      and breaks inside a word only if one piece is wider than
                      the caption. */}
                  <p className="max-w-[30ch] font-mono text-[11px] text-text [overflow-wrap:anywhere]">
                    {file?.name} <span className="text-text-muted">{sizeLabel(file?.size)}</span>
                  </p>
                  <button
                    type="button"
                    onClick={() => input.current?.click()}
                    disabled={busy}
                    className="rounded-[8px] border border-line-strong bg-bg/70 px-4 py-2 text-[10px] uppercase tracking-[0.18em] text-text backdrop-blur transition-colors duration-200 hover:border-accent hover:text-accent disabled:opacity-60"
                  >
                    {t("replace")}
                  </button>
                </div>
              </div>
            )}
          </div>

          <Samples samples={samples} onPick={(sample) => void pick(sample)} busy={busy} />

          {/* The verdict, under the picture it is about. The card below carries
              the working: the confidence, the two distances and what was
              measured. This line is the answer a reader came for, in the same
              words the passport page's drop panel uses. */}
          {stage.kind === "answer" ? (
            <motion.p
              data-verdict-line
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
              className={`mt-6 max-w-[34ch] font-display text-[clamp(1.4rem,3vw,2.1rem)] font-semibold leading-[1.05] tracking-[-0.035em] ${
                stage.answer.kind === "miss" ? "text-failed" : "text-verified"
              }`}
            >
              {stage.answer.kind === "miss"
                ? t("none")
                : stage.answer.kind === "exact"
                  ? t("verdictExact", { title: stage.passport?.title ?? t("untitled") })
                  : t("verdict", { title: stage.passport?.title ?? t("untitled") })}
            </motion.p>
          ) : null}

          <div className="mt-8 flex flex-wrap items-center gap-4">
            {file === null ? null : (
              <button
                type="button"
                onClick={() => input.current?.click()}
                disabled={busy}
                className="rounded-[8px] bg-accent px-7 py-4 text-sm font-semibold uppercase tracking-[0.14em] text-accent-ink transition-transform duration-200 hover:-translate-y-0.5 disabled:translate-y-0 disabled:opacity-60"
              >
                {busy ? t("busy") : t("again")}
              </button>
            )}
            <p className="max-w-[38ch] text-xs leading-relaxed text-text-muted">
              <Privacy line={t("privacy", { host: HOST_MARK })} host={verifierHost()} />
            </p>
          </div>
        </section>

        <div
          ref={card}
          data-answer-card
          className="rise scroll-mt-24 lg:sticky lg:top-28 lg:self-start"
          style={{ animationDelay: "280ms" }}
        >
          <AnswerCard stage={stage} />
        </div>

        {/* On a phone the answer is scrolled up to meet the reader, which leaves
            the Choose another over the picture a screen or more above. The next
            check starts here instead, one press from the answer. On a wide
            screen the card sits beside the picture and the one there is enough. */}
        {landed ? (
          <div data-choose-after className="-mt-4 lg:hidden">
            <button
              type="button"
              onClick={() => input.current?.click()}
              className="w-full rounded-[8px] bg-accent px-7 py-4 text-sm font-semibold uppercase tracking-[0.14em] text-accent-ink transition-transform duration-200 hover:-translate-y-0.5 sm:w-auto"
            >
              {t("replace")}
            </button>
          </div>
        ) : null}
      </div>
    </MotionConfig>
  );
}
