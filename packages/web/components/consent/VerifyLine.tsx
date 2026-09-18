import type { ConsentReading } from "@/lib/chain/consent";
import { NOTHING_STATED, plainStatement } from "@/lib/chain/consent";
import { UseBlock, UseMark } from "./Marks";
import { SUMMARY_TAILS, SUMMARY_TONES, dayText } from "./words";

/**
 * The line a verify answer carries under a match.
 *
 * Someone has just proved a picture is registered. The next thing they need is
 * whether they may use it, and this is the whole of that answer in one
 * sentence: what the holder said, and the day they said it. A picture with no
 * statement gets a sentence too, because silence has to be reported rather than
 * left as an empty space a reader fills in with yes.
 */
export function VerifyLine({
  variant,
  reading,
  className = "",
}: {
  variant: "sentence" | "stamp";
  reading: ConsentReading;
  className?: string;
}) {
  const entry = reading.entry;
  const consent = entry?.consent ?? NOTHING_STATED;
  const summary = reading.stated ? plainStatement(consent) : "none";
  const tone = SUMMARY_TONES[summary];
  const conditions = entry !== null && entry.constraintInfo.length > 0 ? entry.constraintInfo : null;

  if (variant === "sentence") {
    return (
      <div className={className}>
        <p className="flex items-start gap-3 text-base leading-relaxed">
          <span className={`mt-1.5 shrink-0 ${tone.ink}`}>
            <UseMark state={consent.aiTraining} className="h-3 w-3" />
          </span>
          <span className="max-w-[60ch] text-text-muted">
            {entry === null ? (
              "Its holder has not stated how AI may use this picture."
            ) : (
              <>
                Its holder said on{" "}
                <span className="text-text">{dayText(Number(entry.at))}</span>:{" "}
                <span className={tone.ink}>{SUMMARY_TAILS[summary]}</span>.
              </>
            )}
          </span>
        </p>

        <p className="mt-2 max-w-[60ch] ps-6 text-xs leading-relaxed text-text-faint">
          {conditions === null ? "Nothing stated is not permission." : conditions}
        </p>
      </div>
    );
  }

  return (
    <div className={`border-s-2 ps-5 ${tone.edge} ${className}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
        <p className="font-mono text-[10px] uppercase tracking-[0.24em] text-text-faint">The holder&apos;s statement</p>
        <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-text-faint">
          {entry === null ? "never written" : dayText(Number(entry.at))}
        </p>
      </div>

      <p className="mt-3 flex items-center gap-4">
        <UseBlock consent={consent} size="h-3 w-3" className={tone.ink} />
        <span className="max-w-[24ch] font-display text-[clamp(1.1rem,2.4vw,1.6rem)] font-semibold leading-[1.05] tracking-[-0.03em]">
          {entry === null ? "Nothing stated" : SUMMARY_TAILS[summary]}
        </span>
      </p>

      <p className="mt-3 max-w-[56ch] text-xs leading-relaxed text-text-faint">
        {conditions === null ? "Read from the register on Monad, not from the file." : conditions}
      </p>
    </div>
  );
}
