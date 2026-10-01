import type { EvmOnEventContext } from "envio";
import { GLOBAL_STATS_ID, dayId } from "./ids.js";

export type DailyDelta = {
  registrations?: number;
  edits?: number;
  attestations?: number;
  disputes?: number;
  uniqueCreators?: number;
  consentStatements?: number;
};

export type GlobalDelta = {
  passports?: number;
  creators?: number;
  generators?: number;
  attestations?: number;
  networkAttestations?: number;
  disputes?: number;
  consentStatements?: number;
  passportsWithConsent?: number;
};

/// Adds to the counters for the UTC day the block landed in, creating the row on
/// the first event of that day.
///
/// Read then write, never a counter held in a module variable: the preload phase
/// runs every handler twice and throws the first run's writes away, so any total
/// kept outside the database would be counted twice.
export async function bumpDaily(
  context: EvmOnEventContext,
  blockTimestampSeconds: number,
  delta: DailyDelta,
): Promise<void> {
  const id = dayId(blockTimestampSeconds);
  const row = await context.DailyStats.getOrCreate({
    id,
    registrations: 0,
    edits: 0,
    attestations: 0,
    disputes: 0,
    uniqueCreators: 0,
    consentStatements: 0,
  });

  context.DailyStats.set({
    id,
    registrations: row.registrations + (delta.registrations ?? 0),
    edits: row.edits + (delta.edits ?? 0),
    attestations: row.attestations + (delta.attestations ?? 0),
    disputes: row.disputes + (delta.disputes ?? 0),
    uniqueCreators: row.uniqueCreators + (delta.uniqueCreators ?? 0),
    consentStatements: row.consentStatements + (delta.consentStatements ?? 0),
  });
}

/// Records that this creator was active on the day the block landed in, and says
/// whether that is the first time today.
///
/// The marker row is the only way to count distinct creators per day: a counter
/// alone cannot tell a returning creator from a new one, and reading every
/// passport of the day back would grow with the day's traffic. The row is written
/// once and never updated, so the preload phase's doubled run cannot double-count.
export async function markCreatorActive(
  context: EvmOnEventContext,
  blockTimestampSeconds: number,
  creatorId: string,
): Promise<boolean> {
  const id = `${dayId(blockTimestampSeconds)}-${creatorId}`;
  const seen = await context.CreatorDay.get(id);
  if (seen !== undefined) {
    return false;
  }
  context.CreatorDay.set({ id });
  return true;
}

/// Adds to the single row of running totals for the whole index.
export async function bumpGlobal(
  context: EvmOnEventContext,
  delta: GlobalDelta,
): Promise<void> {
  const row = await context.GlobalStats.getOrCreate({
    id: GLOBAL_STATS_ID,
    passports: 0,
    creators: 0,
    generators: 0,
    attestations: 0,
    networkAttestations: 0,
    disputes: 0,
    consentStatements: 0,
    passportsWithConsent: 0,
  });

  context.GlobalStats.set({
    id: GLOBAL_STATS_ID,
    passports: row.passports + (delta.passports ?? 0),
    creators: row.creators + (delta.creators ?? 0),
    generators: row.generators + (delta.generators ?? 0),
    attestations: row.attestations + (delta.attestations ?? 0),
    networkAttestations: row.networkAttestations + (delta.networkAttestations ?? 0),
    disputes: row.disputes + (delta.disputes ?? 0),
    consentStatements: row.consentStatements + (delta.consentStatements ?? 0),
    passportsWithConsent: row.passportsWithConsent + (delta.passportsWithConsent ?? 0),
  });
}
