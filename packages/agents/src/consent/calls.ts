import { encodeFunctionData, getAddress, type Hex } from "viem";
import { consentAbi } from "./abi.js";
import type { Plan, PlanEntry } from "./plan.js";
import {
  consentValues,
  matchesStatement,
  MAX_BATCH,
  type OnChainEntry,
  type Statement,
} from "./statements.js";

const NOBODY = "0x0000000000000000000000000000000000000000" as Hex;

/** What the chain said about every passport in the plan, read before any of this is decided. */
export interface ChainView {
  /** The wallet that will write. Only what this address holds may be spoken for. */
  wallet: Hex;
  /** Who holds each passport right now, the zero address when the registry knows no holder. */
  holders: Map<Hex, Hex>;
  /** The newest statement each passport carries, missing when nobody has spoken for it. */
  latest: Map<Hex, OnChainEntry>;
}

export interface PlannedRow {
  passportId: Hex;
  statement: string;
  holder: Hex;
  /** send when the chain does not already say this, skip when it does. */
  action: "send" | "skip";
}

export interface BatchCall {
  statement: Statement;
  passportIds: Hex[];
  data: Hex;
}

export interface PlannedWork {
  rows: PlannedRow[];
  calls: BatchCall[];
}

/** The plan names a passport this wallet does not hold, so nothing is built and nothing is sent. */
export class NotTheHolder extends Error {
  readonly refused: { passportId: Hex; holder: Hex }[];

  constructor(wallet: Hex, refused: { passportId: Hex; holder: Hex }[]) {
    const lines = refused.map(
      (one) => `  ${one.passportId} is held by ${one.holder === NOBODY ? "nobody on this registry" : one.holder}`,
    );
    super(`${wallet} does not hold every passport in the plan, so none of it can be sent:\n${lines.join("\n")}`);
    this.name = "NotTheHolder";
    this.refused = refused;
  }
}

/**
 * Turns the plan and what the chain says into the exact calls to send.
 *
 * Three things happen in order, and the order is the point. Authority first: a passport the wallet
 * does not hold stops the whole run, because setConsentBatch is all or nothing and one refused
 * passport would revert the batch it travels in. Then the passports whose newest entry already
 * says what the plan says are dropped, which is what makes a second run send nothing. What is left
 * is grouped by identical statement and cut into batches of at most MAX_BATCH.
 *
 * Throws NotTheHolder, naming every passport that is not the wallet's and who holds it instead.
 */
export function planWork(plan: Plan, chain: ChainView, maxBatch: number = MAX_BATCH): PlannedWork {
  if (maxBatch < 1 || maxBatch > MAX_BATCH) {
    throw new Error(`A batch holds between 1 and ${MAX_BATCH} passports, not ${maxBatch}.`);
  }

  const wallet = getAddress(chain.wallet);
  const refused: { passportId: Hex; holder: Hex }[] = [];
  for (const entry of plan.entries) {
    const holder = chain.holders.get(entry.passportId) ?? NOBODY;
    if (holder === NOBODY || getAddress(holder) !== wallet) {
      refused.push({ passportId: entry.passportId, holder });
    }
  }
  if (refused.length > 0) {
    throw new NotTheHolder(wallet, refused);
  }

  const rows: PlannedRow[] = [];
  const toSend: PlanEntry[] = [];
  for (const entry of plan.entries) {
    const current = chain.latest.get(entry.passportId);
    const already = current !== undefined && matchesStatement(current, entry.statement);
    rows.push({
      passportId: entry.passportId,
      statement: entry.statement.name,
      holder: chain.holders.get(entry.passportId) ?? NOBODY,
      action: already ? "skip" : "send",
    });
    if (!already) toSend.push(entry);
  }

  return { rows, calls: batches(toSend, maxBatch) };
}

/** Groups by identical statement, in the order the plan first names each one, then cuts to size. */
function batches(entries: PlanEntry[], maxBatch: number): BatchCall[] {
  const grouped = new Map<string, { statement: Statement; passportIds: Hex[] }>();
  for (const entry of entries) {
    const group = grouped.get(entry.statement.name);
    if (group) group.passportIds.push(entry.passportId);
    else grouped.set(entry.statement.name, { statement: entry.statement, passportIds: [entry.passportId] });
  }

  const calls: BatchCall[] = [];
  for (const group of grouped.values()) {
    for (let start = 0; start < group.passportIds.length; start += maxBatch) {
      const passportIds = group.passportIds.slice(start, start + maxBatch);
      calls.push({ statement: group.statement, passportIds, data: batchCalldata(group.statement, passportIds) });
    }
  }
  return calls;
}

/**
 * The calldata for one setConsentBatch call: the passports, the four values as the contract's enum
 * numbers, and the constraint text, which is empty unless a use is constrained.
 */
export function batchCalldata(statement: Statement, passportIds: Hex[]): Hex {
  if (passportIds.length === 0 || passportIds.length > MAX_BATCH) {
    throw new Error(`A batch holds between 1 and ${MAX_BATCH} passports, not ${passportIds.length}.`);
  }
  return encodeFunctionData({
    abi: consentAbi(),
    functionName: "setConsentBatch",
    args: [passportIds, consentValues(statement.consent), statement.constraintInfo],
  });
}
