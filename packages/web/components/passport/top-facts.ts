import type { CSSProperties } from "react";
import type { Hex } from "viem";
import { shortHex } from "@/lib/chain/client";
import { isPrivateRecheck } from "@/lib/chain/receivers";
import { plainStatement, type ConsentReading, type Statement } from "@/lib/chain/consent";
import { bitsApart, phashWord } from "@/lib/chain/fingerprint";
import type { Attestation } from "@/lib/chain/registry";
import type { Credit } from "@/lib/platforms/platforms";
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
  "unclaimed",
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

/** The few parts of a section element an in-page jump touches. */
export interface JumpTarget {
  scrollIntoView(options: ScrollIntoViewOptions): void;
  focus(options?: FocusOptions): void;
  hasAttribute(name: string): boolean;
  setAttribute(name: string, value: string): void;
}

/** The few parts of window.history an in-page jump touches. */
export interface JumpHistory {
  readonly state: unknown;
  replaceState(data: unknown, unused: string, url?: string | URL | null): void;
}

/**
 * Moves the reader to a fact's section without adding a history entry.
 *
 * The browser's own hash jump pushes an entry the Next router never wrote, and
 * Back from the page after it then changes the address and nothing else. So
 * the address is swapped in place, keeping the router's own state on it, and
 * Back always lands on an entry the router knows.
 */
export function jumpToFact(
  id: string,
  { target, history, reduced }: { target: JumpTarget; history: JumpHistory; reduced: boolean },
): void {
  target.scrollIntoView({ behavior: reduced ? "instant" : "smooth", block: "start" });
  // A section is not focusable on its own. Focus moves there so the next Tab
  // starts from the fact the reader asked for, not from the strip. The scroll
  // above already did the moving, so focus must not jump the page again.
  if (!target.hasAttribute("tabindex")) {
    target.setAttribute("tabindex", "-1");
  }
  target.focus({ preventScroll: true });
  history.replaceState(history.state, "", `#${id}`);
}

/** The ink a value is drawn in: the cold status family, never the accent. */
export type TopFactTone = "text" | "verified" | "failed" | "pending" | "disputed" | "faint";

export interface TopFact {
  key: TopFactKey;
  label: string;
  value: string;
  /** A second, quieter line: the agent's number under its name, or the platform under a platform passport's credit. */
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
  /**
   * Which verdicts Chainlink's network delivered, by the trust mark's own rule
   * (networkVerdicts in components/mark/read.ts), matched to a row by its
   * time. Null, or left out by a screen that made no index read, when that
   * could not be read: the fact then says so, as the mark does, rather than
   * calling a run a check or a test run on a guess.
   */
  verdicts?: readonly { at: number; network: boolean }[] | null;
  phash: bigint;
  sealed: boolean;
  privateRecheck: boolean;
  /**
   * Who the one credit rule names (creditFor in lib/data/platform-label.ts).
   * Only the held, handed, confirmed and passed-on cases change "Made by"; a
   * co-signed picture's creator is already the person, and every other
   * passport has no credit, so "Made by" is the creator's address for both.
   */
  credit?: Credit | null;
}

/** The page's existing words, handed in so this stays a plain function a test can call. */
export interface TopFactsSay {
  kind: (kind: number) => string;
  agentNumber: (id: string) => string;
  /** The detail under a card's own name: the agent's number, and that the name is the card's word (P14). */
  cardNamed: (agent: string) => string;
  statement: (statement: Statement) => string;
  bits: (count: number) => string;
  privateRecheck: string;
  /**
   * The words for a run in Chainlink's simulator, public and private: it is
   * listed, and never a check. A caller that hands in no verdicts never needs
   * them; one that does and leaves them out gets the unread fact instead.
   */
  testRun?: string;
  privateTestRun?: string;
  sealed: string;
  date: (seconds: bigint) => string;
  /**
   * The detail under "Not claimed yet": the platform that holds the passport
   * until the person claims it. Optional for a caller that never hands in a
   * credit; without it the value stands alone.
   */
  heldBy?: (platform: string) => string;
  /** The detail under a confirmed first recipient: the platform that handed it over. Optional as heldBy is. */
  via?: (platform: string) => string;
  /** The detail under the holder of a handed passport nobody has confirmed. Optional as heldBy is. */
  handedBy?: (platform: string) => string;
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

function madeBy({ creator, credit }: TopFactsInput, say: TopFactsSay): TopFact {
  const base = { key: "madeBy" as const, label: say.words.madeBy, href: anchor("madeBy") };
  if (credit?.case === "held") {
    // Nobody is named while the platform still holds it, and the platform is
    // said only as the one holding it meanwhile.
    return { ...base, value: say.words.unclaimed, detail: say.heldBy?.(credit.platform), tone: "faint" };
  }
  if (credit?.case === "handed") {
    // The holder is shown, faint, with the detail that nobody has confirmed:
    // the address alone must never read as the person who imagined it (P39).
    return { ...base, value: shortHex(credit.heldBy), detail: say.handedBy?.(credit.platform), tone: "faint", mono: true };
  }
  if (credit?.case === "confirmed" || credit?.case === "passedOn") {
    // The first recipient who confirmed, never a later holder.
    return { ...base, value: shortHex(credit.imaginedBy), detail: say.via?.(credit.platform), tone: "text", mono: true };
  }
  return { ...base, value: shortHex(creator), tone: "text", mono: true };
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
    // The card's name is whatever the agent's owner wrote, so the line under it
    // says so rather than letting it read as a checked fact.
    detail: name === undefined || name === "" ? undefined : say.cardNamed(number),
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
  { attestations, verdicts, phash, sealed, privateRecheck }: TopFactsInput,
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

  // Counted off the chain's own two fingerprints, the same count the section
  // below prints, rather than the receiver's word for it.
  const counted = bitsApart(phash, phashWord(latest.recomputed));
  const line = (who: string): string => `${who}, ${say.date(latest.at)}, ${say.bits(counted)}`;

  if (attestationSource(latest.receiver) !== "chainlink") {
    return { ...base, value: line(`${say.words.unknownWriter} ${shortHex(latest.receiver)}`), tone: latest.matched ? "verified" : "failed" };
  }
  const network = verdicts?.find((verdict) => verdict.at === Number(latest.at))?.network;
  if (network === undefined) {
    return { ...base, value: say.words.unread, tone: "faint", unread: true };
  }
  const privately = isPrivateRecheck(latest.receiver);
  // A run in the simulator is listed in the quiet ink: the mark it never turns
  // on sits right over this strip, and the two must not disagree.
  if (!network) {
    const word = privately ? say.privateTestRun : say.testRun;
    return word === undefined
      ? { ...base, value: say.words.unread, tone: "faint", unread: true }
      : { ...base, value: line(word), tone: "faint" };
  }
  return {
    ...base,
    value: line(privately ? say.privateRecheck : say.words.chainlink),
    tone: latest.matched ? "verified" : "failed",
  };
}
