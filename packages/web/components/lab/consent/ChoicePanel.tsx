"use client";

import { useState } from "react";
import { ConsentChoice } from "@/components/consent/ConsentChoice";
import { consentForChoice, draftProblem, type ConsentDraft } from "@/components/consent/draft";
import { UseRows } from "@/components/consent/UseRows";

/**
 * The holder's control on the bench, with the statement it is building drawn
 * under it as the four rows a reader would end up seeing.
 *
 * The bench signs nothing. The rows are how Ram can see that three plain
 * choices really do become four answers, and that the conditions text only
 * appears while a choice needs one.
 */
export function ChoicePanel() {
  const [draft, setDraft] = useState<ConsentDraft>({ consent: consentForChoice("closed"), constraintInfo: "" });
  const problem = draftProblem(draft);

  return (
    <div className="min-w-0">
      <ConsentChoice draft={draft} onChange={setDraft} />

      <div className="mt-10 border-t border-line pt-6">
        <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-text-faint">
          What a reader would be told
        </p>
        <UseRows consent={draft.consent} className="mt-4" />
        <p className="mt-4 max-w-[52ch] text-xs leading-relaxed text-text-faint">
          {problem === null
            ? "The register would take this statement as it stands."
            : "The register would refuse this statement until the conditions text is fixed."}
        </p>
      </div>
    </div>
  );
}
