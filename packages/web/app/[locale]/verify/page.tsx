"use client";

import { AnimatePresence, motion } from "framer-motion";
import { useTranslations } from "next-intl";
import { useRef, useState } from "react";
import { Link } from "@/lib/i18n/routing";

interface VerifyMatch {
  id: `0x${string}`;
  phashDistance: number;
  blockhashDistance: number;
  variant: string;
  score: number;
}

interface VerifyAnswer {
  result: {
    exact: `0x${string}` | null;
    best: VerifyMatch | null;
    confidence: number;
  };
  manifest: { present: boolean };
}

type State =
  | { kind: "idle" }
  | { kind: "pending" }
  | { kind: "error"; message: string }
  | { kind: "done"; answer: VerifyAnswer };

/**
 * Upload any copy of an image and the verifier says which passport it belongs
 * to. The browser never talks to the verifier itself: the upload goes through
 * this app's own route, which is what keeps the service's address private.
 */
export default function VerifyPage() {
  const t = useTranslations("verify");
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [state, setState] = useState<State>({ kind: "idle" });

  async function submit() {
    if (file === null) {
      setState({ kind: "error", message: t("noFile") });
      return;
    }

    setState({ kind: "pending" });
    const body = new FormData();
    body.append("file", file, file.name);

    try {
      const response = await fetch("/api/verify", { method: "POST", body });
      const payload = (await response.json()) as VerifyAnswer & { error?: string };

      if (!response.ok) {
        setState({
          kind: "error",
          message: payload.error === "verifier-unreachable" ? t("offline") : t("error", { reason: payload.error ?? String(response.status) }),
        });
        return;
      }

      setState({ kind: "done", answer: payload });
    } catch (error) {
      setState({ kind: "error", message: t("error", { reason: error instanceof Error ? error.message : String(error) }) });
    }
  }

  return (
    <div className="mx-auto w-full max-w-[1400px] px-5 py-16 sm:px-8 sm:py-24">
      <div className="grid gap-16 lg:grid-cols-[1fr_1.1fr]">
        <motion.header
          initial={{ opacity: 0, y: 24 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
          className="max-w-[46ch]"
        >
          <h1 className="font-display text-[clamp(2.5rem,7vw,5.5rem)] uppercase leading-[0.9] tracking-[-0.01em]">
            {t("title")}
          </h1>
          <p className="mt-6 text-base leading-relaxed text-text-muted">{t("lede")}</p>

          <div className="mt-10 space-y-4">
            <input
              ref={input}
              type="file"
              accept="image/jpeg,image/png"
              className="hidden"
              onChange={(event) => {
                setFile(event.target.files?.[0] ?? null);
                setState({ kind: "idle" });
              }}
            />
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={() => input.current?.click()}
                className="rounded-[8px] border border-line px-5 py-3 text-xs uppercase tracking-[0.18em] text-text-muted transition-colors duration-200 hover:border-accent hover:text-accent"
              >
                {t("choose")}
              </button>
              <button
                type="button"
                onClick={submit}
                disabled={state.kind === "pending"}
                className="rounded-[8px] bg-accent px-6 py-3 text-xs font-semibold uppercase tracking-[0.18em] text-accent-ink transition-transform duration-200 hover:-translate-y-0.5 disabled:translate-y-0 disabled:opacity-60"
              >
                {t("submit")}
              </button>
            </div>
            {file === null ? (
              <p className="text-xs text-text-faint">{t("hint")}</p>
            ) : (
              <p className="break-all font-mono text-xs text-text-muted">{t("chosen", { name: file.name })}</p>
            )}
          </div>
        </motion.header>

        <section className="min-h-[18rem] border border-line bg-bg-raised p-6 sm:p-10">
          <AnimatePresence mode="wait">
            {state.kind === "idle" ? null : state.kind === "pending" ? (
              <motion.p
                key="pending"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="text-sm text-text-muted"
              >
                {t("pending")}
              </motion.p>
            ) : state.kind === "error" ? (
              <motion.p
                key="error"
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                className="max-w-[46ch] text-sm text-failed"
              >
                {state.message}
              </motion.p>
            ) : (
              <Result key="done" answer={state.answer} />
            )}
          </AnimatePresence>
        </section>
      </div>
    </div>
  );
}

function Result({ answer }: { answer: VerifyAnswer }) {
  const t = useTranslations("verify");
  const { exact, best, confidence } = answer.result;
  const matchedId = exact ?? best?.id ?? null;

  if (matchedId === null) {
    return (
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0 }}
        className="max-w-[46ch]"
      >
        <p className="font-display text-3xl uppercase tracking-[0.02em]">{t("none")}</p>
        <p className="mt-4 text-sm text-text-muted">{t("noneHint")}</p>
        <p className="mt-6 font-mono text-xs text-text-faint">
          {answer.manifest.present ? t("manifestPresent") : t("manifestMissing")}
        </p>
      </motion.div>
    );
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
    >
      <p className="font-mono text-[11px] uppercase tracking-[0.24em] text-verified">
        {exact === null ? t("matched") : t("exact")}
      </p>
      <p className="mt-4 font-display text-[clamp(3rem,8vw,5.5rem)] leading-[0.85] text-accent">
        {Math.round(confidence * 100)}
        <span className="align-top text-[0.35em]">%</span>
      </p>
      <p className="mt-1 font-mono text-[11px] uppercase tracking-[0.18em] text-text-faint">{t("confidence")}</p>

      <dl className="mt-8 grid grid-cols-2 gap-6 border-t border-line pt-6 sm:grid-cols-3">
        <div>
          <dt className="font-mono text-[11px] uppercase tracking-[0.18em] text-text-faint">{t("phashDistance")}</dt>
          <dd className="mt-1 font-mono text-sm">{best === null ? 0 : best.phashDistance}</dd>
        </div>
        <div>
          <dt className="font-mono text-[11px] uppercase tracking-[0.18em] text-text-faint">
            {t("blockhashDistance")}
          </dt>
          <dd className="mt-1 font-mono text-sm">{best === null ? 0 : best.blockhashDistance}</dd>
        </div>
        <div>
          <dt className="font-mono text-[11px] uppercase tracking-[0.18em] text-text-faint">{t("variant")}</dt>
          <dd className="mt-1 font-mono text-sm">{best === null ? "identity" : best.variant}</dd>
        </div>
      </dl>

      <p className="mt-8 font-mono text-xs text-text-faint">
        {answer.manifest.present ? t("manifestPresent") : t("manifestMissing")}
      </p>

      <Link
        href={`/passport/${matchedId}`}
        className="mt-8 inline-block rounded-[8px] border border-accent px-5 py-3 text-xs uppercase tracking-[0.18em] text-accent transition-transform duration-200 hover:-translate-y-0.5"
      >
        {t("openPassport")}
      </Link>
      <p className="mt-4 break-all font-mono text-xs text-text-faint">{matchedId}</p>
    </motion.div>
  );
}
