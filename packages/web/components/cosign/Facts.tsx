"use client";

import { useTranslations } from "next-intl";
import { UseMark } from "@/components/consent/Marks";
import { USE_FIELDS, plainStatement, type Consent, type Use } from "@/lib/chain/consent";
import type { ConsentDraft } from "@/lib/consent/call";
import type { AgentFacts } from "@/lib/cosign/listing";
import { shortAddress } from "./Marks";

/**
 * One use's ink. The site's consent tones draw "ask first" in the dispute
 * purple, which this page may not use, so a condition is drawn in the text ink.
 */
const USE_INKS: Record<Use, string> = {
  allowed: "text-verified",
  notAllowed: "text-pending",
  constrained: "text-text",
  unspecified: "text-text-faint",
};

/**
 * The agent's own claim about itself, set apart from the listing: in quotes,
 * with its id and owner beside it and the sentence that says nobody checked
 * the name (P14).
 */
export function AgentFact({ agentId, facts }: { agentId: string; facts: AgentFacts | null }) {
  const t = useTranslations("cosign.agent");
  const name = facts?.name ?? null;
  return (
    <div data-fact="agent" className="min-w-0">
      <p className="text-[clamp(1.05rem,1.4cqw,1.25rem)] leading-snug text-text">
        {name === null ? <span className="text-text-muted">{t("noName")}</span> : <>&ldquo;{name}&rdquo;</>}
      </p>
      <p className="mt-1.5 font-mono text-[11px] leading-relaxed text-text-muted">
        {t("id", { id: agentId })}
        {facts?.owner === null || facts?.owner === undefined ? null : (
          <>
            {" · "}
            <span title={facts.owner}>{t("owner", { owner: shortAddress(facts.owner) })}</span>
          </>
        )}
      </p>
      <p className="mt-1.5 text-base leading-snug text-text-muted">{t("unchecked")}</p>
    </div>
  );
}

/** How far Moolam vouches for the platform: named and listed, withheld because the agent changed hands, or not listed. */
export type Standing = "listed" | "withheld" | "unlisted";

export function standingOf(facts: AgentFacts | null): Standing {
  if (facts?.listing === null || facts?.listing === undefined) return "unlisted";
  return facts.listing.badge ? "listed" : "withheld";
}

/**
 * The platform as Moolam lists it. The name comes from Moolam's list alone,
 * and only while the agent's owner is still the one that signed at
 * onboarding; otherwise the name is withheld and the line says why (P16).
 */
export function PlatformFact({ agentId, facts }: { agentId: string; facts: AgentFacts | null }) {
  const t = useTranslations("cosign.platform");
  const standing = standingOf(facts);
  const name =
    standing === "listed" ? (facts?.listing?.name ?? "") : standing === "withheld" ? t("withheldName") : t("unlistedName");
  const line =
    standing === "listed"
      ? t("listedLine", { agent: agentId })
      : standing === "withheld"
        ? t("withheldLine", { agent: agentId })
        : t("unlistedLine", { agent: agentId });
  return (
    <div data-fact="platform" data-standing={standing} className="min-w-0">
      <p
        className={`font-display text-[clamp(1.1rem,1.6cqw,1.45rem)] font-semibold leading-tight tracking-[-0.02em] ${
          standing === "listed" ? "text-text" : "text-text-muted"
        }`}
      >
        {name}
      </p>
      <p className="mt-1.5 text-base leading-snug text-text-muted">{line}</p>
    </div>
  );
}

/** The four uses exactly as the picture's own file states them, and the condition text word for word (P9). */
export function TermsFact({ terms }: { terms: ConsentDraft | null }) {
  const summary = useTranslations("cosign.terms");
  const uses = useTranslations("passport.consent.usesShort");
  const states = useTranslations("passport.consent.state");
  const consent: Consent | null = terms?.consent ?? null;
  const statement = consent === null ? "none" : plainStatement(consent);
  return (
    <div data-fact="terms" className="min-w-0">
      <p className="font-display text-[clamp(1.05rem,1.4cqw,1.25rem)] font-semibold leading-tight tracking-[-0.015em] text-text">
        {summary(statement)}
      </p>
      <ul className="mt-3 grid max-w-[22rem] grid-cols-[repeat(auto-fit,minmax(8.5rem,1fr))] gap-x-5 gap-y-1.5">
        {USE_FIELDS.map((field) => {
          const use: Use = consent?.[field] ?? "unspecified";
          return (
            <li key={field} className="flex min-w-0 items-center gap-2">
              <span className={USE_INKS[use]}>
                <UseMark state={use} className="h-3 w-3" />
              </span>
              <span className="min-w-0 truncate font-mono text-[10px] uppercase tracking-[0.14em] text-text-muted">
                {uses(field)}
              </span>
              <span className="sr-only">{states(use)}</span>
            </li>
          );
        })}
      </ul>
      {terms === null || terms.constraintInfo === "" ? null : (
        <p className="mt-3 break-words border-s border-line-strong ps-3 font-mono text-xs leading-relaxed text-text">
          &ldquo;{terms.constraintInfo}&rdquo;
        </p>
      )}
    </div>
  );
}
