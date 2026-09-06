import type { HandlerContext } from "envio";
import { GLOBAL_STATS_ID, dayId } from "./ids.js";

export type DailyDelta = {
  registrations?: number;
  edits?: number;
  attestations?: number;
  disputes?: number;
  uniqueCreators?: number;
};

export type GlobalDelta = {
  passports?: number;
  creators?: number;
  generators?: number;
  attestations?: number;
  disputes?: number;
};

/// Adds to the counters for the UTC day the block landed in, creating the row on
/// the first event of that day.
///
/// Read then write, never a counter held in a module variable: the preload phase
/// runs every handler twice and throws the first run's writes away, so any total
/// kept outside the database would be counted twice.
export async function bumpDaily(
  context: HandlerContext,
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
  });

  context.DailyStats.set({
    id,
    registrations: row.registrations + (delta.registrations ?? 0),
    edits: row.edits + (delta.edits ?? 0),
    attestations: row.attestations + (delta.attestations ?? 0),
    disputes: row.disputes + (delta.disputes ?? 0),
    uniqueCreators: row.uniqueCreators + (delta.uniqueCreators ?? 0),
  });
}

/// Adds to the single row of running totals for the whole index.
export async function bumpGlobal(
  context: HandlerContext,
  delta: GlobalDelta,
): Promise<void> {
  const row = await context.GlobalStats.getOrCreate({
    id: GLOBAL_STATS_ID,
    passports: 0,
    creators: 0,
    generators: 0,
    attestations: 0,
    disputes: 0,
  });

  context.GlobalStats.set({
    id: GLOBAL_STATS_ID,
    passports: row.passports + (delta.passports ?? 0),
    creators: row.creators + (delta.creators ?? 0),
    generators: row.generators + (delta.generators ?? 0),
    attestations: row.attestations + (delta.attestations ?? 0),
    disputes: row.disputes + (delta.disputes ?? 0),
  });
}
