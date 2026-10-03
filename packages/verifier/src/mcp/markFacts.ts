import { z } from "zod";
import { env } from "../env.js";
import type { DisputeAnswer } from "../disputeRead.js";
import type { Hex } from "../types.js";
import { findUnsealRecord, pinnedContentId, pinnedUnsealOf, sealedStateOf } from "../unseal.js";
import { LOOKALIKE_PHASH_BITS } from "../lookalike-rule.js";
import { issueMark, type Mark, type MarkDispute, type MarkLookalike, type MarkPicture, type MarkVerdict } from "./mark.js";
import { heldReads } from "./memory.js";

/**
 * The index's side of a passport's trust mark: the newest verdict Chainlink's network wrote, and
 * the passport's own newest look-alike record. `verdicts` is null and `lookalike.read` false when
 * the index could not say, which the mark then reports as unavailable rather than guessing (L32).
 */
export interface IndexMarkFacts {
  verdicts: MarkVerdict[] | null;
  lookalike: { read: true; record: MarkLookalike | null } | { read: false };
}

/** Reads the index's side of one passport's mark. Never throws. */
export type MarkIndexReader = (id: Hex) => Promise<IndexMarkFacts>;

/** Whether a sealed passport's holder has published its picture since: true, false, or null for "could not tell". */
export type UnsealedReader = (id: Hex) => Promise<boolean | null>;

/** What get_passport answers about the mark: the site's own word for it, from the same function. */
export type MarkAnswer =
  | { state: "unavailable" }
  | { state: "upheld" | "challenged" | "waiting" | "sealed" | "nothing" }
  | { state: "mismatch"; secondPrint: boolean; phashDistance: number; checkedAt: number }
  | { state: "lookalike"; earlier: Hex; foundAt: number }
  | { state: "checked"; phashDistance: number; checkedAt: number };

/** As long as the handover is held: the index serves the site and this service from one budget (M5). */
export const MARK_HOLD_MS = 30_000;

const MARK_TIMEOUT_MS = 5_000;

const PASSPORT_ID = /^0x[0-9a-f]{64}$/;
const ZERO_ID = `0x${"0".repeat(64)}`;

// Only a network verdict is asked for: the index sets `network` true only for the verdict receiver
// through Chainlink's forwarder at or after activation (L4), so the receiver needs no filter here.
const MARK_QUERY = `query MoolamMark($id: String!) {
  Attestation(where: { passport_id: { _eq: $id }, network: { _eq: true } }, order_by: [{ at: desc }], limit: 1) {
    matched
    distance
    at
  }
  Lookalike(where: { id: { _eq: $id } }, limit: 1) {
    earlierId
    network
    valid
    executedAt
  }
}`;

const seconds = z
  .union([z.string().regex(/^[0-9]{1,15}$/), z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)])
  .transform((value) => Number(value));

const responseSchema = z.object({
  errors: z.array(z.unknown()).optional(),
  data: z
    .object({
      Attestation: z.array(z.object({ matched: z.boolean(), distance: z.number().int().min(0), at: seconds })).max(1),
      Lookalike: z
        .array(
          z.object({
            earlierId: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
            network: z.boolean(),
            valid: z.boolean(),
            executedAt: seconds,
          }),
        )
        .max(1),
    })
    .nullish(),
});

const UNREAD: IndexMarkFacts = { verdicts: null, lookalike: { read: false } };

/**
 * Reads the mark's index facts from the Envio index at `url`, held for MARK_HOLD_MS per passport.
 * An index from before the redeploy that taught it these fields refuses the query, and that is the
 * same "could not say" as an index that did not answer: nothing that failed is held.
 */
export function envioMarkReader(url: string, fetchImpl: typeof fetch = fetch): MarkIndexReader {
  const held = heldReads<IndexMarkFacts>({ ttlMs: MARK_HOLD_MS, maxEntries: 2_000 });
  const load = async (id: Hex): Promise<IndexMarkFacts> => {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: MARK_QUERY, variables: { id } }),
      signal: AbortSignal.timeout(MARK_TIMEOUT_MS),
    });
    if (response.status !== 200) {
      throw new Error(`the index answered ${response.status}`);
    }
    const parsed = responseSchema.safeParse(await response.json());
    if (!parsed.success || (parsed.data.errors?.length ?? 0) > 0 || parsed.data.data == null) {
      throw new Error("the index did not answer the mark's query");
    }
    const [verdict] = parsed.data.data.Attestation;
    const [record] = parsed.data.data.Lookalike;
    const earlier = record === undefined ? null : record.earlierId.toLowerCase();
    return {
      verdicts: verdict === undefined ? [] : [{ network: true, matched: verdict.matched, phashBits: verdict.distance, at: verdict.at }],
      lookalike: {
        read: true,
        record:
          record === undefined
            ? null
            : { network: record.network, valid: record.valid, earlier: earlier === ZERO_ID ? null : earlier, executedAt: record.executedAt },
      },
    };
  };
  return async (id) => {
    const key = id.toLowerCase() as Hex;
    try {
      return await held.read(key, async () => await load(key));
    } catch {
      return UNREAD;
    }
  };
}

/** A reader for a host with no index to ask, which is every host under a test runner. */
export function unavailableMarkReader(): MarkIndexReader {
  return async () => UNREAD;
}

/** Asks for the unseal record the site reads, here first and then on Pinata; null when neither could say. */
export function liveUnsealedReader(): UnsealedReader {
  const held = heldReads<boolean>({ ttlMs: MARK_HOLD_MS, maxEntries: 2_000 });
  return async (id) => {
    if (pinnedUnsealOf(id) !== undefined) return true;
    try {
      return await held.read(id.toLowerCase(), async () => {
        const lookup = await findUnsealRecord(id);
        if (lookup.state === "unavailable") throw new Error(lookup.reason);
        return lookup.state === "found";
      });
    } catch {
      return null;
    }
  };
}

/** A reader for a host that may not ask Pinata, which is every host under a test runner. */
export function unavailableUnsealedReader(): UnsealedReader {
  return async () => null;
}

let defaults: { index: MarkIndexReader; unsealed: UnsealedReader } | undefined;

/**
 * The readers get_passport uses when the server was not handed its own, chosen the way the route
 * chooses the handover reader: the index when this host reads one, nothing under a test runner.
 */
export function defaultMarkReaders(): { index: MarkIndexReader; unsealed: UnsealedReader } {
  if (defaults === undefined) {
    const offline = env.NODE_ENV === "test";
    defaults = {
      index:
        !offline && env.PASSPORT_SOURCE === "envio" && env.ENVIO_GRAPHQL_URL !== undefined
          ? envioMarkReader(env.ENVIO_GRAPHQL_URL)
          : unavailableMarkReader(),
      unsealed: offline ? unavailableUnsealedReader() : liveUnsealedReader(),
    };
  }
  return defaults;
}

/** The registry's dispute word for the mark, or null when the dispute reader could not say. */
export function disputeForMark(disputedFlag: boolean, dispute: DisputeAnswer): MarkDispute | null {
  if (disputedFlag) return "upheld";
  return dispute.source === "chain" ? dispute.status : null;
}

function hasPicture(document: Record<string, unknown>): boolean {
  return typeof document.image === "string" || typeof document.thumbnail === "string";
}

/**
 * What the passport points at, by the site's rule (components/mark/read.ts markPicture): only a
 * pinned document names a picture Chainlink can fetch; a sealed one with no picture is sealed until
 * its holder publishes it; a read document with no picture names nothing; an unread one is null.
 */
export async function pictureForMark(
  id: Hex,
  metadataURI: string,
  document: { read: true; document: unknown } | { read: false },
  unsealed: UnsealedReader,
): Promise<MarkPicture | null> {
  if (pinnedContentId(metadataURI) === null) return "none";
  if (!document.read) return null;
  const state = sealedStateOf(document.document);
  if (state === "unreadable") return null;
  const fields = document.document as Record<string, unknown>;
  if (state === "sealed" && !hasPicture(fields)) {
    const published = await unsealed(id);
    return published === null ? null : published ? "public" : "sealed";
  }
  return hasPicture(fields) ? "public" : "none";
}

/** The mark itself, from the shared function, as get_passport answers it. */
export function markAnswer(input: {
  dispute: MarkDispute | null;
  index: IndexMarkFacts;
  picture: MarkPicture | null;
}): MarkAnswer {
  const mark: Mark = issueMark({
    dispute: input.dispute,
    verdicts: input.index.verdicts,
    lookalike: input.index.lookalike,
    picture: input.picture,
    phashLimit: LOOKALIKE_PHASH_BITS,
  });
  switch (mark.state) {
    case "unread":
      return { state: "unavailable" };
    case "mismatch":
      return { state: "mismatch", secondPrint: mark.secondPrint, phashDistance: mark.verdict.phashBits, checkedAt: mark.verdict.at };
    case "checked":
      return { state: "checked", phashDistance: mark.verdict.phashBits, checkedAt: mark.verdict.at };
    case "lookalike":
      return PASSPORT_ID.test(mark.lookalike.earlier)
        ? { state: "lookalike", earlier: mark.lookalike.earlier as Hex, foundAt: mark.lookalike.executedAt }
        : { state: "unavailable" };
    default:
      return { state: mark.state };
  }
}
