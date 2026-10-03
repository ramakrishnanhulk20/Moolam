import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { getAddress, zeroAddress } from "viem";
import { z } from "zod";
import { writeJsonFile } from "../stateDir.js";
import { EMAIL_HASH_TEXT } from "./email.js";
import { termsSchema, type ClaimTerms } from "./terms.js";

/** How a platform says it knows the address is its user's. Its word, never Moolam's (P36). */
export const VERIFIED_BY = ["google", "email-code", "platform"] as const;

export type VerifiedBy = (typeof VERIFIED_BY)[number];

export const TICKET_STATES = ["pending", "open", "accepted", "delivered", "refused", "expired", "failed", "moved"] as const;

export type TicketState = (typeof TICKET_STATES)[number];

/**
 * The step each state may take (P33). A pending ticket written with a standing destination skips
 * the offer, because the person already chose where that platform's pictures go: it moves straight
 * to accepted, or to delivered when the platform's one pass has already landed. The five terminal
 * states never move again.
 */
const NEXT: Record<TicketState, readonly TicketState[]> = {
  pending: ["open", "accepted", "delivered", "expired"],
  open: ["accepted", "refused", "moved", "expired"],
  accepted: ["delivered", "failed", "moved", "expired"],
  delivered: [],
  refused: [],
  expired: [],
  failed: [],
  moved: [],
};

export function isTerminal(state: TicketState): boolean {
  return NEXT[state].length === 0;
}

/** 128 bits from the operating system's CSPRNG (P32): an id is a capability, so guessing one is hopeless. */
const TICKET_ID_BYTES = 16;

const TICKET_ID_TEXT = /^[0-9a-f]{32}$/;

export function newTicketId(): string {
  return randomBytes(TICKET_ID_BYTES).toString("hex");
}

export function isTicketId(value: unknown): value is string {
  return typeof value === "string" && TICKET_ID_TEXT.test(value);
}

/**
 * How long a ticket written at prepare waits for its passport to land under the platform's wallet:
 * the 30 minute signature window the registry gives the fields, then an hour and a half for a
 * platform whose send was slow, read against chain time. A ticket still pending after that expires.
 */
export const PENDING_WINDOW_SECONDS = 2 * 60 * 60;

/** How long an offer stands, from the prepare that wrote it. */
export const TICKET_LIFETIME_SECONDS = 180 * 24 * 60 * 60;

/**
 * How long a closed ticket stays after it closes, so the person still sees what became of it. It is
 * never pruned before its lifetime ends either, so the per-address count below cannot fall because
 * of anything the person did (P30).
 */
export const KEEP_CLOSED_SECONDS = 30 * 24 * 60 * 60;

/**
 * The caps on what the store holds (P38). A thousand tickets for one key is ten days of its full
 * prepare quota; twenty tickets for one address from one platform inside a ticket's lifetime is
 * more than a real user makes before claiming, and is what stops a platform burying one address
 * under offers. The record caps keep a read of the whole file to a few megabytes.
 */
export interface ClaimCaps {
  /**
   * Tickets one key may hold inside a ticket's lifetime, whatever state each is in. Counting only
   * the pending and open ones would let a refusal free a slot, and a platform that watched its
   * room come back after a ticket for one address would learn that address is a Moolam user's
   * (P30).
   */
  perKey: number;
  /**
   * Tickets one key may write for one address inside a ticket's lifetime, whatever state each is in:
   * a count that a refusal or a mute could lower would tell the platform the address is a Moolam
   * user's (P30).
   */
  perEmailAndKey: number;
  tickets: number;
  standing: number;
  muted: number;
  /** Refusals a key may collect before its share of refusals is judged at all. */
  refusalFloor: number;
  /** A key is closed once more than one in this many of its tickets were refused. */
  refusalShare: number;
}

export const DEFAULT_CLAIM_CAPS: ClaimCaps = {
  perKey: 1_000,
  perEmailAndKey: 20,
  tickets: 20_000,
  standing: 20_000,
  muted: 20_000,
  refusalFloor: 10,
  refusalShare: 4,
};

const bytes32 = z.string().regex(/^0x[0-9a-f]{64}$/);
const unixSeconds = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
// The same parser on both sides of every later comparison: an address is stored exactly as
// getAddress writes it, and a stored value in any other form is refused, never normalised.
const checksummed = z.string().refine((value) => {
  try {
    return getAddress(value) === value && value !== zeroAddress;
  } catch {
    return false;
  }
}, "not a checksummed address");
const emailHashText = z.string().regex(EMAIL_HASH_TEXT);
/** What the chain returned as the passport's metadataURI, kept only as text: it is read through the pinned-content rule later. */
const chainUri = z.string().max(2048).nullable();

const base = {
  version: z.literal(1),
  ticketId: z.string().regex(TICKET_ID_TEXT),
  passportId: bytes32,
  keyHash: bytes32,
  platformName: z.string().min(1).max(200),
  creatorWallet: checksummed,
  verifiedBy: z.enum(VERIFIED_BY),
  emailHash: emailHashText,
  createdAt: unixSeconds,
  pendingUntil: unixSeconds,
  expiresAt: unixSeconds,
  standing: checksummed.nullable(),
  standingTerms: termsSchema.nullable(),
};

/**
 * One schema per state, so a state carries exactly what its step has set: an "accepted" ticket
 * with no destination, or an "open" one already holding terms, fails the parse, which is how a
 * record that skipped a step or was edited on disk is caught on read-back (P33).
 */
const ticketSchema = z.discriminatedUnion("state", [
  z.strictObject({
    ...base,
    state: z.literal("pending"),
    openedAt: z.null(),
    metadataURI: z.null(),
    destination: z.null(),
    terms: z.null(),
    acceptedAt: z.null(),
    closedAt: z.null(),
  }),
  z.strictObject({
    ...base,
    state: z.literal("open"),
    openedAt: unixSeconds,
    metadataURI: chainUri,
    destination: z.null(),
    terms: z.null(),
    acceptedAt: z.null(),
    closedAt: z.null(),
  }),
  z.strictObject({
    ...base,
    state: z.literal("accepted"),
    openedAt: unixSeconds,
    metadataURI: chainUri,
    destination: checksummed,
    terms: termsSchema,
    acceptedAt: unixSeconds,
    closedAt: z.null(),
  }),
  z.strictObject({
    ...base,
    state: z.enum(["delivered", "failed"]),
    openedAt: unixSeconds,
    metadataURI: chainUri,
    destination: checksummed,
    terms: termsSchema,
    acceptedAt: unixSeconds,
    closedAt: unixSeconds,
  }),
  z.strictObject({
    ...base,
    state: z.literal("refused"),
    openedAt: unixSeconds,
    metadataURI: chainUri,
    destination: z.null(),
    terms: z.null(),
    acceptedAt: z.null(),
    closedAt: unixSeconds,
  }),
  z.strictObject({
    ...base,
    state: z.literal("moved"),
    openedAt: unixSeconds,
    metadataURI: chainUri,
    destination: checksummed.nullable(),
    terms: termsSchema.nullable(),
    acceptedAt: unixSeconds.nullable(),
    closedAt: unixSeconds,
  }),
  z.strictObject({
    ...base,
    state: z.literal("expired"),
    openedAt: unixSeconds.nullable(),
    metadataURI: chainUri,
    destination: checksummed.nullable(),
    terms: termsSchema.nullable(),
    acceptedAt: unixSeconds.nullable(),
    closedAt: unixSeconds,
  }),
]);

export type Ticket = z.infer<typeof ticketSchema>;

const standingSchema = z.strictObject({
  emailHash: emailHashText,
  keyHash: bytes32,
  platformName: z.string().min(1).max(200),
  destination: checksummed,
  terms: termsSchema,
  setAt: unixSeconds,
});

export type Standing = z.infer<typeof standingSchema>;

const muteSchema = z.strictObject({
  emailHash: emailHashText,
  keyHash: bytes32,
  platformName: z.string().min(1).max(200),
  mutedAt: unixSeconds,
});

export type Mute = z.infer<typeof muteSchema>;

const keySchema = z.strictObject({
  keyHash: bytes32,
  written: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  refused: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  closedAt: unixSeconds.nullable(),
});

/** One platform key's tally of tickets written and refused, and when its ticket writing closed. */
export type KeyTally = z.infer<typeof keySchema>;

const FILE_VERSION = 1;

/** The file's outline. Each record inside is checked on its own, so one bad record costs only itself. */
const fileSchema = z.strictObject({
  version: z.literal(FILE_VERSION),
  tickets: z.array(z.unknown()),
  standing: z.array(z.unknown()),
  muted: z.array(z.unknown()),
  keys: z.array(z.unknown()),
});

export interface ClaimState {
  tickets: Ticket[];
  standing: Standing[];
  muted: Mute[];
  keys: KeyTally[];
}

/** The fields a ticket is written with, which no step may change (P33). */
const FIXED = [
  "version",
  "ticketId",
  "passportId",
  "keyHash",
  "platformName",
  "creatorWallet",
  "verifiedBy",
  "emailHash",
  "createdAt",
  "pendingUntil",
  "expiresAt",
  "standing",
  "standingTerms",
] as const;

/** Fields a later step sets once and nothing changes after. */
const SET_ONCE = ["openedAt", "metadataURI", "destination", "terms", "acceptedAt", "closedAt"] as const;

/** Why a parsed ticket cannot be believed, beyond its shape, or null. */
function ticketProblem(ticket: Ticket): string | null {
  if ((ticket.standing === null) !== (ticket.standingTerms === null)) {
    return "a standing destination without its terms";
  }
  if (ticket.pendingUntil <= ticket.createdAt || ticket.expiresAt <= ticket.pendingUntil) {
    return "the ticket's windows are out of order";
  }
  return null;
}

/** Why `next` may not replace `current`, or null when it is the next step and changes nothing fixed. */
function stepProblem(current: Ticket, next: Ticket): string | null {
  if (!NEXT[current.state].includes(next.state)) {
    return `a ticket in state ${current.state} cannot move to ${next.state}`;
  }
  for (const key of FIXED) {
    if (JSON.stringify(current[key]) !== JSON.stringify(next[key])) {
      return `the step would change ${key}, which was fixed when the ticket was written`;
    }
  }
  for (const key of SET_ONCE) {
    const before = current[key];
    if (before !== null && JSON.stringify(before) !== JSON.stringify(next[key])) {
      return `the step would change ${key}, which is set once`;
    }
  }
  return null;
}

/** The store cannot be read or written, so every claim route answers 503 rather than guess (fail closed). */
export class ClaimStoreClosed extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClaimStoreClosed";
  }
}

export type Outcome<T> = { ok: true; value: T } | { ok: false; reason: string };

export interface ClaimStore {
  /** Every record that passes its schema. Throws ClaimStoreClosed when the file cannot be believed at all. */
  read: () => ClaimState;
  /**
   * Runs `work` on the records as read now and writes what it returns, in one synchronous stretch,
   * so two requests can never both take the same step (P33). Every ticket that changed must be its
   * next step from what was read; a new ticket must be pending; only a closed ticket may leave. A
   * refusal from `work` or from those checks writes nothing. Throws ClaimStoreClosed as read does.
   */
  change: <T>(work: (state: ClaimState) => Outcome<{ state: ClaimState; result: T }>) => Outcome<T>;
}

/**
 * The claim store: one JSON file in the data folder, written whole through writeJsonFile, so a
 * process killed mid-write leaves the previous file.
 *
 * Every read checks every record against its state's schema. A record that fails is dropped, never
 * repaired, and the file is written back without it at once, with a count in the log and nothing
 * that names an email, a hash or a ticket. A file that is not JSON, or not this outline, closes the
 * store: dropping all of it would forget every refusal and mute, which is the wrong way to fail.
 *
 * Covers a record that was damaged, edited by hand or written by an older shape. Does not cover
 * someone who can write this folder and writes a well-formed record: the folder is trusted as far
 * as the process that owns it is. One process writes it; two would race.
 */
export function claimStore(file: string, log: (line: string) => void = () => undefined): ClaimStore {
  const load = (): ClaimState => {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { tickets: [], standing: [], muted: [], keys: [] };
      }
      throw new ClaimStoreClosed("the claim file could not be read");
    }
    let outline: z.infer<typeof fileSchema>;
    try {
      outline = fileSchema.parse(JSON.parse(text));
    } catch {
      throw new ClaimStoreClosed("the claim file is not a record this version reads");
    }

    let dropped = 0;
    const keep = <T>(rows: unknown[], schema: z.ZodType<T>, extra?: (row: T) => string | null): T[] => {
      const kept: T[] = [];
      for (const row of rows) {
        const parsed = schema.safeParse(row);
        if (!parsed.success || (extra !== undefined && extra(parsed.data) !== null)) {
          dropped += 1;
          continue;
        }
        kept.push(parsed.data);
      }
      return kept;
    };
    const tickets = unique(keep(outline.tickets, ticketSchema, ticketProblem), (ticket) => ticket.ticketId, () => (dropped += 1));
    const standing = unique(keep(outline.standing, standingSchema), pairOf, () => (dropped += 1));
    const muted = unique(keep(outline.muted, muteSchema), pairOf, () => (dropped += 1));
    const keys = unique(keep(outline.keys, keySchema), (tally) => tally.keyHash, () => (dropped += 1));
    const state = { tickets, standing, muted, keys };
    if (dropped > 0) {
      log(`the claim store dropped ${dropped} record${dropped === 1 ? "" : "s"} that failed their schema`);
      save(state);
    }
    return state;
  };

  const save = (state: ClaimState): void => {
    try {
      writeJsonFile(file, { version: FILE_VERSION, ...state });
    } catch {
      throw new ClaimStoreClosed("the claim file could not be written");
    }
  };

  return {
    read: load,
    change(work) {
      const before = load();
      const outcome = work(structuredClone(before));
      if (!outcome.ok) {
        return outcome;
      }
      const after = outcome.value.state;
      const problem = changeProblem(before, after);
      if (problem !== null) {
        return { ok: false, reason: problem };
      }
      save(after);
      return { ok: true, value: outcome.value.result };
    },
  };
}

/** Records keyed by the same value: the first is kept and every later one is dropped. */
function unique<T>(rows: T[], keyOf: (row: T) => string, onDrop: () => void): T[] {
  const seen = new Set<string>();
  return rows.filter((row) => {
    const key = keyOf(row);
    if (seen.has(key)) {
      onDrop();
      return false;
    }
    seen.add(key);
    return true;
  });
}

function pairOf(row: { emailHash: string; keyHash: string }): string {
  return `${row.emailHash}|${row.keyHash}`;
}

/** Why `after` may not be written over `before`, or null when every change is a legal one. */
function changeProblem(before: ClaimState, after: ClaimState): string | null {
  const earlier = new Map(before.tickets.map((ticket) => [ticket.ticketId, ticket]));
  const ids = new Set<string>();
  for (const ticket of after.tickets) {
    if (ids.has(ticket.ticketId)) return "a ticket id twice";
    ids.add(ticket.ticketId);
    const parsed = ticketSchema.safeParse(ticket);
    if (!parsed.success || ticketProblem(parsed.data) !== null) return "a ticket that would not read back";
    const old = earlier.get(ticket.ticketId);
    if (old === undefined) {
      if (ticket.state !== "pending") return "a new ticket starts pending";
      continue;
    }
    if (JSON.stringify(old) === JSON.stringify(ticket)) continue;
    const step = stepProblem(old, ticket);
    if (step !== null) return step;
  }
  for (const old of before.tickets) {
    if (!ids.has(old.ticketId) && !isTerminal(old.state)) return "only a closed ticket may be removed";
  }
  const rows: [unknown[], z.ZodType][] = [
    [after.standing, standingSchema],
    [after.muted, muteSchema],
    [after.keys, keySchema],
  ];
  for (const [list, schema] of rows) {
    if (list.some((row) => !schema.safeParse(row).success)) return "a record that would not read back";
  }
  return null;
}

/** Moves one ticket a step inside `change`, naming the state it must be in now (P33). */
export function advance(
  state: ClaimState,
  ticketId: string,
  from: TicketState,
  build: (current: Ticket) => Ticket,
): Outcome<Ticket> {
  const index = state.tickets.findIndex((ticket) => ticket.ticketId === ticketId);
  const current = state.tickets[index];
  if (current === undefined) return { ok: false, reason: "not-found" };
  if (current.state !== from) return { ok: false, reason: "not-open" };
  const next = build(current);
  state.tickets[index] = next;
  return { ok: true, value: next };
}

/** The tally for a key, made empty when the key has none yet. */
function tallyOf(state: ClaimState, keyHash: string): KeyTally {
  let tally = state.keys.find((one) => one.keyHash === keyHash);
  if (tally === undefined) {
    tally = { keyHash, written: 0, refused: 0, closedAt: null };
    state.keys.push(tally);
  }
  return tally;
}

/**
 * Why a key may not write a ticket for this email hash now: "closed" after too many refusals, "full"
 * at a cap, or null. Both caps count every ticket the key wrote inside a ticket's lifetime, in any
 * state, and a closed ticket is not pruned before that lifetime ends, so nothing a person does can
 * lower either count (P30).
 */
export function writeProblem(state: ClaimState, keyHash: string, emailHash: string, caps: ClaimCaps, now: number): "closed" | "full" | null {
  if (state.keys.some((tally) => tally.keyHash === keyHash && tally.closedAt !== null)) return "closed";
  if (state.tickets.length >= caps.tickets) return "full";
  let held = 0;
  let forAddress = 0;
  for (const ticket of state.tickets) {
    if (ticket.keyHash !== keyHash || ticket.expiresAt <= now) continue;
    held += 1;
    if (ticket.emailHash === emailHash) forAddress += 1;
  }
  return held >= caps.perKey || forAddress >= caps.perEmailAndKey ? "full" : null;
}

export interface NewTicket {
  passportId: string;
  keyHash: string;
  platformName: string;
  creatorWallet: string;
  verifiedBy: VerifiedBy;
  emailHash: string;
  standing: Standing | undefined;
}

/** Writes a pending ticket (P27), or says why the key may not. Counts it against the key's tally (P38). */
export function writeTicket(store: ClaimStore, input: NewTicket, chainNow: number, caps: ClaimCaps): Outcome<Ticket> {
  return store.change((state) => {
    const problem = writeProblem(state, input.keyHash, input.emailHash, caps, chainNow);
    if (problem !== null) return { ok: false, reason: problem };
    const ticket: Ticket = {
      version: 1,
      ticketId: newTicketId(),
      passportId: input.passportId.toLowerCase(),
      keyHash: input.keyHash,
      platformName: input.platformName,
      creatorWallet: getAddress(input.creatorWallet),
      verifiedBy: input.verifiedBy,
      emailHash: input.emailHash,
      createdAt: chainNow,
      pendingUntil: chainNow + PENDING_WINDOW_SECONDS,
      expiresAt: chainNow + TICKET_LIFETIME_SECONDS,
      standing: input.standing?.destination ?? null,
      standingTerms: input.standing?.terms ?? null,
      state: "pending",
      openedAt: null,
      metadataURI: null,
      destination: null,
      terms: null,
      acceptedAt: null,
      closedAt: null,
    };
    state.tickets.push(ticket);
    tallyOf(state, input.keyHash).written += 1;
    return { ok: true, value: { state, result: ticket } };
  });
}

/** The standing destination a person set for this platform, if any (P30): returned only to the key it was set for. */
export function standingFor(state: ClaimState, emailHash: string, keyHash: string): Standing | undefined {
  return state.standing.find((one) => one.emailHash === emailHash && one.keyHash === keyHash);
}

export function isMuted(state: ClaimState, emailHash: string, keyHash: string): boolean {
  return state.muted.some((one) => one.emailHash === emailHash && one.keyHash === keyHash);
}

/**
 * The tickets named, each one checked to belong to the caller (P32): the id exists, its email hash
 * is one of the caller's, and an open one's platform is not muted for that address, which is the
 * set the caller was shown. Any id outside that set refuses the whole request as "not-found", one
 * word for an unknown id and for someone else's, so the answer says nothing about ids the caller
 * does not own.
 *
 * The mute hides only open tickets. A caller's own ticket that has already moved is theirs either
 * way, and the step that follows refuses it as "not-open": otherwise a refusal that won a race would
 * mute the platform and turn the losing accept's "not-open" into "not-found", so the loser's answer
 * would depend on which request came first (P33).
 */
function ownTickets(state: ClaimState, ticketIds: readonly string[], emailHashes: ReadonlySet<string>): Outcome<Ticket[]> {
  const found: Ticket[] = [];
  for (const id of ticketIds) {
    const ticket = state.tickets.find((one) => one.ticketId === id);
    if (ticket === undefined || !emailHashes.has(ticket.emailHash) || (ticket.state === "open" && isMuted(state, ticket.emailHash, ticket.keyHash))) {
      return { ok: false, reason: "not-found" };
    }
    found.push(ticket);
  }
  return { ok: true, value: found };
}

export interface AcceptInput {
  ticketIds: readonly string[];
  emailHashes: ReadonlySet<string>;
  destination: string;
  terms: ClaimTerms;
  sendFuture: boolean;
  now: number;
  /** Whether the destination may receive this ticket's passport (P31), asked of every ticket before any moves. */
  allowed: (ticket: Ticket) => boolean;
}

/**
 * Accepts every named ticket for the caller's wallet, or none (P26, P32, P33): each must be the
 * caller's and open right now, so an accept racing a refuse or a second accept loses whole. With
 * sendFuture, the destination and terms stand for each platform among them until the person clears it.
 */
export function acceptTickets(store: ClaimStore, input: AcceptInput, caps: ClaimCaps): Outcome<Ticket[]> {
  return store.change((state) => {
    const own = ownTickets(state, input.ticketIds, input.emailHashes);
    if (!own.ok) return own;
    if (own.value.some((ticket) => !input.allowed(ticket))) return { ok: false, reason: "destination" };
    const accepted: Ticket[] = [];
    for (const ticket of own.value) {
      const step = advance(state, ticket.ticketId, "open", (current) =>
        current.state !== "open"
          ? current
          : {
              ...current,
              state: "accepted",
              destination: getAddress(input.destination),
              terms: input.terms,
              acceptedAt: input.now,
            },
      );
      if (!step.ok) return step;
      accepted.push(step.value);
    }
    if (input.sendFuture) {
      for (const ticket of accepted) {
        state.standing = state.standing.filter((one) => !(one.emailHash === ticket.emailHash && one.keyHash === ticket.keyHash));
        if (state.standing.length >= caps.standing) return { ok: false, reason: "full" };
        state.standing.push({
          emailHash: ticket.emailHash,
          keyHash: ticket.keyHash,
          platformName: ticket.platformName,
          destination: getAddress(input.destination),
          terms: input.terms,
          setAt: input.now,
        });
      }
    }
    return { ok: true, value: { state, result: accepted } };
  });
}

/**
 * Refuses every named ticket, or none (P26, P32, P33). Each refusal is final, mutes that platform
 * for that address, clears any standing destination the person had set for it, and counts against
 * the key; a key past its refusal share stops writing tickets until an operator clears its tally (P38).
 */
export function refuseTickets(
  store: ClaimStore,
  input: { ticketIds: readonly string[]; emailHashes: ReadonlySet<string>; now: number },
  caps: ClaimCaps,
): Outcome<Ticket[]> {
  return store.change((state) => {
    const own = ownTickets(state, input.ticketIds, input.emailHashes);
    if (!own.ok) return own;
    const refused: Ticket[] = [];
    for (const ticket of own.value) {
      const step = advance(state, ticket.ticketId, "open", (current) =>
        current.state !== "open" ? current : { ...current, state: "refused", closedAt: input.now },
      );
      if (!step.ok) return step;
      refused.push(step.value);
      if (!isMuted(state, ticket.emailHash, ticket.keyHash)) {
        if (state.muted.length >= caps.muted) return { ok: false, reason: "full" };
        state.muted.push({ emailHash: ticket.emailHash, keyHash: ticket.keyHash, platformName: ticket.platformName, mutedAt: input.now });
      }
      state.standing = state.standing.filter((one) => !(one.emailHash === ticket.emailHash && one.keyHash === ticket.keyHash));
      const tally = tallyOf(state, ticket.keyHash);
      tally.refused += 1;
      if (tally.closedAt === null && tally.refused >= caps.refusalFloor && tally.refused * caps.refusalShare > tally.written) {
        tally.closedAt = input.now;
      }
    }
    return { ok: true, value: { state, result: refused } };
  });
}

/** Removes the caller's mutes for one platform. Answers how many went, which may be none. */
export function unmute(store: ClaimStore, emailHashes: ReadonlySet<string>, keyHash: string): Outcome<number> {
  return store.change((state) => {
    const before = state.muted.length;
    state.muted = state.muted.filter((one) => !(emailHashes.has(one.emailHash) && one.keyHash === keyHash));
    return { ok: true, value: { state, result: before - state.muted.length } };
  });
}

/** Clears the caller's standing destination for one platform. Answers how many went, which may be none. */
export function clearStanding(store: ClaimStore, emailHashes: ReadonlySet<string>, keyHash: string): Outcome<number> {
  return store.change((state) => {
    const before = state.standing.length;
    state.standing = state.standing.filter((one) => !(emailHashes.has(one.emailHash) && one.keyHash === keyHash));
    return { ok: true, value: { state, result: before - state.standing.length } };
  });
}

/** The platform's worker gave up on a delivery (P34): accepted moves to failed, for this key's ticket only. */
export function markFailed(store: ClaimStore, ticketId: string, keyHash: string, now: number): Outcome<Ticket> {
  return store.change((state) => {
    const ticket = state.tickets.find((one) => one.ticketId === ticketId);
    if (ticket === undefined || ticket.keyHash !== keyHash) return { ok: false, reason: "not-found" };
    if (ticket.state !== "accepted") return { ok: false, reason: "not-accepted" };
    const step = advance(state, ticketId, "accepted", (current) =>
      current.state !== "accepted" ? current : { ...current, state: "failed", closedAt: now },
    );
    if (!step.ok) return step;
    return { ok: true, value: { state, result: step.value } };
  });
}

/** Removes closed tickets that closed more than KEEP_CLOSED_SECONDS ago and are past their lifetime. */
export function pruneClosed(store: ClaimStore, chainNow: number): Outcome<number> {
  return store.change((state) => {
    const before = state.tickets.length;
    state.tickets = state.tickets.filter(
      (ticket) =>
        !isTerminal(ticket.state) || ticket.closedAt === null || ticket.closedAt + KEEP_CLOSED_SECONDS >= chainNow || ticket.expiresAt >= chainNow,
    );
    return { ok: true, value: { state, result: before - state.tickets.length } };
  });
}
