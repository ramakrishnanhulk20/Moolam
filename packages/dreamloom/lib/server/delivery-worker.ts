import { MoolamPlatformError, type DeliveryWorker } from "@moolam/platform";
import type { Hex } from "viem";
import { logLine } from "./http";
import { heldByDreamloom, kitReady, openDeliveries } from "./kit";
import { advancePicture, listPictures, readPicture, type PictureRecord } from "./store";

/**
 * One delivery worker per server process. Next.js loads instrumentation.ts and the route handlers as
 * separate bundles, so a module-level flag could exist twice; the state lives on globalThis instead,
 * because two workers would race to send the same hand-over and the loser would pay for a revert.
 *
 * The kit's worker logs nothing and throws nothing once started. This file logs fixed words only.
 *
 * The kit's worker also says nothing when it hands a passport over, so a second loop, started with
 * it, asks the registry which waiting pictures Dreamloom no longer holds and lets the shelf count
 * them as done. Without it a delivered picture would stay held, and 500 of them would refuse every weave.
 */

export const DELIVERY_INTERVAL_MS = 5_000;

/** A start that failed (the RPC unreachable at boot, say) is tried again after this long. */
export const RETRY_START_MS = 60_000;

const SIGNALS = ["SIGTERM", "SIGINT"] as const;

interface Deliveries {
  worker: DeliveryWorker | null;
  starting: Promise<void> | null;
  retry: ReturnType<typeof setTimeout> | null;
  sweep: ReturnType<typeof setTimeout> | null;
  sweeping: Promise<void> | null;
  onSignal: (signal: NodeJS.Signals) => void;
}

/** A picture registered for a signed-in visitor whose passport waits at Moolam, with nothing acting on it. */
function waitingAtMoolam(record: PictureRecord): boolean {
  return (
    record.state === "registered" &&
    record.mode === "platform" &&
    record.delivery?.kind === "waiting" &&
    record.busy === undefined &&
    record.passportId !== undefined
  );
}

/**
 * Moves every picture waiting at Moolam to "moved" once the registry says its passport is no longer in
 * Dreamloom's wallet, so the shelf stops holding it. A read that fails leaves the picture as it is: a
 * picture is never freed on a guess. The picture is read again after the registry answers, in the
 * same turn as the move, so a visitor's own move that claimed it meanwhile keeps its claim and its
 * transaction hash. At most MAX_PICTURES reads, one after another.
 *
 * `keepGoing` is asked before each read, so a stop does not wait for the whole shelf. Returns how many
 * pictures it freed.
 */
export async function freeHandedOver(keepGoing: () => boolean = () => true): Promise<number> {
  let freed = 0;
  for (const candidate of listPictures().filter(waitingAtMoolam)) {
    if (!keepGoing()) break;
    let held: boolean;
    try {
      held = await heldByDreamloom(candidate.passportId as Hex);
    } catch {
      continue;
    }
    if (held) continue;
    const latest = readPicture(candidate.id);
    if (latest === null || !waitingAtMoolam(latest)) continue;
    if (advancePicture(latest.id, "moved") !== null) freed += 1;
  }
  return freed;
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
  const state: Deliveries = { worker: null, starting: null, retry: null, sweep: null, sweeping: null, onSignal };
  setCurrent(state);
  for (const signal of SIGNALS) process.once(signal, onSignal);

  // Each sweep starts one interval after the last one ended, so two never overlap.
  const scheduleSweep = (): void => {
    state.sweep = setTimeout(() => {
      state.sweep = null;
      state.sweeping = freeHandedOver(() => current() === state)
        .then(() => undefined, () => undefined)
        .finally(() => {
          state.sweeping = null;
          if (current() === state) scheduleSweep();
        });
    }, DELIVERY_INTERVAL_MS);
    state.sweep.unref?.();
  };

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
        scheduleSweep();
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
  if (state.sweep !== null) clearTimeout(state.sweep);
  await state.starting;
  await state.sweeping;
  if (state.worker !== null) {
    await state.worker.stop();
    logLine("deliveries", "stopped");
  }
}
