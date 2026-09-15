"use client";

import { MotionConfig, motion } from "framer-motion";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { verify, verifierHost } from "@/lib/verifier/client";
import { AnswerCard, type Stage } from "./AnswerCard";
import { chosenProblem, readAnswer, verifyProblem } from "./answer";
import { matchedPassport } from "./lookup";

const ACCEPT = "image/jpeg,image/png,image/webp";

/**
 * Drop any copy of any image and the running verifier says which passport it
 * belongs to.
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
export function VerifyScreen() {
  const t = useTranslations("verify");
  const input = useRef<HTMLInputElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [over, setOver] = useState(false);
  const [stage, setStage] = useState<Stage>({ kind: "idle" });
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
    node.scrollIntoView({ block: "start", behavior: "smooth" });
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

  function take(chosen: File | undefined) {
    if (chosen === undefined) {
      return;
    }
    // A file the service would refuse is refused here instead, so the answer is
    // instant and nothing is uploaded to earn it.
    const problem = chosenProblem(chosen);
    if (problem !== null) {
      setFile(null);
      setStage({ kind: "problem", problem: { ...problem, reason: `${chosen.name} ${fileSize(chosen)}` } });
      return;
    }
    setFile(chosen);
    void check(chosen);
  }

  async function check(chosen: File) {
    setStage({ kind: "checking", name: chosen.name });

    try {
      const answer = readAnswer(await verify({ file: chosen }));
      // The service answers with an id and nothing else, so the passport behind
      // it is read from the chain while the card is still turning.
      const passport = answer.kind === "miss" ? null : await matchedPassport(answer.id);
      setStage({ kind: "answer", answer, passport });
    } catch (error) {
      setStage({ kind: "problem", problem: verifyProblem(error) });
    }
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setOver(false);
    take(event.dataTransfer.files?.[0]);
  }

  return (
    <MotionConfig reducedMotion="user">
      <div className="mt-16 grid gap-12 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)] lg:gap-16">
        <motion.section
          initial={{ opacity: 0, y: 24 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.8, delay: 0.2, ease: [0.16, 1, 0.3, 1] }}
        >
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
              <div className="flex flex-col items-start gap-5 p-8 sm:p-14">
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
                {/* The visitor's own file, drawn before it is sent anywhere. */}
                <img src={preview} alt="" className="max-h-[30rem] w-full object-cover" />
                <div className="scrim pointer-events-none absolute inset-0" />
                <div className="absolute inset-x-0 bottom-0 flex flex-wrap items-end justify-between gap-3 p-5">
                  <p className="max-w-[30ch] break-all font-mono text-[11px] text-text">
                    {file?.name} <span className="text-text-muted">{fileSize(file)}</span>
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
              {t("privacy", { host: verifierHost() })}
            </p>
          </div>
        </motion.section>

        <motion.div
          ref={card}
          data-answer-card
          initial={{ opacity: 0, y: 24 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.8, delay: 0.28, ease: [0.16, 1, 0.3, 1] }}
          className="scroll-mt-24 lg:sticky lg:top-28 lg:self-start"
        >
          <AnswerCard stage={stage} />
        </motion.div>
      </div>
    </MotionConfig>
  );
}

/** A file size a person can read: a 46 KB screenshot must not print as 0.0 MB. */
function fileSize(file: File | null): string {
  if (file === null) {
    return "";
  }
  return file.size < 1_000_000 ? `${Math.round(file.size / 1_000)} KB` : `${(file.size / 1_000_000).toFixed(1)} MB`;
}
