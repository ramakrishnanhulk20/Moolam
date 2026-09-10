"use client";

import { MotionConfig, motion } from "framer-motion";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { useHeadingLeading } from "@/components/studio/leading";
import { verify } from "@/lib/verifier/client";
import { AnswerCard, type Stage } from "./AnswerCard";
import { chosenProblem, readAnswer, verifyProblem } from "./answer";
import { matchedPassport } from "./lookup";

const ACCEPT = "image/jpeg,image/png,image/webp";

/**
 * Drop any copy of any image and the running verifier says which passport it
 * belongs to.
 *
 * The file goes straight from this browser to the verify service, so a 20 MB
 * upload never passes through the app's own server and the page works the same
 * on a serverless host as it does here.
 */
export function VerifyScreen() {
  const t = useTranslations("verify");
  const leading = useHeadingLeading("leading-[0.86]", "leading-[1.12]");
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [over, setOver] = useState(false);
  const [stage, setStage] = useState<Stage>({ kind: "idle" });
  const busy = stage.kind === "checking";

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
    setStage({ kind: "idle" });
  }

  async function check() {
    if (file === null) {
      setStage({ kind: "problem", problem: { key: "noFile" } });
      return;
    }

    setStage({ kind: "checking", name: file.name });

    try {
      const answer = readAnswer(await verify({ file }));
      // The service answers with an id and nothing else, so the passport behind
      // it is read on the server while the card is still turning.
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
      <div className="relative mx-auto w-full max-w-[1400px] px-5 py-16 sm:px-8 sm:py-24">
        <span
          aria-hidden
          className="pointer-events-none absolute right-5 top-20 hidden select-none font-mono text-[11px] uppercase tracking-[0.4em] text-text-faint lg:block"
          style={{ writingMode: "vertical-rl" }}
        >
          {t("rail")}
        </span>

        <header className="relative max-w-[54ch]">
          <motion.p
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
            className="flex items-center gap-3 font-mono text-[11px] uppercase tracking-[0.28em] text-accent"
          >
            <span className="motif h-[10px] w-[10px]" />
            {t("kicker")}
          </motion.p>

          <motion.h1
            initial={{ opacity: 0, y: 28 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.8, delay: 0.06, ease: [0.16, 1, 0.3, 1] }}
            className={`mt-6 max-w-[13ch] font-display text-[clamp(2.6rem,8.5vw,6.5rem)] font-semibold uppercase tracking-[-0.035em] ${leading}`}
          >
            {t("title")}
          </motion.h1>

          <motion.p
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.8, delay: 0.14, ease: [0.16, 1, 0.3, 1] }}
            className="mt-7 max-w-[52ch] text-base leading-relaxed text-text-muted sm:text-lg"
          >
            {t("lede")}
          </motion.p>
        </header>

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
                    className="rounded-[8px] border border-line px-5 py-3 text-[11px] uppercase tracking-[0.2em] text-text-muted transition-colors duration-200 hover:border-accent hover:text-accent"
                  >
                    {t("choose")}
                  </button>
                  <p className="max-w-[46ch] text-xs leading-relaxed text-text-faint">{t("hint")}</p>
                </div>
              ) : (
                <div className="relative">
                  {/* The visitor's own file, drawn before it is sent anywhere. */}
                  <img src={preview} alt="" className="max-h-[30rem] w-full object-cover" />
                  <div className="scrim pointer-events-none absolute inset-0" />
                  <div className="absolute inset-x-0 bottom-0 flex flex-wrap items-end justify-between gap-3 p-5">
                    <p className="max-w-[30ch] break-all font-mono text-[11px] text-text">
                      {file?.name} <span className="text-text-faint">{fileSize(file)}</span>
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

            <div className="mt-8 flex flex-wrap items-center gap-4">
              <button
                type="button"
                onClick={() => void check()}
                disabled={busy || file === null}
                className="rounded-[8px] bg-accent px-7 py-4 text-sm font-semibold uppercase tracking-[0.14em] text-accent-ink transition-transform duration-200 hover:-translate-y-0.5 disabled:translate-y-0 disabled:opacity-50"
              >
                {t("submit")}
              </button>
              <p className="max-w-[34ch] text-xs leading-relaxed text-text-faint">{t("privacy")}</p>
            </div>
          </motion.section>

          <motion.div
            initial={{ opacity: 0, y: 24 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.8, delay: 0.28, ease: [0.16, 1, 0.3, 1] }}
            className="lg:sticky lg:top-28 lg:self-start"
          >
            <AnswerCard stage={stage} />
          </motion.div>
        </div>
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
