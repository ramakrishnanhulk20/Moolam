import { z } from "zod";
import { FETCH_TIMEOUT_MS } from "../env.js";
import { safeReason } from "../net/errorText.js";
import type { Hex } from "../types.js";
import type { LookalikeRecordView } from "./backlog.js";

/**
 * What one read of the index's Lookalike rows found: the newest executedAt per passport at or after
 * activation, "absent" when this index does not serve the entity yet (an index older than WO-276),
 * or "failed" for any other read that did not answer.
 */
export type IndexedLookalikes = { kind: "rows"; newest: Map<Hex, number> } | { kind: "absent" } | { kind: "failed"; reason: string };

/** Reads every Lookalike row the index holds. Never throws. */
export type LookalikeIndexReader = (activation: number) => Promise<IndexedLookalikes>;

const PAGE_SIZE = 500;

/** A stop so an index that ignores the cursor cannot spin forever: a million rows. */
const MAX_PAGES = 2_000;

const QUERY = `query MoolamLookalikes($limit: Int!, $after: String!) {
  Lookalike(where: { id: { _gt: $after } }, order_by: { id: asc }, limit: $limit) {
    id
    executedAt
  }
}`;

const rowSchema = z.object({
  id: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  executedAt: z.union([z.string().regex(/^[0-9]{1,20}$/), z.number().int().nonnegative()]),
});

const responseSchema = z.object({
  errors: z.array(z.object({ message: z.string(), extensions: z.object({ code: z.string().optional() }).loose().optional() })).optional(),
  data: z.object({ Lookalike: z.array(rowSchema) }).nullish(),
});

/**
 * Whether the index refused the query because it has no Lookalike entity. Hasura names a query
 * against a type it does not hold "validation-failed"; an index that answers that for this one
 * query is an index that does not serve the rows, and anything else is a read that failed.
 */
function absentFrom(errors: readonly { message: string; extensions?: { code?: string } | undefined }[]): boolean {
  return errors.length > 0 && errors.every((error) => error.extensions?.code === "validation-failed" || /not found in type/i.test(error.message));
}

/**
 * The index's Lookalike rows (WO-276), read the way EnvioSource reads passports: id cursor pages,
 * one request at a time, each under FETCH_TIMEOUT_MS. Each row is the newest record for its passport
 * by executedAt, so the backlog reads it exactly as it read the ledger: a record counts once its
 * executedAt is at or after activation, the moment the receiver's floor for that passport is set.
 */
export function envioLookalikeReader(url: string, fetcher: typeof fetch = fetch): LookalikeIndexReader {
  return async (activation) => {
    const newest = new Map<Hex, number>();
    let after = "";
    try {
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const response = await fetcher(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ query: QUERY, variables: { limit: PAGE_SIZE, after } }),
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        if (!response.ok) return { kind: "failed", reason: `the index answered ${response.status}` };
        const parsed = responseSchema.safeParse(await response.json());
        if (!parsed.success) return { kind: "failed", reason: "the index's Lookalike page is not the shape this service reads" };
        const errors = parsed.data.errors ?? [];
        if (errors.length > 0) {
          return absentFrom(errors) ? { kind: "absent" } : { kind: "failed", reason: "the index answered with GraphQL errors" };
        }
        const rows = parsed.data.data?.Lookalike;
        if (rows === undefined) return { kind: "failed", reason: "the index returned no data block" };
        for (const row of rows) {
          const at = Number(row.executedAt);
          if (!Number.isSafeInteger(at) || at < activation) continue;
          const id = row.id.toLowerCase() as Hex;
          if ((newest.get(id) ?? -1) < at) newest.set(id, at);
        }
        if (rows.length < PAGE_SIZE) return { kind: "rows", newest };
        const last = rows[rows.length - 1];
        if (last === undefined || last.id <= after) return { kind: "failed", reason: "the index returned a page that did not advance" };
        after = last.id;
      }
      return { kind: "failed", reason: "the index kept returning full Lookalike pages" };
    } catch (error) {
      return { kind: "failed", reason: safeReason(error) };
    }
  };
}

/** The record view over one successful read of the index's rows. */
export function indexRecordView(newest: ReadonlyMap<Hex, number>): LookalikeRecordView {
  return { ready: true, newestAt: (passportId) => newest.get(passportId.toLowerCase() as Hex) };
}
