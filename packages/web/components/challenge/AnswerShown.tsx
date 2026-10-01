import { useFormatter, useTranslations } from "next-intl";
import { MONAD_EXPLORER, gatewayUrl, shortHex } from "@/lib/chain/client";
import type { HolderWords } from "@/lib/disputes/answer";

/** What the page knows about the holder's answer to the dispute it is drawn beside. */
export type AnswerStanding =
  | { kind: "answered"; words: HolderWords }
  | { kind: "waiting"; until: number }
  | { kind: "missed" }
  | { kind: "unread" }
  | { kind: "none" };

/**
 * The holder's side of a challenge, for everybody who opens the passport (L27).
 *
 * The words are the holder's own, signed by their wallet, and drawn as text:
 * nothing in them becomes a link or markup, and their line breaks are kept, so
 * paragraphs read as paragraphs. Only an answer whose fields match this very
 * dispute ever reaches here; holderWords in lib/disputes/answer.ts decides that.
 */
export function AnswerShown({ standing }: { standing: AnswerStanding }) {
  const t = useTranslations("challenge.answer.shown");
  const format = useFormatter();

  if (standing.kind === "none") {
    return null;
  }

  return (
    <div data-answer-shown={standing.kind} className="min-w-0">
      <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-text-faint">{t("label")}</p>
      {standing.kind === "answered" ? (
        <figure className="mt-2.5">
          <blockquote
            data-holder-words
            className="whitespace-pre-line break-words text-base leading-relaxed text-text"
          >
            {standing.words.text}
          </blockquote>
          <figcaption className="tap-row mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 font-mono text-[11px] text-text-faint">
            <a
              href={`${MONAD_EXPLORER}/address/${standing.words.holder}`}
              target="_blank"
              rel="noreferrer"
              className="transition-colors duration-200 hover:text-accent"
            >
              {t("by", { holder: shortHex(standing.words.holder) })}
            </a>
            <a
              href={gatewayUrl(standing.words.answerURI)}
              target="_blank"
              rel="noreferrer"
              data-answer-pinned
              className="underline decoration-line underline-offset-4 transition-colors duration-200 hover:text-accent hover:decoration-accent"
            >
              {shortHex(standing.words.answerURI, 12, 6)}
            </a>
          </figcaption>
        </figure>
      ) : (
        <p className="mt-2.5 max-w-[46ch] text-base leading-relaxed text-text-muted">
          {standing.kind === "waiting"
            ? t("none", { date: format.dateTime(new Date(standing.until * 1000), { dateStyle: "medium" }) })
            : standing.kind === "missed"
              ? t("missed")
              : t("unread")}
        </p>
      )}
    </div>
  );
}
