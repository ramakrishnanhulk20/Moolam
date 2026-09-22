import { formatMon, type Config } from "./config.js";
import type { Document } from "./document.js";
import { isRealPicture } from "./document.js";
import type { IndexClient, PassportRow } from "./index-read.js";
import { cut } from "./net.js";
import type { QueueClient } from "./queue.js";
import type { SimulateRequest, SimulateResult } from "./simulate.js";
import { inCooldown, noteRecent, rollDay, type RunnerState } from "./state.js";

export type Log = (message: string) => void;

export interface Deps {
  config: Config;
  queue: QueueClient;
  index: IndexClient;
  readDocument: (metadataURI: string) => Promise<Document>;
  eventIndex: (txHash: string, passportId: string) => Promise<number>;
  balanceWei: () => Promise<bigint>;
  simulate: (request: SimulateRequest) => Promise<SimulateResult>;
  readState: () => RunnerState;
  writeState: (state: RunnerState) => void;
  log: Log;
  /** Epoch milliseconds. Injected so a test can hold a whole pass at one moment. */
  now: () => number;
}

export interface PassSummary {
  considered: number;
  ran: number;
  done: number;
  failed: number;
  /** Why the pass stopped early, when it did. */
  stopped?: string;
}

/** Where a candidate came from. A request is a person waiting; a sweep is housekeeping. */
type Source = "queue" | "sweep";

interface Candidate {
  passportId: string;
  source: Source;
  /** The row the sweep already read, so the same passport is not asked for twice. */
  row?: PassportRow;
}

interface Outcome {
  state: RunnerState;
  ran: boolean;
  succeeded: boolean;
  /**
   * True when this passport should be left alone for the cooldown. A passport skipped for a
   * reason that will change on its own, an empty wallet or a claim somebody else holds, is not
   * marked, because the next pass should try it again.
   */
  settled: boolean;
  stopped?: string;
}

/**
 * One pass of the runner.
 *
 * Requests come first and the sweep second. Everything that could spend money is checked again
 * immediately before each run rather than once at the top: a pass can take minutes, and the wallet
 * it spends from is the same one the passport before it just drew on.
 */
export async function onePass(deps: Deps): Promise<PassSummary> {
  const { config, log } = deps;
  const nowMs = deps.now();
  let state = rollDay(deps.readState(), nowMs);

  if (state.backoffUntil > seconds(nowMs)) {
    const left = state.backoffUntil - seconds(nowMs);
    return halt(`backing off for another ${Math.ceil(left / 60)} minutes after ${state.failures} failures in a row`);
  }
  if (state.reports >= config.maxReportsPerDay) {
    return halt(`the daily cap of ${config.maxReportsPerDay} reports is used up for ${state.day}`);
  }

  const candidates = await gather(deps, state, nowMs);
  const summary: PassSummary = { considered: candidates.length, ran: 0, done: 0, failed: 0 };

  for (const candidate of candidates) {
    if (state.reports >= config.maxReportsPerDay) {
      summary.stopped = `the daily cap of ${config.maxReportsPerDay} reports is used up`;
      log(summary.stopped);
      break;
    }

    // One passport that throws, because the index went down mid-pass or a node refused, must not
    // take the pass with it. It is not marked handled, because whatever broke will probably come
    // back, but it does count towards the backoff so an outage is sat out rather than hammered.
    let outcome: Outcome;
    try {
      outcome = await handle(deps, candidate, state);
    } catch (error) {
      log(`passport ${candidate.passportId.slice(0, 12)} could not be handled: ${message(error)}`);
      const failures = state.failures + 1;
      outcome = { state: { ...state, failures }, ran: false, succeeded: false, settled: false };
      if (failures >= config.failuresBeforeBackoff) {
        outcome.state = { ...outcome.state, backoffUntil: Math.floor(deps.now() / 1000) + config.backoffMinutes * 60 };
        outcome.stopped = `${failures} failures in a row, backing off for ${config.backoffMinutes} minutes`;
        log(outcome.stopped);
      }
    }

    state = outcome.settled ? noteRecent(outcome.state, candidate.passportId, deps.now()) : outcome.state;
    deps.writeState(state);

    if (outcome.ran) {
      summary.ran += 1;
      if (outcome.succeeded) {
        summary.done += 1;
      } else {
        summary.failed += 1;
      }
    }
    if (outcome.stopped !== undefined) {
      summary.stopped = outcome.stopped;
      break;
    }
  }

  return summary;

  function halt(reason: string): PassSummary {
    log(reason);
    return { considered: 0, ran: 0, done: 0, failed: 0, stopped: reason };
  }
}

async function handle(deps: Deps, candidate: Candidate, entering: RunnerState): Promise<Outcome> {
  const { config, log } = deps;
  const short = candidate.passportId.slice(0, 12);
  let state = entering;

  // A request is claimed before anything else is spent on it, because the queue is what decides
  // who is running which passport. A sweep candidate has nothing to claim yet, so its claim is
  // attempted later, just before the run, and only to catch a request that came in meanwhile.
  let reportBack = false;
  if (candidate.source === "queue") {
    const claim = await deps.queue.claim(candidate.passportId);
    if (claim !== "claimed") {
      log(`passport ${short} could not be claimed (${claim}), leaving it on the queue`);
      return skip();
    }
    reportBack = true;
  }

  const row = candidate.row ?? (await deps.index.byId(candidate.passportId));
  if (row === null || row.txHash === "") {
    return await refuse(`passport ${short} is not in the index yet, so its registration cannot be found`);
  }
  if (row.attestationCount > 0) {
    return await refuse(`passport ${short} already carries ${row.attestationCount} re-check(s)`);
  }

  const document = await deps.readDocument(row.metadataURI);
  if (document.sealed) {
    return await refuse(`passport ${short} is sealed, so there is no published picture to re-check`);
  }
  if (candidate.source === "sweep" && !isRealPicture(document)) {
    log(`passport ${short} is a seed test card or has no readable document, not sweeping it`);
    return settle();
  }

  const balance = await deps.balanceWei();
  if (balance < config.minMonWei) {
    const reason = `the CRE wallet holds ${formatMon(balance)} MON, under the floor of ${formatMon(config.minMonWei)}`;
    log(`stopping: ${reason}`);
    return { state, ran: false, succeeded: false, settled: false, stopped: reason };
  }

  if (candidate.source === "sweep") {
    const claim = await deps.queue.claim(candidate.passportId);
    if (claim === "taken") {
      log(`passport ${short} is already being run by somebody else`);
      return skip();
    }
    reportBack = claim === "claimed";
  }

  let at: number;
  try {
    at = await deps.eventIndex(row.txHash, candidate.passportId);
  } catch (error) {
    return await refuse(`passport ${short}: ${message(error)}`);
  }

  if (config.dryRun) {
    log(
      `dry run: passport ${short} would be re-checked from tx ${row.txHash.slice(0, 12)} event ${at}, asked for by the ${candidate.source}`,
    );
  } else {
    // The spend is written down before it happens, so a machine that dies mid-run comes back
    // having already counted it rather than with the day's budget handed back.
    state = { ...state, reports: state.reports + 1 };
    deps.writeState(state);
  }

  const result = await deps.simulate({
    workflowDir: config.workflowDir,
    envFile: config.envFile,
    target: config.target,
    txHash: row.txHash,
    eventIndex: at,
    broadcast: !config.dryRun,
    timeoutMs: config.simulateTimeoutMs,
  });

  if (result.ok) {
    state = { ...state, failures: 0 };
    const wrote = result.reportTx === undefined ? "nothing written, this was a dry run" : `report ${result.reportTx}`;
    log(
      `passport ${short} tx ${row.txHash.slice(0, 12)} event ${at} -> ${wrote}, recomputed ${result.recomputed ?? "unread"} distance ${result.distance ?? "unread"} matched ${result.matched ?? "unread"}`,
    );
    if (reportBack && !config.dryRun) {
      await tell({
        passportId: candidate.passportId,
        ...(result.reportTx === undefined ? {} : { reportTx: result.reportTx }),
        ...(result.matched === undefined ? {} : { matched: result.matched }),
        ...(result.distance === undefined ? {} : { distance: result.distance }),
      });
    }
    return { state, ran: true, succeeded: true, settled: true };
  }

  state = { ...state, failures: state.failures + 1 };
  const reason = result.reason ?? "the simulation did not finish";
  log(`passport ${short} failed: ${reason}`);
  if (reportBack && !config.dryRun) {
    await tell({ passportId: candidate.passportId, reason });
  }

  if (state.failures >= config.failuresBeforeBackoff) {
    state = { ...state, backoffUntil: seconds(deps.now()) + config.backoffMinutes * 60 };
    const stopped = `${state.failures} failures in a row, backing off for ${config.backoffMinutes} minutes`;
    log(stopped);
    return { state, ran: true, succeeded: false, settled: true, stopped };
  }
  return { state, ran: true, succeeded: false, settled: true };

  function skip(): Outcome {
    return { state, ran: false, succeeded: false, settled: false };
  }

  function settle(): Outcome {
    return { state, ran: false, succeeded: false, settled: true };
  }

  async function refuse(reason: string): Promise<Outcome> {
    log(reason);
    if (reportBack && !config.dryRun) {
      await tell({ passportId: candidate.passportId, reason: cut(reason, 200) });
    }
    return settle();
  }

  async function tell(report: Parameters<QueueClient["done"]>[0]): Promise<void> {
    try {
      await deps.queue.done(report);
    } catch (error) {
      log(`could not report back to the queue: ${message(error)}`);
    }
  }
}

/**
 * The passports this pass will look at: everything asked for, then the newest pictures nothing has
 * re-checked. A passport handled inside the cooldown is left out of both, which is what stops one
 * the index has not caught up on from being run twice.
 */
async function gather(deps: Deps, state: RunnerState, nowMs: number): Promise<Candidate[]> {
  const { config, log } = deps;
  const candidates: Candidate[] = [];
  const seen = new Set<string>();

  const add = (passportId: string, source: Source, row?: PassportRow): void => {
    const id = passportId.toLowerCase();
    if (seen.has(id) || inCooldown(state, id, nowMs, config.cooldownSeconds)) {
      return;
    }
    seen.add(id);
    candidates.push(row === undefined ? { passportId: id, source } : { passportId: id, source, row });
  };

  try {
    for (const passportId of await deps.queue.pending()) {
      add(passportId, "queue");
    }
  } catch (error) {
    log(`could not read the request queue: ${message(error)}`);
  }

  if (candidates.length < config.maxPerPass) {
    try {
      const before = seconds(nowMs) - config.settleSeconds;
      for (const row of await deps.index.unrechecked(before, config.maxPerPass)) {
        add(row.id, "sweep", row);
      }
    } catch (error) {
      log(`could not read the index: ${message(error)}`);
    }
  }

  return candidates.slice(0, config.maxPerPass);
}

function seconds(nowMs: number): number {
  return Math.floor(nowMs / 1000);
}

export function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
