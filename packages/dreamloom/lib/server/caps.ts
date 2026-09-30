import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { env } from "./env";
import { writeAtomic } from "./store";

/**
 * The daily caps on everything that costs Dreamloom or Moolam money (D1): weaves per address and in
 * all, platform registrations, moves and co-signs, counted in one file on the volume and reset at
 * the start of each UTC day. A count is taken before the spend and handed back only when the spend
 * provably did not happen.
 */

export type Action = "weave" | "register" | "move" | "cosign";

const COUNTERS_FILE = "counters.json";

const countersSchema = z.strictObject({
  version: z.literal(1),
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  weave: z.number().int().nonnegative(),
  register: z.number().int().nonnegative(),
  move: z.number().int().nonnegative(),
  cosign: z.number().int().nonnegative(),
  /** Weaves per address, keyed by a hash so the file holds no visitor addresses. */
  byAddress: z.record(z.string().regex(/^[0-9a-f]{32}$/), z.number().int().positive()),
});

type Counters = z.infer<typeof countersSchema>;

/** What a take hands back so the count can be returned to the day it came from. */
export interface Ticket {
  action: Action;
  day: string;
  addressKey?: string;
}

export type TakeResult =
  | { ok: true; ticket: Ticket }
  | { ok: false; refusal: "closed" }
  | { ok: false; refusal: "limit"; scope: "address" | "day" }
  /** The counters file exists but cannot be believed, so nothing is spent until someone looks. */
  | { ok: false; refusal: "busy" };

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function countersPath(): string {
  return path.join(env().dataDir, COUNTERS_FILE);
}

function fresh(day: string): Counters {
  return { version: 1, day, weave: 0, register: 0, move: 0, cosign: 0, byAddress: {} };
}

/** Today's counters, a fresh set when the file is missing or from another day, or null when it is unreadable. */
function load(day: string): Counters | null {
  let raw: string;
  try {
    raw = readFileSync(countersPath(), "utf8");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? fresh(day) : null;
  }
  let parsed: Counters;
  try {
    const result = countersSchema.safeParse(JSON.parse(raw));
    if (!result.success) return null;
    parsed = result.data;
  } catch {
    return null;
  }
  return parsed.day === day ? parsed : fresh(day);
}

function save(counters: Counters): void {
  writeAtomic(countersPath(), `${JSON.stringify(counters)}\n`);
}

function addressKey(address: string): string {
  return createHash("sha256").update(`dreamloom-address:${address}`).digest("hex").slice(0, 32);
}

export function capOf(action: Action): number {
  const e = env();
  switch (action) {
    case "weave":
      return e.WEAVES_PER_DAY;
    case "register":
      return e.REGISTRATIONS_PER_DAY;
    case "move":
      return e.MOVES_PER_DAY;
    case "cosign":
      return e.COSIGNS_PER_DAY;
  }
}

/** Whether an action is switched off: a cap of 0 closes it. */
export function isClosed(action: Action): boolean {
  return capOf(action) === 0 || (action === "weave" && env().WEAVES_PER_ADDRESS_PER_DAY === 0);
}

/**
 * Counts one use of `action` for today, before the spend. A weave also counts against `address`.
 * The read, the check and the write run with no await between them, so two requests cannot both
 * take the last slot.
 */
export function take(action: Action, address?: string): TakeResult {
  if (isClosed(action)) return { ok: false, refusal: "closed" };
  const day = today();
  const counters = load(day);
  if (counters === null) return { ok: false, refusal: "busy" };

  const ticket: Ticket = { action, day };
  if (action === "weave") {
    const key = addressKey(address ?? "unknown");
    if ((counters.byAddress[key] ?? 0) >= env().WEAVES_PER_ADDRESS_PER_DAY) {
      return { ok: false, refusal: "limit", scope: "address" };
    }
    if (counters.weave >= capOf("weave")) {
      return { ok: false, refusal: "limit", scope: "day" };
    }
    counters.byAddress[key] = (counters.byAddress[key] ?? 0) + 1;
    ticket.addressKey = key;
  } else if (counters[action] >= capOf(action)) {
    return { ok: false, refusal: "limit", scope: "day" };
  }
  counters[action] += 1;
  save(counters);
  return { ok: true, ticket };
}

/**
 * Hands a count back, for a spend that provably did not happen: a prompt the model refused, or a
 * request refused before anything was sent. A ticket from an earlier day returns nothing, because
 * that day's counters are already gone.
 */
export function giveBack(ticket: Ticket): void {
  const day = today();
  if (ticket.day !== day) return;
  const counters = load(day);
  if (counters === null) return;
  counters[ticket.action] = Math.max(0, counters[ticket.action] - 1);
  if (ticket.addressKey !== undefined) {
    const left = (counters.byAddress[ticket.addressKey] ?? 0) - 1;
    if (left > 0) counters.byAddress[ticket.addressKey] = left;
    else delete counters.byAddress[ticket.addressKey];
  }
  save(counters);
}
