import { chain } from "./client";

/**
 * The chain's own clock.
 *
 * A deadline built from the browser's clock is a deadline built from whatever
 * the laptop's time zone and drift say, and the registry compares it against
 * block.timestamp. A machine running a few minutes fast signs a window the
 * chain thinks is already half gone; one running slow signs one the chain
 * refuses outright. So the window is measured from the head block instead.
 */

/**
 * How long one reading of the head block is reused. A flow that asks twice in
 * the same breath, once to show the window and once to build the struct, pays
 * for one call, and the answer is never more than a couple of blocks stale.
 */
const HOLD_MS = 10_000;

let held: { at: number; reading: Promise<bigint> } | null = null;

/** The timestamp on the latest block, in whole seconds. */
export async function headTimestamp(): Promise<bigint> {
  const now = Date.now();
  if (held !== null && now - held.at < HOLD_MS) {
    return await held.reading;
  }

  const reading = chain.getBlock({ blockTag: "latest" }).then((block) => block.timestamp);
  held = { at: now, reading };

  try {
    return await reading;
  } catch (error) {
    // A failed read is not worth holding: the next caller should get a real
    // attempt rather than the same rejection for the next ten seconds.
    if (held?.reading === reading) {
      held = null;
    }
    throw error;
  }
}

/** The unix second a signature made now should stop being valid. */
export async function deadlineFromChain(windowSeconds: bigint): Promise<bigint> {
  return (await headTimestamp()) + windowSeconds;
}
