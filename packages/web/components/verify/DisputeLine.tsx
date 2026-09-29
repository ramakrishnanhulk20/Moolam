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
  // know about, so it takes the dispute colour. Red is kept for things that
  // failed and the accent is decoration, so neither says "challenged".
  const tone =
    status === "open" || status === "upheld"
      ? "text-disputed"
      : status === "rejected"
        ? "text-text-muted"
        : "text-text-faint";

  return (
    <p data-dispute-line className={`max-w-[60ch] text-base leading-relaxed ${tone} ${className}`}>
      {t(status)}
    </p>
  );
}
