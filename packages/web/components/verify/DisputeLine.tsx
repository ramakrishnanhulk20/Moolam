"use client";

import { useTranslations } from "next-intl";
import type { MatchDispute } from "@/lib/verifier/client";

/**
 * Whether anybody has challenged the record this picture matched.
 *
 * It belongs next to the holder's statement rather than three screens away.
 * The statement is the holder's word about a record, so a record under
 * challenge puts that word in question too, and the docs tell a reader to take
 * the two together. This is that sentence, in the registry's own four words.
 *
 * A service that could not find out prints nothing: "we cannot tell" is not a
 * clean record, and writing it here beside a clean one would read like it was.
 * An older service that carries no such field prints nothing either.
 */
export function DisputeLine({
  dispute,
  className = "",
}: {
  dispute?: MatchDispute;
  className?: string;
}) {
  const t = useTranslations("verify.dispute");

  if (dispute === undefined || dispute.source === "unavailable") {
    return null;
  }

  const { status } = dispute;
  // A challenge that stands, or one that was upheld, is the reader's problem to
  // know about, so it takes the cold status colour. The accent is decoration and
  // is never used to raise an alarm.
  const tone =
    status === "open" || status === "upheld"
      ? "text-failed"
      : status === "rejected"
        ? "text-text-muted"
        : "text-text-faint";

  return (
    <p data-dispute-line className={`max-w-[52ch] text-xs leading-relaxed ${tone} ${className}`}>
      {t(status)}
    </p>
  );
}
