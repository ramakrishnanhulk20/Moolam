import { RegistrationError } from "./chain.js";
import { formatMon, type Config } from "./config.js";
import type { Document, PictureRead, RecordLookup } from "./document.js";
import { fingerprintSizeRefusal, isTestCard, readPicture, readUnsealRecord, withRecord } from "./document.js";
import type { IndexClient, PassportRow } from "./index-read.js";
import { cut } from "./net.js";
import { isTxHash, type DoneReport, type QueueClient } from "./queue.js";
import { SEALED_TOKEN_NAME, envFileValue, envFileValues, readSealedStatus, serviceHost, type CopyState } from "./sealed.js";
import { redact, scrubList, type SimulateRequest, type SimulateResult } from "./simulate.js";
import {
  clearBreaker,
  closureFor,
  inCooldown,
  isHeld,
  noteBreakerLanded,
  noteBreakerRefusal,
  noteClosed,
  noteHeld,
  noteRecent,
  noteRefusal,
  noteSent,
  noteWaiting,
  rollDay,
  sentFor,
  waitFor,
  type Closure,
  type RunnerState,
} from "./state.js";

export type Log = (message: string) => void;

export interface Deps {
  config: Config;
  queue: QueueClient;
  index: IndexClient;
  readDocument: (metadataURI: string) => Promise<Document>;
  /**
   * The picture the public workflow would fetch, read for its size before any spend (tally R12).
   * Left out, the configured gateway is asked under the workflow's own fetch rules.
   */
  readPicture?: (cid: string) => Promise<PictureRead>;
  /**
   * Whether a sealed passport's holder has published the picture since. Left out, the verify
   * service's own GET /unseal route is asked, at the address the queue already uses.
   */
  unsealRecord?: (passportId: string) => Promise<RecordLookup>;
  /**
   * Whether a privately re-checkable passport's copy is still kept. Left out, the verify service's
   * GET /sealed/status is asked, at the address the queue already uses.
   */
  sealedStatus?: (passportId: string) => Promise<CopyState>;
  /**
   * The CRE_SEALED_LINK_TOKEN value in the env file handed to the CLI, or null when it has none.
   * Left out, config.envFile is read. The value is used only to strip it out of reasons.
   */
  sealedToken?: () => string | null;
  /**
   * Every value that must never reach a log line or a posted reason (R11). Left out, the config's
   * own token and addresses and every value in config.envFile, read once a pass.
   */
  secrets?: () => string[];
  eventIndex: (txHash: string, passportId: string) => Promise<number>;
  /**
   * Whether a broadcast report put its verdict into the registry for this passport. Its receipt,
   * not the CLI's word or the transaction's status, is what makes a run done.
   */
  reportLanded: (reportTx: string, passportId: string) => Promise<boolean>;
  balanceWei: () => Promise<bigint>;
  simulate: (request: SimulateRequest) => Promise<SimulateResult>;
  readState: () => RunnerState;
  writeState: (state: RunnerState) => void;
  log: Log;
  /** Epoch milliseconds. Injected so a test can hold a whole pass at one moment. */
  now: () => number;
  /**
   * True once a stop signal came in (tally R10). Read between passports and again just before a
   * claim, so a stop never starts new work; a run already sending finishes and hands back.
   */
  stopping?: () => boolean;
}

export interface PassSummary {
  considered: number;
  ran: number;
  done: number;
  failed: number;
  /** Requests answered from what the runner already knew, with no run. */
  answered: number;
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

/** A request answered from memory: the passport was settled, re-checked or run too recently. */
interface Answer {
  passportId: string;
  report: Omit<DoneReport, "passportId">;
}

interface Outcome {
  state: RunnerState;
  ran: boolean;
  succeeded: boolean;
  stopped?: string;
}

/** Requests answered from memory in one pass. Each costs a claim and a done on the verify service. */
const ANSWERS_PER_PASS = 20;

/**
 * Passing misses in a row after which a waiting request is answered rather than left on the queue.
 * A request is left waiting through a gateway blip, and answered once it plainly is not one, so a
 * page of fifty requests that never read cannot hide a newer one for long (tally R6).
 */
const MISSES_BEFORE_ANSWER = 3;

/** Refused reports after which a passport is settled: the receiver will refuse the next one too (tally R4). */
const REFUSALS_BEFORE_CLOSING = 2;

/**
 * The most ids the sweep's query leaves out by name, newest first. About 70 bytes each, so the
 * query stays under 70 KB. Past it, an older settled passport can take a place in the page again;
 * it is dropped by the same memory once read, so it costs a slot for a pass, never a run.
 */
const MOST_EXCLUDED = 1_000;

const STOP_SIGNAL = "a stop signal came in, so the pass ends here";

/**
 * Whether a failed run's reason may change by itself (tally R5): a timeout, a server that did not
 * answer, a 429 or a 5xx, the runner's own time limit. Anything else, a 404, a refusal under the
 * workflow's own rules, a decode error, is final for that run and waits out the cooldown. It reads
 * the words the simulator and the workflows print, so a failure worded some new way counts as
 * final, which costs a longer wait and never a sooner paid run.
 */
const PASSING =
  /\b(did not answer|timed? ?out|timeout|deadline exceeded|still running after|(status|answered) (429|5\d\d)|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|fetch failed|socket hang up|too many requests)\b/i;

export function isPassingFailure(reason: string): boolean {
  return PASSING.test(reason);
}

/**
 * One pass of the runner.
 *
 * Requests the runner can answer from memory are answered first, then requests are run, then the
 * sweep fills the rest of the pass. Everything that could spend money is checked again immediately
 * before each run rather than once at the top: a pass can take minutes, and the wallet it spends
 * from is the same one the passport before it just drew on.
 */
export async function onePass(given: Deps): Promise<PassSummary> {
  const secrets = (given.secrets ?? (() => secretValues(given.config)))();
  // Every line this pass writes goes through the same filter as a posted reason (R11).
  const deps: Deps = { ...given, secrets: () => secrets, log: (line) => given.log(redact(line, secrets)) };
  const { config, log } = deps;
  const nowMs = deps.now();
  let state = rollDay(deps.readState(), nowMs);

  // The kill switch comes before everything else: tripped, the pass reads nothing, answers
  // nothing and spends nothing, and says so once a pass until the operator clears it.
  if (state.breaker.tripped !== null) {
    return halt(breakerLine(state.breaker.tripped));
  }
  if (state.backoffUntil > seconds(nowMs)) {
    const left = state.backoffUntil - seconds(nowMs);
    return halt(`backing off for another ${Math.ceil(left / 60)} minutes after ${state.failures} failures in a row`);
  }
  if (capUsed(state, config.maxReportsPerDay)) {
    return halt(`the daily cap of ${config.maxReportsPerDay} reports is used up for ${state.day}`);
  }

  const { answers, candidates } = await gather(deps, state, nowMs);
  const summary: PassSummary = { considered: candidates.length, ran: 0, done: 0, failed: 0, answered: 0 };

  for (const answer of answers) {
    if (deps.stopping?.() === true) {
      summary.stopped = STOP_SIGNAL;
      log(summary.stopped);
      return summary;
    }
    if (await respond(deps, answer.passportId, answer.report, secrets)) {
      summary.answered += 1;
    }
  }

  for (const candidate of candidates) {
    if (deps.stopping?.() === true) {
      summary.stopped = STOP_SIGNAL;
      log(summary.stopped);
      break;
    }
    if (capUsed(state, config.maxReportsPerDay)) {
      summary.stopped = `the daily cap of ${config.maxReportsPerDay} reports is used up`;
      log(summary.stopped);
      break;
    }

    // One passport that throws, because the index went down mid-pass or a node refused, must not
    // take the pass with it. It waits a short while, since whatever broke will probably come back,
    // and it counts towards the backoff so an outage is sat out rather than hammered. The state is
    // read back rather than taken from before the throw, because a spend written down before the
    // simulator started must stay counted.
    let outcome: Outcome;
    try {
      outcome = await handle(deps, candidate, state);
    } catch (error) {
      const reason = redact(message(error), secrets);
      log(`passport ${candidate.passportId.slice(0, 12)} could not be handled: ${reason}`);
      const latest = rollDay(deps.readState(), deps.now());
      const failures = latest.failures + 1;
      const waited = noteWaiting(latest, candidate.passportId, `it could not be handled: ${cut(reason, 160)}`, deps.now(), config.retrySeconds, config.cooldownSeconds);
      outcome = backedOff(deps, { state: { ...waited, failures }, ran: false, succeeded: false });
    }

    state = outcome.state;
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
    return { considered: 0, ran: 0, done: 0, failed: 0, answered: 0, stopped: reason };
  }
}

/**
 * One passport, from the first read to the one hand-back its claim is owed.
 *
 * Every read that can end the passport's turn comes before the claim: the index row, the document,
 * the unseal record or the private copy's state, the picture, the wallet, the registration receipt.
 * So a request is claimed only when the run is about to spend, and from the claim on every exit,
 * a throw included, hands it back exactly once (tally R1). A dry run claims nothing (tally R7).
 */
async function handle(deps: Deps, candidate: Candidate, entering: RunnerState): Promise<Outcome> {
  const { config } = deps;
  const passportId = candidate.passportId;
  const short = passportId.slice(0, 12);
  const fromQueue = candidate.source === "queue";
  let state = entering;

  // Stripped from every reason and every line before it is logged, posted or stored: the pass's
  // secrets, the service's host here, and the sealed link token once a sealed run has read it.
  const scrub: string[] = [...(deps.secrets?.() ?? [])];
  const log: Log = (line) => deps.log(redact(line, scrub));
  const host = serviceHost(config.verifyServiceUrl);
  if (host !== null) {
    scrub.push(host);
  }

  // The runner's own record of a report it sent comes before anything the index says, so a stale
  // index row reading zero attestations cannot buy a second report (tally R11).
  const earlier = sentFor(state, passportId, deps.now());
  if (earlier !== undefined && earlier.landed !== false) {
    const tx = earlier.tx.slice(0, 12);
    let landed: boolean | null = earlier.landed;
    if (landed === null) {
      try {
        landed = await deps.reportLanded(earlier.tx, passportId);
      } catch (error) {
        return await wait(`the receipt of its earlier report ${tx} could not be read yet (${message(error)})`);
      }
      state = noteSent(state, passportId, { ...earlier, landed });
      state = landed ? noteBreakerLanded(state) : noteBreakerRefusal(state, passportId, deps.now());
    }
    if (landed) {
      log(`passport ${short} already carries this runner's report ${tx}, so it is not run again`);
      if (fromQueue) {
        await respond(deps, passportId, { reportTx: earlier.tx }, scrub);
      }
      return { state, ran: false, succeeded: false };
    }
    // Read now for the first time: the report did not land, which is a refusal like any other.
    const refusals = noteRefusal(state, passportId);
    state = refusals.state;
    if (refusals.count >= REFUSALS_BEFORE_CLOSING) {
      return tripping(await close(`the receiver refused ${refusals.count} reports for it, so another would not land either`));
    }
    const reason = `passport ${short}'s earlier report ${tx} was mined but the registry recorded no attestation for it, so the receiver refused it`;
    log(reason);
    state = noteRecent(state, passportId, deps.now());
    if (fromQueue) {
      await respond(deps, passportId, { reason }, scrub);
    }
    return tripping({ state, ran: false, succeeded: false });
  }

  const row = candidate.row ?? (await deps.index.byId(passportId));
  if (row === null || row.txHash === "") {
    return await wait("it is not in the index yet, so its registration cannot be found");
  }
  if (!isTxHash(row.txHash)) {
    // The hash goes to the node and then onto the CLI's argv, so a malformed one stops here, before
    // anything is read or counted, and the reason never repeats it.
    return await close("it has a registration transaction in the index that is not 0x and 64 hex digits, so it is not run");
  }
  if (row.attestationCount > 0) {
    return await close(`it already carries ${row.attestationCount} re-check(s)`);
  }

  let document = await deps.readDocument(row.metadataURI);
  if (document.refused !== undefined) {
    // The workflow applies the same rule and would refuse it too, so nothing is spent on a run.
    return await close(document.refused);
  }
  if (!document.readable) {
    return await wait("its metadata document could not be read from the gateway");
  }
  if (!fromQueue && isTestCard(document.title)) {
    return await hold(`passport ${short} is a seed test card or has no title, not sweeping it`);
  }

  let privateRun = false;
  if (document.privateRecheck) {
    // The copy can be deleted at any moment and the document never says so, so its state is read
    // on every turn rather than remembered.
    const status = deps.sealedStatus ?? ((id: string) => readSealedStatus(config.verifyServiceUrl, id));
    const copy = await status(passportId);
    if (copy === "unknown") {
      return await wait("it asks for a private re-check and the state of its private copy could not be read");
    }
    if (copy === "gone") {
      log(`passport ${short} asked for a private re-check but its private copy is gone, so it is handled as a plain sealed passport`);
      document = { ...document, privateRecheck: false };
    } else {
      privateRun = true;
    }
  }
  if (document.sealed && !document.privateRecheck) {
    const lookup = deps.unsealRecord ?? ((id: string) => readUnsealRecord(config.verifyServiceUrl, id));
    const record = await lookup(passportId);
    if (record.kind === "failed") {
      return await wait(`it is sealed and its unseal record could not be read (${record.reason})`);
    }
    if (record.kind === "mismatch") {
      return await hold(`passport ${short} is sealed and the unseal record served for it names another passport`);
    }
    document = withRecord(document, record);
    if (document.sealed) {
      return await hold(`passport ${short} is sealed, so there is no published picture to re-check`);
    }
    log(`passport ${short} was registered sealed and its holder has published the picture since, re-checking it`);
  }

  let token: string | null = null;
  if (privateRun) {
    token = (deps.sealedToken ?? (() => envFileValue(config.envFile, SEALED_TOKEN_NAME)))();
    if (token === null) {
      return await hold(
        `passport ${short} asks for a private re-check and the env file handed to the CRE CLI has no ${SEALED_TOKEN_NAME}, so it is not run`,
      );
    }
    scrub.push(token);
  } else {
    if (document.picture === null) {
      return await hold(`passport ${short} has an unseal record that names no ipfs:// thumbnail, so there is no picture to fetch`);
    }
    const read = await (deps.readPicture ?? ((cid: string) => readPicture(cid, config.gatewayUrl)))(document.picture);
    if (read.kind === "missed") {
      return await wait(read.reason);
    }
    if (read.kind === "refused") {
      return await close(read.reason);
    }
    if (read.kind === "ok") {
      const tooSmall = fingerprintSizeRefusal(read.width, read.height);
      if (tooSmall !== null) {
        return await close(`its picture fails the fingerprint's size rule: ${tooSmall}`);
      }
    }
  }

  const balance = await deps.balanceWei();
  if (balance < config.minMonWei) {
    const reason = `the CRE wallet holds ${formatMon(balance)} MON, under the floor of ${formatMon(config.minMonWei)}`;
    log(`stopping: ${reason}`);
    return { state, ran: false, succeeded: false, stopped: reason };
  }

  let at: number;
  try {
    at = await deps.eventIndex(row.txHash, passportId);
  } catch (error) {
    if (error instanceof RegistrationError) {
      return await close(error.message);
    }
    return await wait(`its registration receipt could not be read (${message(error)})`);
  }

  if (deps.stopping?.() === true) {
    log(`passport ${short} is left for the next start: ${STOP_SIGNAL}`);
    return { state, ran: false, succeeded: false, stopped: STOP_SIGNAL };
  }

  if (config.dryRun) {
    return await dryRun(row.txHash, at);
  }

  // The claim, taken only now that the run is about to spend. A private run needs one of its own
  // for the service to mint its link, so a sweep candidate asks for a request first.
  let claimed = false;
  let personAsked = fromQueue;
  if (fromQueue || privateRun) {
    if (!fromQueue) {
      const placed = await deps.queue.request(passportId);
      if (placed === "sealed") {
        return await hold(`passport ${short} is sealed and the queue reads its private copy as gone, so there is nothing to re-check`);
      }
      if (placed === "failed") {
        return await wait("it could not be put on the queue for a private re-check");
      }
    }
    const claim = await deps.queue.claim(passportId);
    if (claim !== "claimed") {
      log(`passport ${short} could not be claimed (${claim}), leaving it on the queue`);
      return fromQueue ? { state, ran: false, succeeded: false } : await wait(`it could not be claimed for a private re-check (${claim})`);
    }
    claimed = true;
  } else {
    // A sweep candidate is claimed only to catch a request that came in meanwhile. A request
    // somebody else is running means skip; a finished one or none means run with nothing to tell.
    const claim = await deps.queue.claim(passportId);
    if (claim === "taken") {
      log(`passport ${short} is already being run by somebody else`);
      return { state, ran: false, succeeded: false };
    }
    claimed = claim === "claimed";
    personAsked = claimed;
  }

  let handedBack = !claimed;
  const handBack = async (report: Omit<DoneReport, "passportId">): Promise<void> => {
    if (handedBack) {
      return;
    }
    handedBack = true;
    await tell(report);
  };

  try {
    // The spend is written down before it happens, so a machine that dies mid-run comes back
    // having already counted it rather than with the day's budget handed back.
    state = { ...state, reports: state.reports + 1 };
    deps.writeState(state);

    const result = await deps.simulate({
      workflowDir: privateRun ? config.sealedWorkflowDir : config.workflowDir,
      envFile: config.envFile,
      target: config.target,
      txHash: row.txHash,
      eventIndex: at,
      broadcast: true,
      timeoutMs: config.simulateTimeoutMs,
      scrub,
    });

    if (!result.ok || result.reportTx === undefined) {
      const reason = result.reason ?? "the run wrote no report transaction";
      return isPassingFailure(reason) ? await passing(reason) : await final(reason);
    }

    // Transaction status is not the verdict: Chainlink's mock forwarder mines a report its receiver
    // refused with status 1. Only the registry's own attestation in that receipt makes the run done.
    const reportTx = result.reportTx;
    const tx = reportTx.slice(0, 12);
    let landed: boolean | null;
    try {
      landed = await deps.reportLanded(reportTx, passportId);
    } catch (error) {
      log(`the receipt of report ${tx} could not be read: ${message(error)}`);
      landed = null;
    }
    state = noteSent(state, passportId, { at: seconds(deps.now()), tx: reportTx, landed });

    if (landed === null) {
      return await passing(`report ${tx} was sent but its receipt could not be read yet, so it is checked again on a later pass before anything else`);
    }
    if (!landed) {
      return await refused(`report ${tx} was mined but the registry recorded no attestation for this passport, so the receiver refused it`);
    }

    state = noteBreakerLanded({ ...state, failures: 0 });
    log(
      `passport ${short} tx ${row.txHash.slice(0, 12)} event ${at} -> report ${reportTx}, recomputed ${result.recomputed ?? "unread"} distance ${result.distance ?? "unread"} matched ${result.matched ?? "unread"}`,
    );
    await handBack({
      reportTx,
      ...(result.matched === undefined ? {} : { matched: result.matched }),
      ...(result.distance === undefined ? {} : { distance: result.distance }),
    });
    return { state, ran: true, succeeded: true };
  } catch (error) {
    await handBack({ reason: "the simulation could not be run" });
    throw error;
  }

  /** A run that did not land for a reason that may change: back soon, and the request stays open (tally R5). */
  async function passing(reason: string): Promise<Outcome> {
    state = { ...state, failures: state.failures + 1 };
    log(`passport ${short} failed for a reason that may pass: ${reason}`);
    await handBack({ reason });
    if (personAsked) {
      // The service closes a request on any done without a report, and has no route to reopen one,
      // so the request is placed again and the person's page reads waiting rather than failed.
      const placed = await deps.queue.request(passportId);
      if (placed !== "placed") {
        log(`passport ${short}'s request could not be placed again (${placed})`);
      }
    }
    state = noteWaiting(state, passportId, redact(cut(reason, 160), scrub), deps.now(), config.retrySeconds, config.cooldownSeconds);
    return backedOff(deps, { state, ran: true, succeeded: false });
  }

  /** A run that did not land for a reason that will not change by itself: the cooldown. */
  async function final(reason: string): Promise<Outcome> {
    state = { ...state, failures: state.failures + 1 };
    log(`passport ${short} failed: ${reason}`);
    await handBack({ reason });
    state = noteRecent(state, passportId, deps.now());
    return backedOff(deps, { state, ran: true, succeeded: false });
  }

  /** A report the receiver refused. The second one settles the passport, since a third would be refused too (tally R4). */
  async function refused(reason: string): Promise<Outcome> {
    state = { ...state, failures: state.failures + 1 };
    const refusals = noteRefusal(state, passportId);
    state = noteBreakerRefusal(refusals.state, passportId, deps.now());
    log(`passport ${short} failed: ${reason}`);
    await handBack({ reason });
    state =
      refusals.count >= REFUSALS_BEFORE_CLOSING
        ? noteClosed(state, passportId, `the receiver refused ${refusals.count} reports for it, so another would not land either`, deps.now())
        : noteRecent(state, passportId, deps.now());
    return tripping(backedOff(deps, { state, ran: true, succeeded: false }));
  }

  /** The outcome, ending the pass with the loud line when this refusal is the one that tripped the breaker. */
  function tripping(outcome: Outcome): Outcome {
    const tripped = outcome.state.breaker.tripped;
    if (tripped === null || entering.breaker.tripped !== null) {
      return outcome;
    }
    const line = breakerLine(tripped);
    log(line);
    return { ...outcome, stopped: line };
  }

  /**
   * The whole run with --broadcast left off, claiming nothing and telling the queue nothing. A
   * private run needs a live claim for its link, so a dry run names it and does not start it.
   */
  async function dryRun(txHash: string, eventIndex: number): Promise<Outcome> {
    if (privateRun) {
      log(`dry run: passport ${short} would be re-checked privately. That needs a live claim on the queue for its link, so a dry run does not start it`);
      state = noteHeld(state, passportId, deps.now());
      return { state, ran: false, succeeded: false };
    }
    log(
      `dry run: passport ${short} would be re-checked from tx ${txHash.slice(0, 12)} event ${eventIndex}, asked for by the ${candidate.source}`,
    );
    const result = await deps.simulate({
      workflowDir: config.workflowDir,
      envFile: config.envFile,
      target: config.target,
      txHash,
      eventIndex,
      broadcast: false,
      timeoutMs: config.simulateTimeoutMs,
      scrub,
    });
    state = noteHeld(state, passportId, deps.now());
    if (result.ok) {
      state = { ...state, failures: 0 };
      log(
        `passport ${short} tx ${txHash.slice(0, 12)} event ${eventIndex} -> nothing written, this was a dry run, recomputed ${result.recomputed ?? "unread"} distance ${result.distance ?? "unread"} matched ${result.matched ?? "unread"}`,
      );
      return { state, ran: true, succeeded: true };
    }
    state = { ...state, failures: state.failures + 1 };
    log(`passport ${short} failed: ${result.reason ?? "the simulation did not finish"}`);
    return backedOff(deps, { state, ran: true, succeeded: false });
  }

  /**
   * Settles the passport as not re-checkable, for good, with the reason every later request is given
   * (tally R2). Nothing is counted against the day's cap or the failures.
   */
  async function close(reason: string): Promise<Outcome> {
    const clean = redact(cut(reason, 160), scrub);
    log(`passport ${short} is not re-checked: ${clean}`);
    state = noteClosed(state, passportId, clean, deps.now());
    if (fromQueue) {
      await respond(deps, passportId, { reason: `passport ${short} is not re-checked: ${clean}` }, scrub);
    }
    return { state, ran: false, succeeded: false };
  }

  /**
   * Sets the passport aside from the sweep for the cooldown, with no run, for a reason that can
   * change: a seed card, a sealed picture, a private run this machine cannot make. A request for it
   * is answered with the reason and looked at afresh if somebody asks again.
   */
  async function hold(reason: string): Promise<Outcome> {
    log(reason);
    state = noteHeld(state, passportId, deps.now());
    if (fromQueue) {
      await respond(deps, passportId, { reason: cut(reason, 200) }, scrub);
    }
    return { state, ran: false, succeeded: false };
  }

  /**
   * A passing failure before any spend: a short wait, no claim, no answer, nothing counted. A
   * request stays on the queue and is tried again when the wait is over (tally R5, R9).
   */
  async function wait(reason: string): Promise<Outcome> {
    const clean = redact(cut(reason, 160), scrub);
    state = noteWaiting(state, passportId, clean, deps.now(), config.retrySeconds, config.cooldownSeconds);
    const until = state.waiting[passportId]?.until ?? seconds(deps.now());
    const minutes = Math.max(1, Math.ceil((until - seconds(deps.now())) / 60));
    log(`passport ${short}: ${clean}, trying again in ${minutes} minutes`);
    return { state, ran: false, succeeded: false };
  }

  /** Every reason goes out through redact, the same filter the simulator's output goes through (B5). */
  async function tell(report: Omit<DoneReport, "passportId">): Promise<void> {
    const clean = report.reason === undefined ? report : { ...report, reason: redact(report.reason, scrub) };
    try {
      await deps.queue.done({ passportId, ...clean });
    } catch (error) {
      log(`could not report back to the queue: ${message(error)}`);
    }
  }
}

/**
 * Answers a request with no run: claims it and hands it straight back with what the runner already
 * knows. A dry run names the answer and claims nothing. True when the answer was handed back.
 */
async function respond(deps: Deps, passportId: string, report: Omit<DoneReport, "passportId">, scrub: readonly string[]): Promise<boolean> {
  const short = passportId.slice(0, 12);
  const said = report.reportTx === undefined ? report.reason ?? "" : `report ${report.reportTx.slice(0, 12)} is already in the registry`;
  if (deps.config.dryRun) {
    deps.log(redact(`dry run: the request for passport ${short} would be answered: ${said}`, scrub));
    return false;
  }
  try {
    const claim = await deps.queue.claim(passportId);
    if (claim !== "claimed") {
      deps.log(`the request for passport ${short} could not be claimed to answer it (${claim})`);
      return false;
    }
    const clean = report.reason === undefined ? report : { ...report, reason: redact(cut(report.reason, 200), scrub) };
    await deps.queue.done({ passportId, ...clean });
    deps.log(redact(`answered the request for passport ${short}: ${said}`, scrub));
    return true;
  } catch (error) {
    deps.log(redact(`could not answer the request for passport ${short}: ${message(error)}`, scrub));
    return false;
  }
}

/** The one loud line a tripped breaker writes, every pass, until the operator clears it. */
export function breakerLine(tripped: Closure): string {
  return `CIRCUIT BREAKER TRIPPED at ${new Date(tripped.at * 1000).toISOString()}: ${tripped.reason}. Nothing is sent until the operator restarts the runner once with RUNNER_RESET_BREAKER=1`;
}

/**
 * The state the runner starts from. RUNNER_RESET_BREAKER=1 clears a tripped breaker, and says so;
 * without it a breaker tripped before the restart stays tripped.
 */
export function openingState(state: RunnerState, config: Config, log: Log): RunnerState {
  if (!config.resetBreaker) {
    if (state.breaker.tripped !== null) {
      log(breakerLine(state.breaker.tripped));
    }
    return state;
  }
  if (state.breaker.tripped === null) {
    log("RUNNER_RESET_BREAKER=1 is set but the breaker is not tripped. Take it out of the env file so a later restart cannot clear a trip unseen");
    return clearBreaker(state);
  }
  log(
    `circuit breaker cleared by RUNNER_RESET_BREAKER=1. It tripped at ${new Date(state.breaker.tripped.at * 1000).toISOString()}: ${state.breaker.tripped.reason}. Take RUNNER_RESET_BREAKER out of the env file now`,
  );
  return clearBreaker(state);
}

/** The outcome with the backoff started, when this failure made enough in a row. */
function backedOff(deps: Deps, outcome: Outcome): Outcome {
  const { config } = deps;
  if (outcome.state.failures < config.failuresBeforeBackoff) {
    return outcome;
  }
  const stopped = `${outcome.state.failures} failures in a row, backing off for ${config.backoffMinutes} minutes`;
  deps.log(stopped);
  return {
    ...outcome,
    state: { ...outcome.state, backoffUntil: seconds(deps.now()) + config.backoffMinutes * 60 },
    stopped,
  };
}

/**
 * What the runner already knows about a requested passport: an answer it can give with no run,
 * a wait to let pass, or nothing, which means look at it.
 */
function remembered(
  deps: Deps,
  state: RunnerState,
  passportId: string,
  nowMs: number,
): { kind: "answer"; report: Omit<DoneReport, "passportId"> } | { kind: "defer" } | { kind: "free" } {
  const { config } = deps;
  const short = passportId.slice(0, 12);
  const sent = sentFor(state, passportId, nowMs);
  if (sent?.landed === true) {
    return { kind: "answer", report: { reportTx: sent.tx } };
  }
  const closure = closureFor(state, passportId);
  if (closure !== undefined) {
    return { kind: "answer", report: { reason: `passport ${short} is not re-checked: ${closure.reason}` } };
  }
  if (inCooldown(state, passportId, nowMs, config.cooldownSeconds)) {
    const until = new Date(((state.recent[passportId] ?? 0) + config.cooldownSeconds) * 1000).toISOString();
    return {
      kind: "answer",
      report: { reason: `passport ${short} was run less than ${hours(config.cooldownSeconds)} ago and got no verdict, so it is not run again before ${until}` },
    };
  }
  const wait = waitFor(state, passportId, nowMs);
  if (wait !== undefined) {
    return wait.misses >= MISSES_BEFORE_ANSWER
      ? { kind: "answer", report: { reason: `passport ${short} could not be run: ${wait.reason}. Ask again later` } }
      : { kind: "defer" };
  }
  return { kind: "free" };
}

/**
 * The passports this pass will look at, and the requests it can answer without a run.
 *
 * A request for a passport the runner has settled, re-checked or run within the cooldown is
 * answered from memory, a few a pass, so it leaves the queue's page instead of holding its place in
 * it (tally R6). One in a short wait is left for now. The sweep's query leaves out every passport
 * the runner is leaving alone, so those can never fill its page (tally R3).
 */
async function gather(deps: Deps, state: RunnerState, nowMs: number): Promise<{ answers: Answer[]; candidates: Candidate[] }> {
  const { config, log } = deps;
  const answers: Answer[] = [];
  const candidates: Candidate[] = [];
  const seen = new Set<string>();

  let pending: string[] = [];
  try {
    pending = await deps.queue.pending();
  } catch (error) {
    log(`could not read the request queue: ${message(error)}`);
  }
  for (const raw of pending) {
    const passportId = raw.toLowerCase();
    if (seen.has(passportId)) {
      continue;
    }
    seen.add(passportId);
    const memory = remembered(deps, state, passportId, nowMs);
    if (memory.kind === "answer") {
      if (answers.length < ANSWERS_PER_PASS) {
        answers.push({ passportId, report: memory.report });
      }
      continue;
    }
    // A dry run claims nothing, so a request it has already simulated stays pending; it is left
    // alone for the cooldown rather than simulated again every pass.
    if (memory.kind === "defer" || (config.dryRun && isHeld(state, passportId, nowMs, config.cooldownSeconds))) {
      continue;
    }
    if (candidates.length < config.maxPerPass) {
      candidates.push({ passportId, source: "queue" });
    }
  }

  if (candidates.length < config.maxPerPass) {
    try {
      const before = seconds(nowMs) - config.settleSeconds;
      const excluded = sweepExclusions(deps, state, nowMs, seen);
      for (const row of await deps.index.unrechecked(before, config.maxPerPass, excluded)) {
        const passportId = row.id.toLowerCase();
        if (
          seen.has(passportId) ||
          remembered(deps, state, passportId, nowMs).kind !== "free" ||
          isHeld(state, passportId, nowMs, config.cooldownSeconds)
        ) {
          continue;
        }
        seen.add(passportId);
        if (candidates.length < config.maxPerPass) {
          candidates.push({ passportId, source: "sweep", row });
        }
      }
    } catch (error) {
      log(`could not read the index: ${message(error)}`);
    }
  }

  return { answers, candidates };
}

/**
 * Every id the sweep's query should leave out: the requests already in this pass, and every
 * passport settled, re-checked by this runner, held, cooling or waiting. The newest are kept when
 * there are more than the query should carry.
 */
function sweepExclusions(deps: Deps, state: RunnerState, nowMs: number, seen: ReadonlySet<string>): string[] {
  const { config } = deps;
  const now = seconds(nowMs);
  const stamped: [string, number][] = [];
  for (const [id, at] of Object.entries(state.recent)) {
    if (now - at < config.cooldownSeconds) {
      stamped.push([id, at]);
    }
  }
  for (const [id, at] of Object.entries(state.held)) {
    if (now - at < config.cooldownSeconds) {
      stamped.push([id, at]);
    }
  }
  for (const [id, closure] of Object.entries(state.closed)) {
    stamped.push([id, closure.at]);
  }
  for (const [id, wait] of Object.entries(state.waiting)) {
    if (wait.until > now) {
      stamped.push([id, wait.until]);
    }
  }
  for (const id of Object.keys(state.sent)) {
    const sent = sentFor(state, id, nowMs);
    if (sent?.landed === true) {
      stamped.push([id, sent.at]);
    }
  }
  stamped.sort((left, right) => right[1] - left[1]);
  return [...new Set([...seen, ...stamped.map(([id]) => id)])].slice(0, MOST_EXCLUDED);
}

/**
 * Fails closed: a count that is not a whole number from zero up reads as the cap used up, since NaN
 * compares false against any cap and a negative count would add to it (R9).
 */
function capUsed(state: RunnerState, cap: number): boolean {
  return !Number.isSafeInteger(state.reports) || state.reports < 0 || state.reports >= cap;
}

/**
 * The values no log line or reason may carry: the runner's own token and addresses, and every
 * value in the env file handed to the CRE CLI, the wallet key and the sealed link token among them.
 */
export function secretValues(config: Config): string[] {
  return scrubList([
    config.runnerToken,
    config.rpcUrl,
    config.envioUrl,
    config.verifyServiceUrl,
    ...envFileValues(config.envFile),
  ]);
}

function seconds(nowMs: number): number {
  return Math.floor(nowMs / 1000);
}

function hours(totalSeconds: number): string {
  const whole = Math.round(totalSeconds / 3600);
  return whole === 1 ? "an hour" : `${whole} hours`;
}

export function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
