import { chain } from "@/lib/chain/client";
import { activeSource, envioUrl } from "@/lib/data/source";
import { publicEnv } from "@/lib/env";

/**
 * The three reads behind the footer's live line: the verify service, the index
 * and the chain.
 *
 * None of them may throw and none of them may hang. A service that does not
 * answer inside the budget is reported as unreachable, because a footer that
 * blocks the page is worse than a footer that admits one service is down.
 */

/** Nothing here may hold a render longer than this. */
export const STATUS_TIMEOUT_MS = 3_000;

/**
 * How far the index may trail the chain head before the line calls it behind.
 * Monad seals a block about every 400 ms, so 600 blocks is close to four
 * minutes: long enough to ride out a restart, short enough to show a stall.
 */
export const BEHIND_BLOCKS = 600;

export type VerifierStatus = { state: "live"; records: number } | { state: "unreachable" };

export type IndexStatus =
  | { state: "live"; block: number }
  | { state: "behind"; blocks: number }
  | { state: "unreachable" };

export type ChainStatus = { state: "live"; block: number } | { state: "unreachable" };

export interface SystemStatus {
  verifier: VerifierStatus;
  /** Null when no index is configured at all and the app reads the chain itself. */
  index: IndexStatus | null;
  chain: ChainStatus;
}

/** True when an index is configured, so the line has three items rather than two. */
export function hasIndex(): boolean {
  return activeSource() === "envio";
}

/**
 * Resolves to the fallback when the work is still running at the deadline. The
 * abort signal on each fetch does the same job, but a stalled socket or a
 * caller that stubs fetch can outlive it, so the deadline is the outer floor.
 */
async function withDeadline<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  try {
    return await Promise.race([work, late]);
  } finally {
    clearTimeout(timer);
  }
}

/** The verify service's own /health, which carries how many records its index holds. */
export async function readVerifier(timeoutMs = STATUS_TIMEOUT_MS): Promise<VerifierStatus> {
  const url = `${publicEnv.verifierUrl.replace(/\/$/, "")}/health`;

  const ask = (async (): Promise<VerifierStatus> => {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), cache: "no-store" });
      if (!response.ok) {
        return { state: "unreachable" };
      }
      const body = (await response.json()) as { ok?: unknown; records?: unknown };
      if (body.ok !== true || typeof body.records !== "number") {
        return { state: "unreachable" };
      }
      return { state: "live", records: body.records };
    } catch {
      return { state: "unreachable" };
    }
  })();

  return await withDeadline(ask, timeoutMs, { state: "unreachable" });
}

/**
 * The newest block the index has finished processing, or null when it will not
 * answer. Envio keeps this in chain_metadata, which is the index's own account
 * of how far it has read, not the newest passport it happens to hold.
 */
export async function readIndexBlock(timeoutMs = STATUS_TIMEOUT_MS): Promise<number | null> {
  if (!hasIndex()) {
    return null;
  }

  const ask = (async (): Promise<number | null> => {
    try {
      const response = await fetch(envioUrl(), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: "query IndexHead { chain_metadata { latest_processed_block } }" }),
        signal: AbortSignal.timeout(timeoutMs),
        cache: "no-store",
      });
      if (!response.ok) {
        return null;
      }
      const body = (await response.json()) as {
        data?: { chain_metadata?: { latest_processed_block?: unknown }[] };
      };
      const block = body.data?.chain_metadata?.[0]?.latest_processed_block;
      return typeof block === "number" ? block : null;
    } catch {
      return null;
    }
  })();

  return await withDeadline(ask, timeoutMs, null);
}

/** The chain head, through the same viem client the pages read with. */
export async function readChainHead(timeoutMs = STATUS_TIMEOUT_MS): Promise<number | null> {
  const ask = chain
    .getBlockNumber({ cacheTime: 0 })
    .then((head) => Number(head))
    .catch(() => null);

  return await withDeadline(ask, timeoutMs, null);
}

/** Where the index stands against the chain head it is meant to be following. */
export function indexStanding(block: number | null, head: number | null): IndexStatus {
  if (block === null) {
    return { state: "unreachable" };
  }
  if (head !== null && head - block > BEHIND_BLOCKS) {
    return { state: "behind", blocks: head - block };
  }
  return { state: "live", block };
}

/** All three reads at once, so the slowest one sets the wait and not the sum. */
export async function systemStatus(timeoutMs = STATUS_TIMEOUT_MS): Promise<SystemStatus> {
  const [verifier, indexBlock, head] = await Promise.all([
    readVerifier(timeoutMs),
    readIndexBlock(timeoutMs),
    readChainHead(timeoutMs),
  ]);

  return {
    verifier,
    index: hasIndex() ? indexStanding(indexBlock, head) : null,
    chain: head === null ? { state: "unreachable" } : { state: "live", block: head },
  };
}
