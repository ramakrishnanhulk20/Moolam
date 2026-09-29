"use client";

import { AnimatePresence, MotionConfig, motion } from "framer-motion";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import { createPortal } from "react-dom";
import { verify, verifierHost } from "@/lib/verifier/client";
import type { TrySample } from "@/lib/data/samples";
import { AnswerCard, type Stage } from "./AnswerCard";
import { chosenProblem, passportFor, readAnswer, verifyProblem, type Problem } from "./answer";
import { matchedPassport } from "./lookup";
import { fileFromSample } from "./sample";
import { Samples } from "./Samples";
import { sampleAsked } from "./ShareAnswer";
import { carriesFiles, droppedFile, pastedImage, pastedIntoText, sizeLabel, uploadProblem } from "./upload";

/** Stands in for the host while the sentence is translated, so the host can be set as one piece. */
export const HOST_MARK = "\u0000host\u0000";

/** A bracket that opens right before the host, in Latin or full-width type. */
const OPENS_HOST = /[(［（「]+$/u;
/** The bracket that closes it and any stop that follows, so no line starts with them. */
const CLOSES_HOST = /^[)］）」]+[.,;:!?。、，．]*/u;

/**
 * The privacy line with the service's host set as one piece together with the
 * brackets around it, so an opening bracket is never left alone at a line's
 * end. The piece moves to the next line whole. Only when it is wider than the
 * column does it break, and then at the host's dots, never at its hyphens.
 */
export function Privacy({ line, host }: { line: string; host: string }) {
  const at = line.indexOf(HOST_MARK);
  if (at < 0) {
    return <>{line}</>;
  }
  const before = line.slice(0, at);
  const after = line.slice(at + HOST_MARK.length);
  const open = OPENS_HOST.exec(before)?.[0] ?? "";
  const close = CLOSES_HOST.exec(after)?.[0] ?? "";
  const labels = host.split(".");

  return (
    <>
      {before.slice(0, before.length - open.length)}
      <span data-privacy-host className="inline-block max-w-full">
        {labels.map((label, index) => (
          <span key={index}>
            <span className="whitespace-nowrap">
              {index === 0 ? open : null}
              {label}
              {index < labels.length - 1 ? "." : close}
            </span>
            {index < labels.length - 1 ? <wbr /> : null}
          </span>
        ))}
      </span>
      {after.slice(close.length)}
    </>
  );
}

const ACCEPT = "image/jpeg,image/png,image/webp";

const noSubscription = () => () => undefined;

/** Where the file on the card came from: the reader's own, or one of the offered pictures. */
type Source = { kind: "file" } | { kind: "sample"; id: string };

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
  const [dragging, setDragging] = useState(false);
  const [source, setSource] = useState<Source | null>(null);
  const [stage, setStage] = useState<Stage>({ kind: "idle" });
  const veil = useRef<HTMLDivElement>(null);
  // False for the server's render and the hydrating one, true after, so the
  // veil's portal never appears in a tree React is matching against HTML.
  const hydrated = useSyncExternalStore(noSubscription, () => true, () => false);
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
    setSource({ kind: "file" });
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
    setSource({ kind: "sample", id: sample.id });
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

  function checkAgain() {
    if (file === null) {
      return;
    }
    const mine = ++run.current;
    void check(file, mine);
  }

  // The window listeners below are set once, so they reach the newest render's
  // functions through this rather than holding the first render's.
  const latest = useRef({ take, pick });
  useEffect(() => {
    latest.current = { take, pick };
  });

  // A file dragged anywhere over the page is taken wherever it is let go, and
  // a picture pasted anywhere is taken the same way. Both go through `take`,
  // so they get the same first-bytes check a chosen file gets.
  useEffect(() => {
    const enter = (event: globalThis.DragEvent) => {
      if (carriesFiles(event.dataTransfer)) {
        event.preventDefault();
        setDragging(true);
      }
    };
    const over = (event: globalThis.DragEvent) => {
      if (carriesFiles(event.dataTransfer)) {
        // Without this the browser opens a file let go outside the box in
        // place of the page.
        event.preventDefault();
        if (event.dataTransfer !== null) {
          event.dataTransfer.dropEffect = "copy";
        }
      }
    };
    // Once the veil is up it is the only thing under the pointer, so a leave
    // from it, or a leave with nowhere to go, is the drag leaving the window.
    const leave = (event: globalThis.DragEvent) => {
      if (event.target === veil.current || event.relatedTarget === null) {
        setDragging(false);
      }
    };
    const drop = (event: globalThis.DragEvent) => {
      setDragging(false);
      if (!carriesFiles(event.dataTransfer)) {
        return;
      }
      event.preventDefault();
      latest.current.take(droppedFile(event.dataTransfer));
    };
    const paste = (event: ClipboardEvent) => {
      if (pastedIntoText(event.target)) {
        return;
      }
      const picture = pastedImage(event.clipboardData);
      if (picture !== undefined) {
        event.preventDefault();
        latest.current.take(picture);
      }
    };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragover", over);
    window.addEventListener("dragleave", leave);
    window.addEventListener("drop", drop);
    window.addEventListener("paste", paste);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragover", over);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("drop", drop);
      window.removeEventListener("paste", paste);
    };
  }, []);

  // A shared answer link, /verify?sample=<passport id>, runs that picture's
  // check as the page opens. An offered picture is pressed as if by hand; any
  // other passport is read from Monad first, and runs only when it has a
  // published picture to fetch. A reader who presses something while that read
  // is out has done the newer thing, and the link gives way to it.
  const askedOnce = useRef(false);
  useEffect(() => {
    if (askedOnce.current) {
      return;
    }
    askedOnce.current = true;
    const wanted = sampleAsked(window.location.search);
    if (wanted === null) {
      return;
    }
    const offered = samples.find((sample) => sample.id.toLowerCase() === wanted.toLowerCase());
    if (offered !== undefined) {
      void latest.current.pick(offered);
      return;
    }
    const before = run.current;
    matchedPassport(wanted)
      .then((found) => {
        if (found === null || found.sealed === true || found.thumbnailUrl === undefined || run.current !== before) {
          return;
        }
        void latest.current.pick({ id: found.id, url: found.thumbnailUrl, title: found.title });
      })
      .catch(() => undefined);
  }, [samples]);

  const fromFile = source?.kind === "file";

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
            className={`grain relative overflow-hidden border border-dashed transition-colors duration-200 ${
              dragging ? "border-accent bg-accent-soft" : "border-line-strong"
            }`}
          >
            {preview === null ? (
              <div className="flex flex-col items-start gap-5 p-6 sm:p-9">
                {/* A phone has nothing to drag a file from, so it is told only
                    what it can do. Chosen by the pointer in CSS, so the server's
                    HTML is already right for the device reading it. */}
                <p className="max-w-[18ch] font-display text-[clamp(1.6rem,3.4vw,2.6rem)] font-semibold leading-[1.05] tracking-[-0.03em]">
                  <span className="pointer-coarse:hidden">{t("dropTitle")}</span>
                  <span className="hidden pointer-coarse:inline">{t("dropTitleTouch")}</span>
                </p>
                <div className="flex flex-wrap items-center gap-x-6 gap-y-4">
                  <button
                    type="button"
                    onClick={() => input.current?.click()}
                    className="rounded-[8px] bg-accent px-6 py-3.5 text-sm font-semibold uppercase tracking-[0.14em] text-accent-ink transition-transform duration-200 hover:-translate-y-0.5"
                  >
                    {t("choose")}
                  </button>
                  <div data-no-account className="max-w-[36ch]">
                    <p className="flex items-center gap-2.5 font-mono text-[10px] uppercase tracking-[0.24em] text-verified">
                      <span className="motif h-[8px] w-[8px]" />
                      {t("noAccount")}
                    </p>
                    <p className="mt-1.5 text-pretty text-base leading-relaxed text-text-muted">{t("noAccountWhy")}</p>
                  </div>
                </div>
                <div>
                  <p className="max-w-[54ch] text-pretty text-base leading-relaxed text-text-muted">{t("hint")}</p>
                  <p data-paste-hint className="mt-1.5 hidden max-w-[60ch] text-base leading-relaxed text-text-faint pointer-fine:block">
                    {t("paste")}
                  </p>
                </div>
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
            <p className="max-w-[60ch] text-base leading-relaxed text-text-muted">
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
          <AnswerCard
            stage={stage}
            copy={fromFile && stage.kind === "answer" && preview !== null ? preview : undefined}
            sampleId={source?.kind === "sample" && stage.kind === "answer" ? source.id : undefined}
            onCheckAgain={fromFile && stage.kind === "problem" && file !== null ? checkAgain : undefined}
            onChooseAnother={stage.kind === "answer" ? () => input.current?.click() : undefined}
          />
        </div>

        {/* On a phone the answer is scrolled up to meet the reader, which leaves
            the Choose another over the picture a screen or more above. The next
            check starts beside the verdict inside the card, and here at its foot
            as well, so a reader who read the card to the end is one press away
            too. On a wide screen the card sits beside the picture, and the
            verdict's own button is enough. */}
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

      {/* Hung on the body, so no transformed parent can pin the veil inside
          its own box instead of the window. */}
      {hydrated ? createPortal(<DropVeil shown={dragging} veil={veil} line={t("dropAnywhere")} />, document.body) : null}
    </MotionConfig>
  );
}

/** The whole window, while a file is dragged over the page: let go anywhere. */
function DropVeil({ shown, veil, line }: { shown: boolean; veil: RefObject<HTMLDivElement | null>; line: string }) {
  return (
    <AnimatePresence>
      {shown ? (
        <motion.div
          ref={veil}
          data-drop-veil
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
          className="fixed inset-0 z-[90] flex items-end bg-bg/80 p-5 backdrop-blur-md sm:p-10"
        >
          <div className="pointer-events-none absolute inset-4 border-2 border-dashed border-accent sm:inset-8" />
          <motion.p
            initial={{ opacity: 0, y: 24 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.45, ease: [0.16, 1, 0.3, 1] }}
            className="pointer-events-none relative max-w-[14ch] p-4 font-display text-[clamp(3rem,9vw,8rem)] font-semibold leading-[0.9] tracking-[-0.045em] sm:p-8"
          >
            <span className="motif mb-6 block h-4 w-4" />
            {line}
          </motion.p>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
