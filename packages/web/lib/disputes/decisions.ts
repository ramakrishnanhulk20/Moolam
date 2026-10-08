import { unstable_cache } from "next/cache";
import { parseAbiItem, type Hex } from "viem";
import { z } from "zod";
import { CACHE_TAGS, DEPLOY_BLOCK, HOLD_SECONDS, addresses, chain } from "@/lib/chain/client";
import { DisputeStatus, passportTag, type Dispute } from "@/lib/chain/registry";
import { activeSource, envioUrl } from "@/lib/data/source";
import { DECISIONS_ADDRESS, DECISIONS_BLOCK, decisionPublishedEvent } from "./decisionsContract";
import { pinnedLink } from "./evidence";

export { DECISIONS_ADDRESS, DECISIONS_BLOCK, decisionPublishedEvent } from "./decisionsContract";

const disputeResolvedEvent = parseAbiItem(
  "event DisputeResolved(bytes32 indexed passportId, bool upheld, address indexed resolver)",
);

/** One published decision, as the chain or the index holds it. */
export interface PublishedDecision {
  upheld: boolean;
  reasonsURI: string;
  /** Unix seconds of the block it was published in, when that was read. */
  publishedAt: number | null;
}

export type DecisionRead = { kind: "published"; decision: PublishedDecision } | { kind: "none" } | { kind: "failed" };

/** Short enough that the push-day redeploy is picked up within minutes, long enough to cost the shared index nothing. */
const SCHEMA_HOLD_SECONDS = 600;

const typeSchema = z.object({ fields: z.array(z.object({ name: z.string() })).nullable() }).nullable();

/** Whether this index serves the Decision entity yet. Any failure answers no, and the chain is read instead. */
async function readDecisionSchema(): Promise<boolean> {
  if (activeSource() !== "envio") {
    return false;
  }
  try {
    const answer = z
      .object({ decision: typeSchema })
      .safeParse(await ask<unknown>(`query DecisionSchema { decision: __type(name: "Decision") { fields { name } } }`, {}));
    if (!answer.success) {
      return false;
    }
    const names = new Set((answer.data.decision?.fields ?? []).map((field) => field.name));
    return ["openedAt", "upheld", "reasonsURI", "blockTimestamp"].every((field) => names.has(field));
  } catch {
    return false;
  }
}

const heldDecisionSchema = unstable_cache(async () => await readDecisionSchema(), ["moolam-decision-schema"], {
  revalidate: SCHEMA_HOLD_SECONDS,
  tags: [CACHE_TAGS.index],
});

async function decisionSchema(): Promise<boolean> {
  try {
    return await heldDecisionSchema();
  } catch {
    return await readDecisionSchema();
  }
}

const seconds = z
  .union([z.string().regex(/^[0-9]{1,15}$/), z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)])
  .transform((value) => Number(value));

const indexedDecisionAnswer = z.object({
  Decision: z
    .array(z.object({ openedAt: seconds, upheld: z.boolean(), reasonsURI: z.string().max(256), blockTimestamp: seconds }))
    .max(1),
});

async function fromIndex(passportId: Hex, openedAt: number): Promise<DecisionRead> {
  const parsed = indexedDecisionAnswer.safeParse(
    await ask<unknown>(
      `query DecisionFor($id: String!) {
        Decision(where: { id: { _eq: $id } }, limit: 1) { openedAt upheld reasonsURI blockTimestamp }
      }`,
      { id: `${passportId.toLowerCase()}-${openedAt}` },
    ),
  );
  if (!parsed.success) {
    return { kind: "failed" };
  }
  const [row] = parsed.data.Decision;
  if (row === undefined || row.openedAt !== openedAt) {
    return { kind: "none" };
  }
  return { kind: "published", decision: { upheld: row.upheld, reasonsURI: row.reasonsURI, publishedAt: row.blockTimestamp } };
}

/** The contract's own event, read from Monad, for an index that does not carry Decision yet. */
async function fromChain(passportId: Hex, openedAt: number): Promise<DecisionRead> {
  const logs = await chain.getLogs({
    address: DECISIONS_ADDRESS,
    event: decisionPublishedEvent,
    args: { passportId, openedAt: BigInt(openedAt) },
    fromBlock: DECISIONS_BLOCK,
    toBlock: "latest",
  });
  const log = logs.at(-1);
  if (log === undefined || log.args.upheld === undefined || log.args.reasonsURI === undefined) {
    return { kind: "none" };
  }
  const publishedAt =
    log.blockNumber === null
      ? null
      : await chain
          .getBlock({ blockNumber: log.blockNumber })
          .then((block) => Number(block.timestamp))
          .catch(() => null);
  return { kind: "published", decision: { upheld: log.args.upheld, reasonsURI: log.args.reasonsURI, publishedAt } };
}

/**
 * The published decision for one dispute, named by its passport and openedAt:
 * from the index's Decision entity when the index carries it, else from
 * MoolamDecisions' events. Never throws; a read that failed is "failed".
 */
export async function readDecision(passportId: Hex, openedAt: number): Promise<DecisionRead> {
  try {
    return (await decisionSchema()) ? await fromIndex(passportId, openedAt) : await fromChain(passportId, openedAt);
  } catch {
    return { kind: "failed" };
  }
}

/**
 * The same read, held for a minute under this passport's own name.
 *
 * The passport page is built once and handed to everybody who asks inside that
 * minute, and a read that is never kept makes Next throw "changed from static to
 * dynamic" inside it. Publishing the reasons drops the name, so they show one
 * refresh later rather than a minute later. A read that failed is thrown inside
 * the hold so it is never kept, and is handed back as "failed".
 */
export async function heldDecision(passportId: Hex, openedAt: number): Promise<DecisionRead> {
  const held = unstable_cache(
    async (): Promise<DecisionRead> => {
      const read = await readDecision(passportId, openedAt);
      if (read.kind === "failed") {
        throw new Error("the published decision could not be read");
      }
      return read;
    },
    ["moolam-dispute-decision", passportId.toLowerCase(), String(openedAt)],
    { revalidate: HOLD_SECONDS, tags: [CACHE_TAGS.index, passportTag(passportId)] },
  );
  try {
    return await held();
  } catch (error) {
    if ((error as Error | undefined)?.message?.includes("incrementalCache") === true) {
      return await readDecision(passportId, openedAt);
    }
    return { kind: "failed" };
  }
}

/**
 * When the registry settled this passport's dispute, from its DisputeResolved
 * event, for a page whose index has no resolvedAt to give. The newest one is
 * this dispute's, because a passport holds one dispute at a time and only a
 * settled one can be flagged again. Null when it cannot be read.
 */
export async function resolvedAtFromChain(passportId: Hex): Promise<number | null> {
  try {
    const logs = await chain.getLogs({
      address: addresses.registry,
      event: disputeResolvedEvent,
      args: { passportId },
      fromBlock: DEPLOY_BLOCK,
      toBlock: "latest",
    });
    const log = logs.at(-1);
    if (log === undefined || log.blockNumber === null) {
      return null;
    }
    return Number((await chain.getBlock({ blockNumber: log.blockNumber })).timestamp);
  } catch {
    return null;
  }
}

/** What the decision block draws. */
export interface DecisionView {
  outcome: "upheld" | "rejected";
  /** Unix seconds the dispute was settled, or the decision published when that is all there is. Null when neither was read. */
  date: number | null;
  reasons:
    | { kind: "link"; href: string; uri: string }
    | { kind: "text"; uri: string }
    | { kind: "none" }
    | { kind: "unread" };
}

/**
 * The decision as the page draws it, or null for a dispute still open.
 *
 * A published decision counts only when it says what the registry says: the
 * same outcome for the same openedAt. Its reasons address becomes a link only
 * as ipfs://<cid> by the pinned rule (L28, L29) and is drawn as text otherwise.
 */
export function decisionView(
  dispute: Pick<Dispute, "status">,
  read: DecisionRead,
  resolvedAt: number | null,
): DecisionView | null {
  if (dispute.status !== DisputeStatus.Upheld && dispute.status !== DisputeStatus.Rejected) {
    return null;
  }
  const upheld = dispute.status === DisputeStatus.Upheld;
  const outcome = upheld ? "upheld" : "rejected";
  if (read.kind === "failed") {
    return { outcome, date: resolvedAt, reasons: { kind: "unread" } };
  }
  if (read.kind === "none" || read.decision.upheld !== upheld) {
    return { outcome, date: resolvedAt, reasons: { kind: "none" } };
  }
  const { reasonsURI, publishedAt } = read.decision;
  const href = pinnedLink(reasonsURI);
  return {
    outcome,
    date: resolvedAt ?? publishedAt,
    reasons: href === null ? { kind: "text", uri: reasonsURI } : { kind: "link", href, uri: reasonsURI },
  };
}

async function ask<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const response = await fetch(envioUrl(), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(10_000),
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error(`the Envio endpoint answered ${response.status}`);
  }
  const body = (await response.json()) as { errors?: { message: string }[]; data?: T };
  if (body.errors !== undefined && body.errors.length > 0) {
    throw new Error(body.errors.map((entry) => entry.message).join("; "));
  }
  if (body.data === undefined) {
    throw new Error("the Envio endpoint returned no data block");
  }
  return body.data;
}
