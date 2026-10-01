import { resumeOpenCosigns } from "./cosign-worker";
import { startDeliveries } from "./delivery-worker";
import { EnvError, env } from "./env";
import { logLine } from "./http";
import { kitReady } from "./kit";
import { failStuckClaims } from "./store";

/**
 * A claim older than this belongs to a process that is gone: the longest action a live process
 * holds a claim for is a prepare (two minutes at most) and a receipt wait.
 */
export const STUCK_CLAIM_MS = 15 * 60 * 1000;

let started = false;

/**
 * What Dreamloom does once when a server process starts: check its settings, stopping a production
 * server that is missing one (the line names the variable, never a value), mark claims a dead
 * process left behind as "interrupted", pick up stored co-signs in the background, and start the
 * delivery worker that hands over passports their people accepted at Moolam.
 *
 * Runs from instrumentation.ts at start and again from the first request, where it does nothing
 * the second time. Never waits for a co-sign, so a start is never held up by one.
 */
export function startServer(stop: () => void = () => process.exit(1)): void {
  if (started) return;
  try {
    env();
    kitReady();
  } catch (error) {
    if (!(error instanceof EnvError)) throw error;
    console.error(error.message);
    if (process.env.NODE_ENV === "production") stop();
    return;
  }
  started = true;
  const interrupted = failStuckClaims(STUCK_CLAIM_MS);
  if (interrupted.length > 0) logLine("start", `${interrupted.length} interrupted`);
  void resumeOpenCosigns();
  startDeliveries();
}
