import { z } from "zod";
import { hex } from "../source/hex.js";
import type { Hex } from "../types.js";
import { MAX_RECENT } from "./inputs.js";
import { heldReads } from "./memory.js";

/** One passport in the newest-first list, as the index holds it. */
export interface RecentPassport {
  id: Hex;
  creator: Hex;
  parentId: Hex | null;
  registeredAt: number;
  metadataURI: string;
}

/** The newest passports, newest first, at most MAX_RECENT. Throws when the index could not answer. */
export type RecentReader = () => Promise<RecentPassport[]>;

/**
 * How long one list is held for every caller together. The index allows about a hundred queries a
 * minute for the site, this service and every build, so the list costs it two a minute at most
 * however many agents ask (M5).
 */
export const RECENT_HOLD_MS = 30_000;

const RECENT_TIMEOUT_MS = 5_000;

const RECENT_QUERY = `query MoolamRecent($limit: Int!) {
  Passport(order_by: [{ registeredAt: desc }, { id: asc }], limit: $limit) {
    id
    creator { id }
    parent { id }
    registeredAt
    metadataURI
  }
}`;

const seconds = z
  .union([z.string().regex(/^[0-9]{1,15}$/), z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)])
  .transform((value) => Number(value));

const responseSchema = z.object({
  errors: z.array(z.unknown()).optional(),
  data: z
    .object({
      Passport: z
        .array(
          z.object({
            id: hex(32),
            creator: z.object({ id: hex(20) }),
            parent: z.object({ id: hex(32) }).nullish(),
            registeredAt: seconds,
            metadataURI: z.string(),
          }),
        )
        .max(MAX_RECENT),
    })
    .optional(),
});

/**
 * Reads the newest passports from the Envio index at `url`, held for RECENT_HOLD_MS. A page the
 * schema refuses, GraphQL errors, a status other than 200 and a timeout all throw, and nothing is
 * held, so the list is either the index's word or "unavailable" (M3).
 */
export function envioRecentReader(url: string, fetchImpl: typeof fetch = fetch): RecentReader {
  const held = heldReads<RecentPassport[]>({ ttlMs: RECENT_HOLD_MS, maxEntries: 1 });
  const load = async (): Promise<RecentPassport[]> => {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: RECENT_QUERY, variables: { limit: MAX_RECENT } }),
      signal: AbortSignal.timeout(RECENT_TIMEOUT_MS),
    });
    if (response.status !== 200) {
      throw new Error(`the index answered ${response.status}`);
    }
    const parsed = responseSchema.safeParse(await response.json());
    if (!parsed.success || parsed.data.data === undefined || (parsed.data.errors?.length ?? 0) > 0) {
      throw new Error("the index answered in a shape this reader does not know");
    }
    return parsed.data.data.Passport.map((row) => ({
      id: row.id,
      creator: row.creator.id,
      parentId: row.parent?.id ?? null,
      registeredAt: row.registeredAt,
      metadataURI: row.metadataURI,
    }));
  };
  return async () => await held.read("recent", load);
}

/** A reader for a host with no index to ask, which is every host under a test runner. */
export function unavailableRecentReader(): RecentReader {
  return async () => {
    throw new Error("this host has no passport index to list from");
  };
}
