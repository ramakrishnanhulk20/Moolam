"use client";

import { useState } from "react";
import { ConsentChoice } from "@/components/consent/ConsentChoice";
import { callText, consentForChoice, type ConsentDraft } from "@/components/consent/draft";

/**
 * One drawing of the creator's control, with the transaction it would send
 * printed under it.
 *
 * The bench signs nothing. Printing the call is how Ram can see that the three
 * plain choices really do become four numbers and a string, and that the
 * conditions text goes out exactly as it was typed.
 */
export function ChoicePanel({
  variant,
  label,
  passportId,
}: {
  variant: "plates" | "rule";
  label: string;
  passportId: string;
}) {
  const [draft, setDraft] = useState<ConsentDraft>({ consent: consentForChoice("closed"), constraintInfo: "" });

  return (
    <div className="min-w-0">
      <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-text-faint">{label}</p>

      <ConsentChoice variant={variant} onChange={setDraft} className="mt-6" />

      <div className="mt-10 border-t border-line pt-6">
        <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-text-faint">The call this would make</p>
        <pre className="mt-3 overflow-x-auto rounded-[8px] border border-line bg-bg-sunken p-4 font-mono text-[11px] leading-relaxed text-text-muted">
          {callText(passportId, draft)}
        </pre>
        <p className="mt-3 max-w-[52ch] text-xs leading-relaxed text-text-faint">
          Nothing leaves this bench. On the real screen this is the transaction the holder signs, and the register
          refuses it from anyone who does not hold the passport.
        </p>
      </div>
    </div>
  );
}
