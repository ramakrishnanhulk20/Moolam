import type { Hex } from "viem";
import { chain } from "@/lib/chain/client";
import { publicEnv } from "@/lib/env";
import { DECISIONS_ADDRESS, decisionPublishedEvent } from "./decisionsContract";
import { publishedInReceipt, reasonsRefusalOf, type PublishedInReceipt, type PublishRefusal } from "./reasons";

const PIN_ADDRESS = /^ipfs:\/\/[A-Za-z0-9]{46,121}$/;
const SEND_TIMEOUT_MS = 30_000;

export type ReasonsPinned = { ok: true; reasonsURI: string } | { ok: false; refusal: PublishRefusal };

/**
 * Pins the resolver's signed reasons through the verify service. The same
 * signed reasons answer the same address, so a second press after a dropped
 * answer costs nothing and pins nothing twice. Only an address MoolamDecisions
 * would take is ever handed on to the transaction.
 */
export async function pinReasons(body: {
  passportId: Hex;
  openedAt: number;
  upheld: boolean;
  reasons: string;
  deadline: number;
  signature: Hex;
}): Promise<ReasonsPinned> {
  let response: Response;
  try {
    response = await fetch(`${publicEnv.verifierUrl.replace(/\/+$/, "")}/decisions/reasons`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...body, passportId: body.passportId.toLowerCase() }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, refusal: "unavailable" };
  }
  let said: { reasonsURI?: unknown; error?: unknown } = {};
  try {
    said = ((await response.json()) ?? {}) as typeof said;
  } catch {
    said = {};
  }
  if (response.ok) {
    return typeof said.reasonsURI === "string" && PIN_ADDRESS.test(said.reasonsURI)
      ? { ok: true, reasonsURI: said.reasonsURI }
      : { ok: false, refusal: "unknown" };
  }
  return { ok: false, refusal: reasonsRefusalOf(response.status, said.error) };
}

/** The publish has not shown up in a receipt inside the window. It may still land, so it must not be sent again. */
export class PublishPending extends Error {
  constructor() {
    super("Monad has not shown the publish in a receipt yet");
    this.name = "PublishPending";
  }
}

/** Monad mined the publish and it reverted, or its receipt carries no DecisionPublished for this dispute. */
export class PublishNotShown extends Error {
  readonly hash: Hex;

  constructor(hash: Hex) {
    super(`the receipt of ${hash} carries no DecisionPublished for this dispute`);
    this.name = "PublishNotShown";
    this.hash = hash;
  }
}

const POLL_MS = 1_500;
const WINDOW_MS = 90_000;

/**
 * Waits for the publish's receipt and reads the DecisionPublished event out of
 * it. That event, from MoolamDecisions itself, is the only thing that makes the
 * step done.
 *
 * A sponsored send can answer with no hash, so without one the transaction is
 * found by its event's two indexed fields from the block the send started at,
 * and its receipt is then read and checked the same way.
 */
export async function confirmPublish({
  hash,
  passportId,
  openedAt,
  reasonsURI,
  fromBlock,
  windowMs = WINDOW_MS,
  pollMs = POLL_MS,
}: {
  hash?: Hex;
  passportId: Hex;
  openedAt: bigint;
  reasonsURI: string;
  fromBlock: bigint;
  windowMs?: number;
  pollMs?: number;
}): Promise<{ hash: Hex; published: PublishedInReceipt }> {
  const ends = Date.now() + windowMs;
  let known = hash;
  for (;;) {
    try {
      if (known === undefined) {
        const logs = await chain.getLogs({
          address: DECISIONS_ADDRESS,
          event: decisionPublishedEvent,
          args: { passportId, openedAt },
          fromBlock,
          toBlock: "latest",
        });
        known = logs.at(-1)?.transactionHash ?? undefined;
      }
      if (known !== undefined) {
        const receipt = await chain.getTransactionReceipt({ hash: known });
        const published = publishedInReceipt(receipt, { passportId, openedAt, reasonsURI });
        if (published === null) {
          throw new PublishNotShown(known);
        }
        return { hash: known, published };
      }
    } catch (error) {
      if (error instanceof PublishNotShown) {
        throw error;
      }
      // A receipt not out yet, or a read that hiccuped: the window carries on.
    }
    if (Date.now() + pollMs > ends) {
      throw new PublishPending();
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}
