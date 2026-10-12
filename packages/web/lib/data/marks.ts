import { unstable_cache } from "next/cache";
import { z } from "zod";
import type { Hex } from "viem";
import { CACHE_TAGS, HOLD_SECONDS, LIST_HOLD_SECONDS } from "@/lib/chain/client";
import { passportTag } from "@/lib/chain/registry";
import { activeSource, envioUrl } from "./source";

/**
 * Which of the trust mark's fields this index serves.
 *
 * The hosted index learns Attestation.network, the Lookalike rows and the two
 * look-alike counts on the push-day redeploy (WO-276). Until then a query that
 * names one of them fails whole, so the schema is asked first and a field it
 * does not hold is "not available yet": the screen then leaves out what it
 * would have drawn, and never shows the index's error to a reader.
 */
export interface MarkSchema {
  /** Attestation.network: which verdicts Chainlink's network delivered (L4). */
  network: boolean;
  /** The Lookalike entity and Passport.earlierFound and laterLookalikeCount. */
  lookalikes: boolean;
  /** GlobalStats.networkAttestations: how many verdicts the network has written, counted by the index itself. */
  networkCount: boolean;
}

export const NO_MARK_FIELDS: MarkSchema = { network: false, lookalikes: false, networkCount: false };

/** Short enough that the redeploy is picked up within minutes, long enough to cost the shared index nothing. */
const SCHEMA_HOLD_SECONDS = 600;

const SCHEMA_QUERY = `query MarkSchema {
  attestation: __type(name: "Attestation") { fields { name } }
  passport: __type(name: "Passport") { fields { name } }
  lookalike: __type(name: "Lookalike") { fields { name } }
  stats: __type(name: "GlobalStats") { fields { name } }
}`;

const typeSchema = z.object({ fields: z.array(z.object({ name: z.string() })).nullable() }).nullable();

const schemaAnswer = z.object({
  attestation: typeSchema,
  passport: typeSchema,
  lookalike: typeSchema,
  // Older code asked for three types; an answer without the fourth still says what it can.
  stats: typeSchema.optional(),
});

/** Reads the three type descriptions. Any failure answers "none of them", which is the query every index can run. */
async function readMarkSchema(): Promise<MarkSchema> {
  if (activeSource() !== "envio") {
    return NO_MARK_FIELDS;
  }
  try {
    const parsed = schemaAnswer.safeParse(await ask<unknown>(SCHEMA_QUERY, {}));
    if (!parsed.success) {
      return NO_MARK_FIELDS;
    }
    const names = (type: z.infer<typeof typeSchema>): Set<string> =>
      new Set((type?.fields ?? []).map((field) => field.name));
    const attestation = names(parsed.data.attestation);
    const passport = names(parsed.data.passport);
    const lookalike = names(parsed.data.lookalike);
    const stats = names(parsed.data.stats ?? null);
    return {
      network: attestation.has("network"),
      lookalikes:
        passport.has("earlierFound") &&
        passport.has("laterLookalikeCount") &&
        ["earlierId", "network", "valid", "executedAt", "phashDistance"].every((field) => lookalike.has(field)),
      networkCount: stats.has("networkAttestations"),
    };
  } catch {
    return NO_MARK_FIELDS;
  }
}

const heldSchema = unstable_cache(async () => await readMarkSchema(), ["moolam-mark-schema"], {
  revalidate: SCHEMA_HOLD_SECONDS,
  tags: [CACHE_TAGS.index],
});

/** The same answer, held. Never throws. */
export async function markSchema(): Promise<MarkSchema> {
  try {
    return await heldSchema();
  } catch {
    // Anywhere there is no cache to hold it in, the index is simply asked.
    return await readMarkSchema();
  }
}

const COUNT_QUERY = `query NetworkChecks {
  GlobalStats(limit: 1) { networkAttestations }
}`;

const countAnswer = z.object({
  GlobalStats: z.array(z.object({ networkAttestations: z.number().int().min(0) })).max(1),
});

/** Thrown inside the held read so an index that did not answer is never kept as a number. */
class CountReadFailed extends Error {
  constructor() {
    super("the index did not answer the network check count");
    this.name = "CountReadFailed";
  }
}

/**
 * How many verdicts Chainlink's network has written on Monad, as the index
 * counts them, or null where there is no number to show: an index that does
 * not serve the counter yet, or one that did not answer. A simulator run
 * never reaches the counter (schema.graphql, GlobalStats.networkAttestations),
 * so this is the one figure a screen may call Chainlink checks. Null is drawn
 * as no number at all, never as a zero.
 */
async function readNetworkCheckCount(): Promise<number | null> {
  if (activeSource() !== "envio" || !(await markSchema()).networkCount) {
    return null;
  }
  const parsed = countAnswer.safeParse(await ask<unknown>(COUNT_QUERY, {}));
  if (!parsed.success) {
    throw new CountReadFailed();
  }
  return parsed.data.GlobalStats[0]?.networkAttestations ?? 0;
}

const heldCount = unstable_cache(async () => await readNetworkCheckCount(), ["moolam-network-check-count"], {
  revalidate: LIST_HOLD_SECONDS,
  tags: [CACHE_TAGS.index],
});

/**
 * The same count, held for ten minutes with the list pages' other reads: the
 * home page's close card and anything else that quotes it share one query.
 * Never throws; a failed read is null, and is asked again on the next render.
 */
export async function heldNetworkCheckCount(): Promise<number | null> {
  try {
    return await heldCount();
  } catch (error) {
    if ((error as Error | undefined)?.message?.includes("incrementalCache") === true) {
      try {
        return await readNetworkCheckCount();
      } catch {
        return null;
      }
    }
    return null;
  }
}

/** One look-alike record as the index keeps it: the newest per passport (L6). */
export interface IndexedLookalike {
  /** The earlier passport's id, lower case, or null for a record that found none. */
  earlier: Hex | null;
  phashDistance: number;
  blockhashDistance: number;
  earlierSealed: boolean;
  executedAt: number;
  txHash: Hex;
  /** Came through Chainlink's forwarder at or after activation (L4). */
  network: boolean;
  /** Both passports indexed, in strict registration order, distances in range (L5). */
  valid: boolean;
  /** The earlier passport's own fields, for its line on this page. */
  earlierPassport: IndexedPassportLine | null;
}

/** The few fields a look-alike line draws about the other passport. */
export interface IndexedPassportLine {
  id: Hex;
  registeredAt: number;
  metadataURI: string;
}

/** Everything the index says about look-alikes around one passport. */
export type LookalikeFacts =
  | { kind: "absent" }
  | { kind: "failed" }
  | {
      kind: "rows";
      /** This passport's own newest record, or null when Chainlink has written none. */
      own: IndexedLookalike | null;
      /** How many later passports' newest network, valid record names this one. */
      laterCount: number;
      /** The first of them by the time its record was written, for the quiet line. */
      later: IndexedPassportLine | null;
    };

const LOOKALIKE_QUERY = `query PassportLookalikes($id: String!) {
  own: Lookalike(where: { id: { _eq: $id } }, limit: 1) {
    earlierId
    phashDistance
    blockhashDistance
    earlierSealed
    executedAt
    txHash
    network
    valid
    earlier { id registeredAt metadataURI }
  }
  later: Lookalike(
    where: { earlierId: { _eq: $id }, network: { _eq: true }, valid: { _eq: true } }
    order_by: [{ executedAt: asc }]
    limit: 1
  ) {
    passport { id registeredAt metadataURI }
  }
  Passport(where: { id: { _eq: $id } }, limit: 1) { laterLookalikeCount }
}`;

const PASSPORT_ID = /^0x[0-9a-fA-F]{64}$/;
const ZERO_ID = `0x${"0".repeat(64)}`;

const seconds = z
  .union([z.string().regex(/^[0-9]{1,15}$/), z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)])
  .transform((value) => Number(value));

const passportLine = z.object({
  id: z.string().regex(PASSPORT_ID),
  registeredAt: seconds,
  metadataURI: z.string(),
});

const lookalikeAnswer = z.object({
  own: z
    .array(
      z.object({
        earlierId: z.string().regex(PASSPORT_ID),
        phashDistance: z.number().int().min(0),
        blockhashDistance: z.number().int().min(0),
        earlierSealed: z.boolean(),
        executedAt: seconds,
        txHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
        network: z.boolean(),
        valid: z.boolean(),
        earlier: passportLine.nullable(),
      }),
    )
    .max(1),
  later: z.array(z.object({ passport: passportLine.nullable() })).max(1),
  Passport: z.array(z.object({ laterLookalikeCount: z.number().int().min(0) })).max(1),
});

function toLine(row: z.infer<typeof passportLine> | null | undefined): IndexedPassportLine | null {
  return row === null || row === undefined
    ? null
    : { id: row.id.toLowerCase() as Hex, registeredAt: row.registeredAt, metadataURI: row.metadataURI };
}

/** Thrown inside the held read so a failed answer is never kept. */
class LookalikeReadFailed extends Error {
  constructor() {
    super("the index did not answer the look-alike query");
    this.name = "LookalikeReadFailed";
  }
}

async function readLookalikes(id: Hex): Promise<LookalikeFacts> {
  if (!(await markSchema()).lookalikes) {
    return { kind: "absent" };
  }
  const parsed = lookalikeAnswer.safeParse(await ask<unknown>(LOOKALIKE_QUERY, { id: id.toLowerCase() }));
  if (!parsed.success) {
    throw new LookalikeReadFailed();
  }
  const [row] = parsed.data.own;
  const earlier = row === undefined || row.earlierId.toLowerCase() === ZERO_ID ? null : (row.earlierId.toLowerCase() as Hex);
  return {
    kind: "rows",
    own:
      row === undefined
        ? null
        : {
            earlier,
            phashDistance: row.phashDistance,
            blockhashDistance: row.blockhashDistance,
            earlierSealed: row.earlierSealed,
            executedAt: row.executedAt,
            txHash: row.txHash.toLowerCase() as Hex,
            network: row.network,
            valid: row.valid,
            earlierPassport: earlier === null ? null : toLine(row.earlier),
          },
    laterCount: parsed.data.Passport[0]?.laterLookalikeCount ?? 0,
    later: toLine(parsed.data.later[0]?.passport),
  };
}

/**
 * The look-alike facts for one passport page, held for a minute under the
 * passport's own name with the rest of the page. "absent" is an index that does
 * not serve the rows yet; "failed" is one that does and did not answer, which
 * the page says in words (L32) and never keeps.
 */
export async function heldLookalikeFacts(id: Hex): Promise<LookalikeFacts> {
  if (activeSource() !== "envio") {
    return { kind: "absent" };
  }
  const held = unstable_cache(async () => await readLookalikes(id), ["moolam-passport-lookalikes", id.toLowerCase()], {
    revalidate: HOLD_SECONDS,
    tags: [CACHE_TAGS.index, passportTag(id)],
  });
  try {
    return await held();
  } catch (error) {
    if ((error as Error | undefined)?.message?.includes("incrementalCache") === true) {
      try {
        return await readLookalikes(id);
      } catch {
        return { kind: "failed" };
      }
    }
    return { kind: "failed" };
  }
}

/** One query to the index, with the endpoint's own words on any failure. */
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
