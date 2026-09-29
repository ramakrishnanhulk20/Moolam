"use client";

import { useFormatter, useTranslations } from "next-intl";
import type { Consent } from "@/lib/chain/consent";
import { NOTHING_STATED, plainStatement } from "@/lib/chain/consent";
import type { MatchConsent } from "@/lib/verifier/client";
import { UseBlock } from "./Marks";
import { SUMMARY_TONES } from "./tones";

/**
 * The stamp a verify answer carries under a match.
 *
 * Somebody has just proved a picture is registered. The next thing they need is
 * whether they may use it, and this is the whole of that answer: what the
 * holder said, and the day they said it, read from the register rather than
 * from the file they uploaded.
 *
 * The three answers are kept apart on purpose. A holder who said nothing is not
 * a holder who allowed everything, and a read that failed is neither: it is the
 * service saying it could not find out, which is never permission.
 */
export function ConsentStamp({ consent, className = "" }: { consent?: MatchConsent; className?: string }) {
  const t = useTranslations("verify.consent");
  const format = useFormatter();

  // An answer from a service that predates the register carries no field at
  // all. Nothing is drawn rather than a sentence nobody can stand behind.
  if (consent === undefined) {
    return null;
  }

  if (consent.source === "unavailable") {
    return (
      <Frame tone="border-line" label={t("label")} corner={t("unreadable")} className={className}>
        <p className="mt-3 max-w-[24ch] font-display text-[clamp(1.1rem,2.4vw,1.6rem)] font-semibold leading-[1.05] tracking-[-0.03em] text-text-muted">
          {t("unavailable")}
        </p>
        <p className="mt-3 max-w-[56ch] text-base leading-relaxed text-text-faint">{t("unavailableNote")}</p>
      </Frame>
    );
  }

  if (!consent.stated) {
    return (
      <Frame tone={SUMMARY_TONES.none.edge} label={t("label")} corner={t("never")} className={className}>
        <p className="mt-3 flex items-center gap-4">
          <UseBlock consent={NOTHING_STATED} size="h-3 w-3" className={SUMMARY_TONES.none.ink} />
          <span className="max-w-[24ch] font-display text-[clamp(1.1rem,2.4vw,1.6rem)] font-semibold leading-[1.05] tracking-[-0.03em]">
            {t("nothing")}
          </span>
        </p>
        <p className="mt-3 max-w-[56ch] text-base leading-relaxed text-text-faint">{t("silence")}</p>
      </Frame>
    );
  }

  const stated: Consent = {
    aiTraining: consent.aiTraining,
    aiGenerativeTraining: consent.aiGenerativeTraining,
    aiInference: consent.aiInference,
    dataMining: consent.dataMining,
  };
  const summary = plainStatement(stated);
  const tone = SUMMARY_TONES[summary];
  const conditions = consent.constraintInfo !== undefined && consent.constraintInfo.length > 0;

  return (
    <Frame
      tone={tone.edge}
      label={t("label")}
      corner={format.dateTime(new Date(consent.at * 1000), { dateStyle: "medium" })}
      className={className}
    >
      <p className="mt-3 flex items-center gap-4">
        <UseBlock consent={stated} size="h-3 w-3" className={tone.ink} />
        <span className="max-w-[24ch] font-display text-[clamp(1.1rem,2.4vw,1.6rem)] font-semibold leading-[1.05] tracking-[-0.03em]">
          {t(`tail.${summary}`)}
        </span>
      </p>

      <p className="mt-3 max-w-[56ch] break-words text-base leading-relaxed text-text-faint">
        {conditions ? consent.constraintInfo : t("source")}
      </p>
    </Frame>
  );
}

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
    <div data-consent-stamp className={`border-s-2 ps-5 ${tone} ${className}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
        <p className="font-mono text-[10px] uppercase tracking-[0.24em] text-text-faint">{label}</p>
        <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-text-faint">{corner}</p>
      </div>
      {children}
    </div>
  );
}
