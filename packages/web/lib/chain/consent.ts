import { unstable_cache } from "next/cache";
import { cache } from "react";
import type { Hex } from "viem";
import { CACHE_TAGS, HOLD_SECONDS, addresses, chain, consentAbi } from "./client";
import { passportTag } from "./registry";

/**
 * What a passport's holder has said about AI use of their picture, read from
 * MoolamConsent.
 *
 * The contract stores numbers; this file is the only place they become words,
 * and a number the contract's enum does not define is a failed read rather than
 * a guess. Everything a screen shows about a statement comes through here, so
 * the app can never print a permission the chain did not actually give.
 */

/** The contract's Use enum in its own order, 0 to 3. */
export const USE_WORDS = ["unspecified", "allowed", "notAllowed", "constrained"] as const;

export type Use = (typeof USE_WORDS)[number];

/** The four kinds of use one statement covers, in the order the struct holds them. */
export const USE_FIELDS = ["aiTraining", "aiGenerativeTraining", "aiInference", "dataMining"] as const;

export type UseField = (typeof USE_FIELDS)[number];

export type Consent = Record<UseField, Use>;

/** One statement, exactly as it was written. Nothing on chain is ever edited. */
export interface ConsentEntry {
  /** Block timestamp in whole seconds. */
  at: bigint;
  /** The address that held the passport when the statement was written. */
  writer: Hex;
  consent: Consent;
  /** Free text, empty unless a use is constrained. */
  constraintInfo: string;
}

/** What the chain answered: the statement, or that there is none. */
export interface ConsentReading {
  stated: boolean;
  entry: ConsentEntry | null;
}

/**
 * The five plain summaries a headline can carry. "mixed" is a statement that
 * says different things about different uses, which is a real choice and not a
 * fallback.
 */
export type Statement = "open" | "closed" | "ask" | "mixed" | "none";

/**
 * What the contract holds for a passport nobody has spoken for: four uses, none
 * of them stated. A card draws these rows rather than hiding them, because
 * "nothing stated" is an answer a reader has to be given, not an empty space.
 */
export const NOTHING_STATED: Consent = {
  aiTraining: "unspecified",
  aiGenerativeTraining: "unspecified",
  aiInference: "unspecified",
  dataMining: "unspecified",
};

/** The most history entries the contract will return in one read. */
export const HISTORY_PAGE = 64n;

/** Thirty two bytes of hex, in either case: the same rule the verify service uses. */
const PASSPORT_ID = /^0x[0-9a-fA-F]{64}$/;

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** A statement the contract answered with a value this app will not read. */
export class MalformedConsent extends Error {
  constructor(detail: string) {
    super(`the consent register answered with ${detail}`);
    this.name = "MalformedConsent";
  }
}

/** The word for one enum value, or undefined when the contract answered outside its own enum. */
export function asUseWord(value: number): Use | undefined {
  return Number.isInteger(value) && value >= 0 && value < USE_WORDS.length ? USE_WORDS[value] : undefined;
}

/** The same mapping the other way, for a call this app is about to make. */
export function asUseNumber(word: Use): number {
  return USE_WORDS.indexOf(word);
}

/**
 * Reduces the four uses to one plain summary.
 *
 * Per CAWG Training and Data Mining 1.1 a reader with no way to reach the
 * creator treats "constrained" as "not allowed", but this summary keeps the two
 * apart: a card that folded them together would hide the one thing a conditional
 * statement is for, which is that there is somebody to ask.
 */
export function plainStatement(consent: Consent): Statement {
  const values = USE_FIELDS.map((field) => consent[field]);
  if (values.every((use) => use === "unspecified")) {
    return "none";
  }
  if (values.every((use) => use === "allowed")) {
    return "open";
  }
  if (values.every((use) => use === "notAllowed")) {
    return "closed";
  }
  if (values.every((use) => use === "constrained")) {
    return "ask";
  }
  return "mixed";
}

/** True when anything in this statement has to be read as a refusal, conditions included. */
export function refusesSomething(consent: Consent): boolean {
  return USE_FIELDS.some((field) => consent[field] === "notAllowed" || consent[field] === "constrained");
}

/** The id as the contract wants it, or null when the value is not a passport id at all. */
export function passportIdFrom(value: unknown): Hex | null {
  return typeof value === "string" && PASSPORT_ID.test(value) ? (value.toLowerCase() as Hex) : null;
}

/**
 * A moment in whole seconds, or null.
 *
 * The scrubber's time arrives from a query string, so it is read here rather
 * than by whoever built the URL: anything that is not a run of digits inside
 * what a JSON number can hold is refused instead of becoming NaN in a call.
 */
export function secondsFrom(value: unknown): number | null {
  if (typeof value !== "string" || !/^\d{1,15}$/.test(value)) {
    return null;
  }
  const seconds = Number(value);
  return Number.isSafeInteger(seconds) ? seconds : null;
}

/** The raw tuple one consentOf or consentAt call answers with. */
interface RawEntry {
  at: bigint;
  writer: string;
  consent: { aiTraining: number; aiGenerativeTraining: number; aiInference: number; dataMining: number };
  constraintInfo: string;
}

/**
 * Turns one decoded entry into the shape the screens read.
 *
 * Every field is checked as hard as a request body: a use outside the enum, a
 * timestamp a JSON number cannot hold and a writer that is not an address all
 * fail the read, because half a statement is worse than none.
 */
export function entryFrom(raw: RawEntry): ConsentEntry {
  const consent = {} as Consent;
  for (const field of USE_FIELDS) {
    const word = asUseWord(raw.consent[field]);
    if (word === undefined) {
      throw new MalformedConsent(`${String(raw.consent[field])} for ${field}, which is outside its Use enum`);
    }
    consent[field] = word;
  }

  if (raw.at < 0n || raw.at > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new MalformedConsent(`a timestamp of ${raw.at.toString()} seconds`);
  }
  if (!ADDRESS.test(raw.writer)) {
    throw new MalformedConsent(`${raw.writer} as the writer, which is not an address`);
  }

  return { at: raw.at, writer: raw.writer as Hex, consent, constraintInfo: raw.constraintInfo };
}

/** The statement that stands right now, read live. */
export async function getConsent(id: Hex): Promise<ConsentReading> {
  const [stated, latest] = (await chain.readContract({
    address: addresses.consent,
    abi: consentAbi,
    functionName: "consentOf",
    args: [id],
  })) as readonly [boolean, RawEntry];

  return stated ? { stated: true, entry: entryFrom(latest) } : { stated: false, entry: null };
}

/** Every statement a passport has collected, oldest first, up to the contract's own cap of 64. */
export async function getConsentHistory(id: Hex): Promise<ConsentEntry[]> {
  const page = (await chain.readContract({
    address: addresses.consent,
    abi: consentAbi,
    functionName: "historyPage",
    args: [id, 0n, HISTORY_PAGE],
  })) as RawEntry[];

  return page.map(entryFrom);
}

/**
 * What was in force at a moment in the past.
 *
 * This is the question a file of labels cannot answer and the reason the
 * register keeps every statement instead of overwriting one. It is never held:
 * the answer belongs to the moment the reader asked about, and a scrubber asks
 * a different moment on every step.
 */
export async function consentAt(id: Hex, unixSeconds: number): Promise<ConsentReading> {
  const [stated, inForce] = (await chain.readContract({
    address: addresses.consent,
    abi: consentAbi,
    functionName: "consentAt",
    args: [id, BigInt(unixSeconds)],
  })) as readonly [boolean, RawEntry];

  return stated ? { stated: true, entry: entryFrom(inForce) } : { stated: false, entry: null };
}

/** The vocabulary the register speaks, named on chain so no screen has to spell it itself. */
export async function getStandard(): Promise<string> {
  return (await chain.readContract({
    address: addresses.consent,
    abi: consentAbi,
    functionName: "STANDARD",
  })) as string;
}

/** The same readings with every counter a string, because a bigint does not survive JSON. */
interface EntryWire extends Omit<ConsentEntry, "at"> {
  at: string;
}

interface ReadingWire {
  stated: boolean;
  entry: EntryWire | null;
}

function toWire(entry: ConsentEntry): EntryWire {
  return { ...entry, at: entry.at.toString() };
}

function fromWire(entry: EntryWire): ConsentEntry {
  return { ...entry, at: BigInt(entry.at) };
}

/**
 * The statement that stands, held for a minute under this passport's own name.
 *
 * Filed exactly like the passport record beside it, so a write to one passport
 * drops that passport's statement too and nothing else the app has cached.
 * React's cache is the outer layer: a page that draws the card and a line under
 * a match both ask for this, and one render should cost one read of the hold.
 */
export const heldConsent = cache(async (id: Hex): Promise<ConsentReading> => {
  const held = unstable_cache(
    async (): Promise<ReadingWire> => {
      const reading = await getConsent(id);
      return { stated: reading.stated, entry: reading.entry === null ? null : toWire(reading.entry) };
    },
    ["moolam-consent", id.toLowerCase()],
    { revalidate: HOLD_SECONDS, tags: [CACHE_TAGS.chain, passportTag(id)] },
  );

  const wire = await held();
  return { stated: wire.stated, entry: wire.entry === null ? null : fromWire(wire.entry) };
});

/** A passport's whole history of statements, oldest first, held under the same name. */
export const heldConsentHistory = cache(async (id: Hex): Promise<ConsentEntry[]> => {
  const held = unstable_cache(
    async (): Promise<EntryWire[]> => (await getConsentHistory(id)).map(toWire),
    ["moolam-consent-history", id.toLowerCase()],
    { revalidate: HOLD_SECONDS, tags: [CACHE_TAGS.chain, passportTag(id)] },
  );

  return (await held()).map(fromWire);
});

/**
 * The standard's name, read from the contract rather than written into the app.
 *
 * It cannot change on a deployed register, so it is held under the chain's name
 * alone: it belongs to no one passport.
 */
export const heldStandard = cache(async (): Promise<string> => {
  const held = unstable_cache(async () => await getStandard(), ["moolam-consent-standard"], {
    revalidate: HOLD_SECONDS,
    tags: [CACHE_TAGS.chain],
  });

  return await held();
});
