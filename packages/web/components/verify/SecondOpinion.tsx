"use client";

import { useFormatter, useTranslations } from "next-intl";
import type { Hex } from "viem";
import { Link } from "@/lib/i18n/routing";
import type { MatchRecheck } from "@/lib/verifier/client";
import { RecheckRequest } from "@/components/passport/RecheckRequest";
import type { VerdictStanding } from "./lookup";

/**
 * Whether this block draws anything at all.
 *
 * The card asks before it lays the answer out, because the one thing that must
 * still be offered when this block is silent is the button under it.
 */
export function hasSecondOpinion(
  recheck?: MatchRecheck,
): recheck is Exclude<MatchRecheck, { source: "unavailable" }> {
  return recheck !== undefined && recheck.source !== "unavailable";
}

/**
 * Who else has checked this picture, in one line.
 *
 * The holder's own statement sits above this, and it is the holder's word. This
 * is the part nobody has to take on trust: a Chainlink CRE workflow fetched the
 * picture from the address in its passport, recomputed the fingerprint in the
 * sandbox and wrote the verdict to Monad. The answer already carries that fact,
 * so it costs the reader no extra call.
 *
 * Four states and no fifth. A verdict that did not match is said plainly, in
 * the status colour rather than the accent, because it is the one answer a
 * reader must not skim past. A service that could not tell, and an older
 * service that carries no such field, print nothing at all: silence is the only
 * honest answer to a question nobody asked the chain.
 *
 * The verdict line says what the workflow did; the sentence after it says who
 * ran it, by the trust mark's rule: Chainlink's network, which lights the mark,
 * or a test run in its simulator, which never does. A standing the server
 * could not read adds no sentence, so the line claims neither.
 *
 * The button to ask for a re-check sits only under "never". The runner closes
 * any request for a picture that already carries a verdict, so under one a
 * press could only come back refused.
 */
export function SecondOpinion({
  recheck,
  id,
  standing,
  className = "",
}: {
  recheck?: MatchRecheck;
  id: Hex;
  /** Where the newest verdict came from, read beside the matched passport. */
  standing?: VerdictStanding;
  className?: string;
}) {
  const t = useTranslations("verify.recheck");
  const format = useFormatter();

  if (!hasSecondOpinion(recheck)) {
    return null;
  }

  // The service never sends a count without the verdict behind it, so the one
  // shape with no verdict is the one where nothing has re-checked this picture.
  if (!("latest" in recheck)) {
    return (
      <Frame tone="border-line" label={t("label")} corner={t("never")} className={className}>
        <p className="mt-3 max-w-[30ch] font-display text-[clamp(1.1rem,2.4vw,1.6rem)] font-semibold leading-[1.05] tracking-[-0.03em] text-text-muted">
          {t("none")}
        </p>
        <p className="mt-3 max-w-[60ch] text-base leading-relaxed text-text-faint">{t("noneNote")}</p>
        <RecheckRequest passportId={id} className="mt-5" />
      </Frame>
    );
  }

  const { latest } = recheck;
  const at = format.dateTime(new Date(latest.at * 1000), { dateStyle: "medium" });

  return (
    <Frame
      tone={latest.matched ? "border-verified/50" : "border-failed/60"}
      label={t("label")}
      corner={t("count", { count: recheck.attestations })}
      className={className}
    >
      <p
        className={`mt-3 max-w-[60ch] text-base leading-relaxed ${latest.matched ? "text-text" : "text-failed"}`}
      >
        {latest.matched
          ? t("matched", { at, count: latest.distance })
          : t("mismatched", { at, count: latest.distance })}
      </p>
      {standing === "network" || standing === "testRun" ? (
        <p data-verdict-standing={standing} className="mt-2 max-w-[60ch] text-base leading-relaxed text-text-muted">
          {t(standing)}
        </p>
      ) : null}

      {/* Straight to the re-check block on the passport page, which carries the
          two fingerprints drawn bit by bit and the transaction each verdict was
          written in. The id is on that section in components/passport/Attestations.tsx. */}
      <Link
        href={`/passport/${id}#second-opinion`}
        className="mt-3 inline-block text-xs uppercase tracking-[0.16em] text-text-muted underline decoration-line underline-offset-4 transition-colors duration-200 hover:text-accent hover:decoration-accent"
      >
        {t("link")}
      </Link>
    </Frame>
  );
}

/** The same rule and corner the statement stamp beside it wears, so the two read as one block. */
function Frame({
  tone,
  label,
  corner,
  className,
  children,
}: {
  tone: string;
  label: string;
  corner: string;
  className: string;
  children: React.ReactNode;
}) {
  return (
    <div data-second-opinion className={`border-s-2 ps-5 ${tone} ${className}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
        <p className="font-mono text-[10px] uppercase tracking-[0.24em] text-text-faint">{label}</p>
        <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-text-faint">{corner}</p>
      </div>
      {children}
    </div>
  );
}
