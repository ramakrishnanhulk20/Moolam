import { MoolamPlatformError, type DeliveryWorker } from "@moolam/platform";
import { logLine } from "./http";
import { kitReady, openDeliveries } from "./kit";

/**
 * One delivery worker per server process. Next.js loads instrumentation.ts and the route handlers as
 * separate bundles, so a module-level flag could exist twice; the state lives on globalThis instead,
 * because two workers would race to send the same hand-over and the loser would pay for a revert.
 *
 * The kit's worker logs nothing and throws nothing once started. This file logs fixed words only.
 */

export const DELIVERY_INTERVAL_MS = 5_000;

/** A start that failed (the RPC unreachable at boot, say) is tried again after this long. */
export const RETRY_START_MS = 60_000;

const SIGNALS = ["SIGTERM", "SIGINT"] as const;

interface Deliveries {
  worker: DeliveryWorker | null;
  starting: Promise<void> | null;
  retry: ReturnType<typeof setTimeout> | null;
  onSignal: (signal: NodeJS.Signals) => void;
}

const KEY = Symbol.for("dreamloom.deliveries");

function current(): Deliveries | undefined {
  return (globalThis as Record<symbol, Deliveries | undefined>)[KEY];
}

function setCurrent(value: Deliveries | undefined): void {
  (globalThis as Record<symbol, Deliveries | undefined>)[KEY] = value;
}

function isWorker(value: unknown): value is DeliveryWorker {
  return typeof value === "object" && value !== null && typeof (value as DeliveryWorker).stop === "function";
}

/**
 * Starts the delivery worker unless this process already has one, and only when the kit is
 * configured. Stops it on SIGTERM and SIGINT; when nothing else listens for the signal, the process
 * then exits as it would have without this listener.
 */
export function startDeliveries(): void {
  if (current() !== undefined || !kitReady()) return;

  const onSignal = (signal: NodeJS.Signals) => {
    void stopDeliveries().finally(() => {
      if (process.listenerCount(signal) === 0) process.exit(0);
    });
  };
  const state: Deliveries = { worker: null, starting: null, retry: null, onSignal };
  setCurrent(state);
  for (const signal of SIGNALS) process.once(signal, onSignal);

  const attempt = (): void => {
    state.retry = null;
    state.starting = openDeliveries(DELIVERY_INTERVAL_MS).then(
      (worker) => {
        if (current() !== state) {
          // Stopped while starting: the fresh worker is let go straight away.
          if (isWorker(worker)) void worker.stop();
          return;
        }
        if (!isWorker(worker)) return;
        state.worker = worker;
        logLine("deliveries", "started");
      },
      (error: unknown) => {
        logLine("deliveries", error instanceof MoolamPlatformError ? `not started, ${error.code}` : "not started");
        if (current() !== state) return;
        state.retry = setTimeout(attempt, RETRY_START_MS);
        state.retry.unref?.();
      },
    );
  };
  attempt();
}

/** Stops the worker, letting a hand-over in flight finish. Resolves when it is idle. Stopping nothing is not an error. */
export async function stopDeliveries(): Promise<void> {
  const state = current();
  if (state === undefined) return;
  setCurrent(undefined);
  for (const signal of SIGNALS) process.removeListener(signal, state.onSignal);
  if (state.retry !== null) clearTimeout(state.retry);
  await state.starting;
  if (state.worker !== null) {
    await state.worker.stop();
    logLine("deliveries", "stopped");
  }
}
