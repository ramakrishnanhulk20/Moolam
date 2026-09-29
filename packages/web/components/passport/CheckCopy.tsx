"use client";

import { AnimatePresence, motion } from "framer-motion";
import { useTranslations } from "next-intl";
import { useRef, useState, type DragEvent } from "react";
import type { Hex } from "viem";
import { readAnswer, percent, verifyProblem, type Answer, type Problem } from "@/components/verify/answer";
import type { MatchedPassport } from "@/components/verify/lookup";
import { StaleIndex } from "@/components/verify/StaleIndex";
import { checkImage, type RefusalCode } from "@/lib/upload/checkImage";
import { Link } from "@/lib/i18n/routing";
import { shortHex } from "@/lib/chain/client";
import { verify } from "@/lib/verifier/client";
import { WarningMark } from "@/components/WarningMark";

type State =
  | { kind: "idle" }
  | { kind: "checking"; name: string }
  | { kind: "answer"; answer: Answer; name: string; other?: MatchedPassport | null }
  | { kind: "problem"; problem: Problem; file?: File };

/**
 * Drop a copy and find out whether it is this picture.
 *
 * The same verify run as the verify page, asked from the one place a reader is
 * already looking at the original. The answer is read against this passport's
 * id, so a copy that turns out to belong to a different record says so instead
 * of quietly showing a green tick.
 */
export function CheckCopy({ passportId }: { passportId: Hex }) {
  const t = useTranslations("passport.check");
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const [state, setState] = useState<State>({ kind: "idle" });

  async function check(file: File) {
    const refused = copyRefusal(file);
    if (refused !== null) {
      setState({ kind: "problem", problem: refused });
      return;
    }

    setState({ kind: "checking", name: file.name });
    let answer: Answer;
    try {
      answer = readAnswer(await verify({ file }));
    } catch (error) {
      // The file is kept, so Try again sends the same copy rather than asking for it twice.
      setState({ kind: "problem", problem: verifyProblem(error), file });
      return;
    }
    setState({ kind: "answer", answer, name: file.name });

    if (answer.kind === "miss" || answer.id.toLowerCase() === passportId.toLowerCase()) {
      return;
    }
    // A copy of another passport is named by that passport's title. The verdict
    // stands without it, so a lookup that fails leaves the link on its id.
    const { matchedPassport } = await import("@/components/verify/lookup");
    const other = await matchedPassport(answer.id).catch(() => null);
    // Only onto the answer it was asked for: a newer drop has moved on from it.
    setState((current) => (current.kind === "answer" && current.answer === answer ? { ...current, other } : current));
  }

  function againFor(file: File | undefined): (() => void) | undefined {
    return file === undefined ? undefined : () => void check(file);
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setOver(false);
    const file = event.dataTransfer.files?.[0];
    if (file !== undefined) {
      void check(file);
    }
  }

  return (
    <section
      onDragOver={(event) => {
        event.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop}
      className={`border p-6 transition-colors duration-200 sm:p-8 ${over ? "border-accent bg-accent-soft" : "border-line bg-bg-raised"}`}
    >
      <p className="flex items-center gap-3 font-mono text-[11px] uppercase tracking-[0.24em] text-accent">
        <span className="motif h-[9px] w-[9px]" />
        {t("kicker")}
      </p>
      <h2 className="mt-5 max-w-[20ch] font-display text-[clamp(1.4rem,2.6vw,2rem)] font-semibold leading-[1.05] tracking-[-0.03em]">
        {t("heading")}
      </h2>
      <p className="mt-4 max-w-[46ch] text-sm leading-relaxed text-text-muted">{t("body")}</p>

      <input
        ref={input}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file !== undefined) {
            void check(file);
          }
        }}
      />

      <button
        type="button"
        onClick={() => input.current?.click()}
        disabled={state.kind === "checking"}
        className="mt-7 rounded-[8px] border border-line px-5 py-3 text-[11px] uppercase tracking-[0.2em] text-text-muted transition-colors duration-200 hover:border-accent hover:text-accent disabled:opacity-60"
      >
        {t("choose")}
      </button>

      <div className="mt-7 min-h-[7rem] border-t border-line pt-6">
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={state.kind}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
          >
            {state.kind === "idle" ? (
              <p className="max-w-[44ch] text-sm leading-relaxed text-text-faint">{t("hint")}</p>
            ) : state.kind === "checking" ? (
              <p role="status" className="flex items-center gap-3 font-mono text-[12px] uppercase tracking-[0.16em] text-pending">
                <span aria-hidden className="inline-block h-2 w-2 bg-pending motion-safe:animate-pulse" />
                {t("checking")}
              </p>
            ) : state.kind === "problem" ? (
              <ProblemLine problem={state.problem} again={againFor(state.file)} />
            ) : (
              <Verdict answer={state.answer} name={state.name} passportId={passportId} other={state.other} />
            )}
          </motion.div>
        </AnimatePresence>
      </div>
    </section>
  );
}

/** The refusals this panel has its own sentence for, in the passport.check namespace. */
const REFUSALS: Record<RefusalCode, string> = {
  "too-large": "tooLarge",
  "not-an-image": "notAnImage",
  empty: "empty",
};

/**
 * What this page says about a file it refuses on its own, or null when the file
 * is worth sending. The size and type test is the shared one in lib/upload, so a
 * text file or a 30 MB photo is answered here instead of travelling to the
 * verifier first. Each code gets the sentence that says what to do next, the
 * same way the verify page and the studio answer, so nobody is left reading a
 * MIME type to work out what went wrong.
 */
export function copyRefusal(file: File): Problem | null {
  const refusal = checkImage(file);
  return refusal === null ? null : { key: REFUSALS[refusal.code] };
}

/**
 * Which sentence a problem takes. The ones the browser catches have their own
 * words; anything the verifier raises gets the general line, whose next steps
 * are Try again and the Verify page, with the service's own message folded
 * under Details.
 */
export function sentenceFor(problem: Problem): string {
  return Object.values(REFUSALS).includes(problem.key) ? problem.key : "failed";
}

/**
 * A check that did not run: the sentence, the two ways on, and the service's own
 * words folded under Details for anyone reporting it. A file this panel refused
 * itself has nothing to try again, only a different file to choose.
 */
export function ProblemLine({ problem, again }: { problem: Problem; again?: () => void }) {
  const t = useTranslations("passport.check");
  const common = useTranslations("common");
  const back = useTranslations("notFound");
  const sentence = sentenceFor(problem);
  const serviceFailed = sentence === "failed";

  return (
    <div role="alert" data-check-failed={sentence}>
      <p className="flex max-w-[46ch] items-start gap-2.5 text-sm leading-relaxed text-failed">
        <WarningMark className="mt-[3px]" />
        {t(sentence)}
      </p>
      {serviceFailed ? (
        <div className="ms-[23px] mt-4 flex flex-wrap items-center gap-3">
          {again === undefined ? null : (
            <button
              type="button"
              onClick={again}
              className="rounded-[8px] border border-line-strong px-4 py-2 text-[11px] uppercase tracking-[0.18em] text-text transition-colors duration-200 hover:border-accent hover:text-accent"
            >
              {common("tryAgain")}
            </button>
          )}
          <Link
            href="/verify"
            className="rounded-[8px] border border-line px-4 py-2 font-mono text-[10px] uppercase tracking-[0.18em] text-text-muted transition-colors duration-200 hover:border-accent hover:text-accent"
          >
            {back("verify")}
          </Link>
        </div>
      ) : null}
      {problem.reason === undefined ? null : (
        <details className="group ms-[23px] mt-4 max-w-[46ch]">
          <summary className="tap cursor-pointer list-none font-mono text-[10px] uppercase tracking-[0.2em] text-text-faint transition-colors duration-200 hover:text-accent [&::-webkit-details-marker]:hidden">
            <span aria-hidden className="me-2 inline-block transition-transform duration-200 group-open:rotate-90">
              &rsaquo;
            </span>
            {common("details")}
          </summary>
          <p className="mt-2 break-words font-mono text-[11px] leading-relaxed text-text-faint">{problem.reason}</p>
        </details>
      )}
    </div>
  );
}

export function Verdict({
  answer,
  name,
  passportId,
  other,
}: {
  answer: Answer;
  name: string;
  passportId: Hex;
  /** The other passport's own record, once read. Undefined while it is asked, null when it could not be. */
  other?: MatchedPassport | null;
}) {
  const t = useTranslations("passport.check");
  const v = useTranslations("verify");

  if (answer.kind === "miss") {
    return (
      <div>
        <p className="flex items-start gap-3 font-display text-[clamp(1.3rem,2.4vw,1.8rem)] font-semibold leading-[1.05] tracking-[-0.03em] text-failed">
          <WarningMark className="mt-[0.3em]" />
          {t("none")}
        </p>
        <StaleIndex minutes={answer.staleMinutes} />
        <p className="mt-3 break-all font-mono text-[11px] text-text-faint">{name}</p>
      </div>
    );
  }

  const same = answer.id.toLowerCase() === passportId.toLowerCase();

  return (
    <div>
      <p
        className={`flex items-start gap-3 font-display text-[clamp(1.3rem,2.4vw,1.8rem)] font-semibold leading-[1.05] tracking-[-0.03em] ${same ? "text-verified" : "text-failed"}`}
      >
        {same ? null : <WarningMark className="mt-[0.3em]" />}
        {same ? (answer.kind === "exact" ? t("sameExact") : t("same")) : t("different")}
      </p>
      <StaleIndex minutes={answer.staleMinutes} />

      {/* Two columns of readings need about 150 px each before a value starts
          breaking up. Under 420 px they get the whole width, one under the
          other. */}
      <dl className="mt-5 grid grid-cols-1 gap-x-6 gap-y-4 min-[420px]:grid-cols-2">
        <Small label={v("confidence")} value={`${percent(answer.confidence)}%`} />
        {answer.pixelsUnread ? null : (
          <>
            <Small label={v("variant")} value={v(`orientation.${answer.variant}`)} />
            <Small label={v("phashDistance")} value={v("bits", { count: answer.phashDistance, of: 64 })} />
            <Small label={v("blockhashDistance")} value={v("bits", { count: answer.blockhashDistance, of: 256 })} />
          </>
        )}
      </dl>
      {answer.pixelsUnread ? (
        <p data-pixels-unread className="mt-4 max-w-[46ch] text-sm leading-relaxed text-text-muted">
          {v("pixelsUnread")}
        </p>
      ) : null}

      {same ? null : (
        <Link
          href={`/passport/${answer.id}`}
          data-open-other
          className="group mt-6 flex max-w-[46ch] flex-col gap-1.5 border-s-2 border-line ps-4 transition-colors duration-200 hover:border-accent"
        >
          <span className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.2em] text-text transition-colors duration-200 group-hover:text-accent">
            {t("openOther")}
            <span aria-hidden className="transition-transform duration-200 group-hover:translate-x-0.5 rtl:-scale-x-100">
              &rarr;
            </span>
          </span>
          {other?.title === undefined ? null : (
            <span className="truncate font-display text-lg font-semibold leading-tight tracking-[-0.02em]">
              {other.title}
            </span>
          )}
          <span className="break-all font-mono text-[11px] text-text-faint">{shortHex(answer.id, 10, 8)}</span>
        </Link>
      )}

      <p className="mt-4 break-all font-mono text-[11px] text-text-faint">{name}</p>
    </div>
  );
}

function Small({ label, value }: { label: string; value: string }) {
  // break-all is for a hex value with no break points in it. A reading that is
  // a sentence, "0 of 64 bits apart", has spaces to break at, and break-all cut
  // it mid word: "bits ap / art".
  const wrap = /\s/.test(value) ? "break-words" : "break-all";

  return (
    <div className="min-w-0">
      <dt className="font-mono text-[10px] uppercase tracking-[0.2em] text-text-faint">{label}</dt>
      <dd className={`mt-1 font-mono text-sm ${wrap}`}>{value}</dd>
    </div>
  );
}
