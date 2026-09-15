"use client";

import { AnimatePresence, motion } from "framer-motion";
import { useTranslations } from "next-intl";
import { useRef, useState, type DragEvent } from "react";
import type { Hex } from "viem";
import { readAnswer, percent, verifyProblem, type Answer, type Problem } from "@/components/verify/answer";
import { checkImage, type RefusalCode } from "@/lib/upload/checkImage";
import { Link } from "@/lib/i18n/routing";
import { shortHex } from "@/lib/chain/client";
import { verify } from "@/lib/verifier/client";

type State =
  | { kind: "idle" }
  | { kind: "checking"; name: string }
  | { kind: "answer"; answer: Answer; name: string }
  | { kind: "problem"; problem: Problem };

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
    try {
      setState({ kind: "answer", answer: readAnswer(await verify({ file })), name: file.name });
    } catch (error) {
      setState({ kind: "problem", problem: verifyProblem(error) });
    }
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
              <p className="flex items-center gap-3 font-mono text-[12px] uppercase tracking-[0.16em] text-accent">
                <span className="inline-block h-2 w-2 animate-pulse bg-accent" />
                {t("checking")}
              </p>
            ) : state.kind === "problem" ? (
              <div>
                <p className="max-w-[46ch] text-sm leading-relaxed text-failed">{t(sentenceFor(state.problem))}</p>
                {state.problem.reason === undefined ? null : (
                  <p className="mt-2 max-w-[46ch] break-words font-mono text-[11px] leading-relaxed text-text-faint">
                    {state.problem.reason}
                  </p>
                )}
              </div>
            ) : (
              <Verdict answer={state.answer} name={state.name} passportId={passportId} />
            )}
          </motion.div>
        </AnimatePresence>
      </div>
    </section>
  );
}

/** The two refusals this panel has its own sentence for, in the passport.check namespace. */
const REFUSALS: Record<RefusalCode, string> = {
  "too-large": "tooLarge",
  "not-an-image": "notAnImage",
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
 * Which sentence a problem takes. The two the browser catches have their own
 * words; anything the verifier raises keeps the general line with the service's
 * own message under it, since this panel has no advice for those.
 */
export function sentenceFor(problem: Problem): string {
  return Object.values(REFUSALS).includes(problem.key) ? problem.key : "failed";
}

function Verdict({ answer, name, passportId }: { answer: Answer; name: string; passportId: Hex }) {
  const t = useTranslations("passport.check");
  const v = useTranslations("verify");

  if (answer.kind === "miss") {
    return (
      <div>
        <p className="font-display text-[clamp(1.3rem,2.4vw,1.8rem)] font-semibold leading-[1.05] tracking-[-0.03em] text-failed">
          {t("none")}
        </p>
        <p className="mt-3 break-all font-mono text-[11px] text-text-faint">{name}</p>
      </div>
    );
  }

  const same = answer.id.toLowerCase() === passportId.toLowerCase();

  return (
    <div>
      <p
        className={`font-display text-[clamp(1.3rem,2.4vw,1.8rem)] font-semibold leading-[1.05] tracking-[-0.03em] ${same ? "text-verified" : "text-failed"}`}
      >
        {same ? (answer.kind === "exact" ? t("sameExact") : t("same")) : t("different")}
      </p>

      {/* Two columns of readings need about 150 px each before a value starts
          breaking up. Under 420 px they get the whole width, one under the
          other. */}
      <dl className="mt-5 grid grid-cols-1 gap-x-6 gap-y-4 min-[420px]:grid-cols-2">
        <Small label={v("confidence")} value={`${percent(answer.confidence)}%`} />
        <Small label={v("variant")} value={v(`orientation.${answer.variant}`)} />
        <Small label={v("phashDistance")} value={v("bits", { count: answer.phashDistance, of: 64 })} />
        <Small label={v("blockhashDistance")} value={v("bits", { count: answer.blockhashDistance, of: 256 })} />
      </dl>

      {same ? null : (
        <Link
          href={`/passport/${answer.id}`}
          className="mt-5 inline-block break-all font-mono text-[12px] text-text-muted underline decoration-line underline-offset-4 transition-colors duration-200 hover:text-accent"
        >
          {shortHex(answer.id, 10, 8)}
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
