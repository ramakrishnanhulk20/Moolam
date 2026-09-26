import type { CSSProperties } from "react";
import type { Hex } from "viem";
import { shortHex } from "@/lib/chain/client";
import { isPrivateRecheck } from "@/lib/chain/receivers";
import { plainStatement, type ConsentReading, type Statement } from "@/lib/chain/consent";
import { bitsApart, phashWord } from "@/lib/chain/fingerprint";
import type { Attestation } from "@/lib/chain/registry";
import { attestationSource } from "./labels";

/** The strip's own words, read from passport.facts in the reader's language. */
export const TOP_FACT_WORD_KEYS = [
  "madeBy",
  "drawnBy",
  "aiUse",
  "rechecked",
  "nothingStated",
  "notYet",
  "unread",
  "noAgent",
  "chainlink",
  "unknownWriter",
] as const;

export type TopFactWords = Record<(typeof TOP_FACT_WORD_KEYS)[number], string>;

/**
 * Where each fact lands on the page. The re-check already had its anchor, the
 * one the verify card's "See the second opinion" link uses.
 */
export const FACT_ANCHORS = {
  madeBy: "made-by",
  drawnBy: "drawn-by",
  aiUse: "ai-use",
  rechecked: "second-opinion",
} as const;

/** Clears the fixed header when a fact's link scrolls its section into view. */
export const ANCHOR_MARGIN: CSSProperties = { scrollMarginTop: "calc(var(--header-h) + 1rem)" };

export type TopFactKey = keyof typeof FACT_ANCHORS;

/** The ink a value is drawn in: the cold status family, never the accent. */
export type TopFactTone = "text" | "verified" | "failed" | "pending" | "disputed" | "faint";

export interface TopFact {
  key: TopFactKey;
  label: string;
  value: string;
  /** A second, quieter line: the agent's number under its name. */
  detail?: string;
  /** "#anchor" on this page, or a route inside the app. */
  href: string;
  tone: TopFactTone;
  /** Drawn in the mono face, for an address. */
  mono?: true;
  /** True when the read behind this fact failed, so the value says so. */
  unread?: true;
}

export interface TopFactsInput {
  creator: Hex;
  agentId: bigint;
  /**
   * The agent card's own name. Null when the card names nothing or could not
   * be read: the number is still true, so it stands alone.
   */
  agentName: string | null;
  kind: number;
  /** Null when the consent register could not be read. */
  consent: ConsentReading | null;
  attestations: readonly Attestation[];
  phash: bigint;
  sealed: boolean;
  privateRecheck: boolean;
}

/** The page's existing words, handed in so this stays a plain function a test can call. */
export interface TopFactsSay {
  kind: (kind: number) => string;
  agentNumber: (id: string) => string;
  statement: (statement: Statement) => string;
  bits: (count: number) => string;
  privateRecheck: string;
  sealed: string;
  date: (seconds: bigint) => string;
  words: TopFactWords;
}

const STATEMENT_TONES: Record<Statement, TopFactTone> = {
  open: "verified",
  closed: "pending",
  ask: "disputed",
  mixed: "text",
  none: "faint",
};

const anchor = (key: TopFactKey): string => `#${FACT_ANCHORS[key]}`;

/**
 * The four answers a passport gives at a glance, each read off something the
 * page already holds, in the order a stranger asks them: who made it, what
 * drew it, what the holder allows, and whether anybody checked.
 */
export function topFacts(input: TopFactsInput, say: TopFactsSay): TopFact[] {
  return [madeBy(input, say), drawnBy(input, say), aiUse(input, say), rechecked(input, say)];
}

function madeBy({ creator }: TopFactsInput, say: TopFactsSay): TopFact {
  return {
    key: "madeBy",
    label: say.words.madeBy,
    value: shortHex(creator),
    href: anchor("madeBy"),
    tone: "text",
    mono: true,
  };
}

function drawnBy({ agentId, agentName, kind }: TopFactsInput, say: TopFactsSay): TopFact {
  if (agentId === 0n) {
    // A captured picture was taken, not drawn, and the page's own word for it
    // says so. Anything else registered without an agent says there is none.
    return {
      key: "drawnBy",
      label: say.words.drawnBy,
      value: kind === 1 ? say.kind(1) : say.words.noAgent,
      href: anchor("drawnBy"),
      tone: "faint",
    };
  }

  const number = say.agentNumber(agentId.toString());
  const name = agentName?.trim();
  return {
    key: "drawnBy",
    label: say.words.drawnBy,
    value: name === undefined || name === "" ? number : name,
    detail: name === undefined || name === "" ? undefined : number,
    href: `/agent/${agentId.toString()}`,
    tone: "text",
  };
}

function aiUse({ consent }: TopFactsInput, say: TopFactsSay): TopFact {
  const base = { key: "aiUse" as const, label: say.words.aiUse, href: anchor("aiUse") };
  if (consent === null) {
    return { ...base, value: say.words.unread, tone: "faint", unread: true };
  }
  const statement: Statement = consent.stated && consent.entry !== null ? plainStatement(consent.entry.consent) : "none";
  return statement === "none"
    ? { ...base, value: say.words.nothingStated, tone: "faint" }
    : { ...base, value: say.statement(statement), tone: STATEMENT_TONES[statement] };
}

function rechecked(
  { attestations, phash, sealed, privateRecheck }: TopFactsInput,
  say: TopFactsSay,
): TopFact {
  const base = { key: "rechecked" as const, label: say.words.rechecked, href: anchor("rechecked") };
  const latest = attestations.reduce<Attestation | null>(
    (newest, attestation) => (newest === null || attestation.at > newest.at ? attestation : newest),
    null,
  );

  if (latest === null) {
    // A sealed passport with no private copy asked for can never be re-checked,
    // so "Not yet" would promise something. It gets the page's own word.
    return sealed && !privateRecheck
      ? { ...base, value: say.sealed, tone: "faint" }
      : { ...base, value: say.words.notYet, tone: "faint" };
  }

  const who = isPrivateRecheck(latest.receiver)
    ? say.privateRecheck
    : attestationSource(latest.receiver) === "chainlink"
      ? say.words.chainlink
      : `${say.words.unknownWriter} ${shortHex(latest.receiver)}`;
  // Counted off the chain's own two fingerprints, the same count the section
  // below prints, rather than the receiver's word for it.
  const counted = bitsApart(phash, phashWord(latest.recomputed));

  return {
    ...base,
    value: `${who}, ${say.date(latest.at)}, ${say.bits(counted)}`,
    tone: latest.matched ? "verified" : "failed",
  };
}
