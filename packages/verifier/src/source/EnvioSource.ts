import { z } from "zod";
import { FETCH_TIMEOUT_MS } from "../env.js";
import { rechecksFrom } from "../recheck.js";
import type { IndexedRecord } from "../index.js";
import { hex } from "./hex.js";
import type { PassportSource } from "./PassportSource.js";

/**
 * The fields of `Passport` in packages/indexer/schema.graphql that the verifier
 * needs. Envio's Cloud API is Hasura, so the cursor is a plain `_gt` on the id
 * with an ascending sort: no offset, which would drift while the index is still
 * syncing and could skip or repeat rows.
 */
const PASSPORT_QUERY = `query MoolamPassports($limit: Int!, $after: String!) {
  Passport(where: { id: { _gt: $after } }, order_by: { id: asc }, limit: $limit) {
    id
    phash
    blockhash
    creator { id }
    parent { id }
    registeredAt
    registeredBlock
    metadataURI
    attestationCount
    matchedCount
    mismatchedCount
    attestations(order_by: { at: desc }, limit: 1) {
      receiver
      matched
      distance
      at
    }
  }
}`;

const DEFAULT_PAGE_SIZE = 500;

/**
 * A stop so a server that ignores the cursor cannot spin forever. At the
 * default page size this is five million passports, far past anything the
 * registry will hold before this source is replaced by a streaming read.
 */
const MAX_PAGES = 10_000;

/**
 * Envio serves a GraphQL BigInt as a decimal string. A JSON number is accepted
 * too, but only while it is still exact: a 64-bit pHash past 2^53 would arrive
 * silently rounded, and a rounded fingerprint is a wrong answer, not a near one.
 */
const bigintish = z.union([z.string(), z.number()]).transform((value, ctx) => {
  if (typeof value === "number" && !Number.isSafeInteger(value)) {
    ctx.addIssue({ code: "custom", message: "arrived as a JSON number too large to be exact" });
    return z.NEVER;
  }
  const text = String(value);
  if (!/^[0-9]{1,20}$/.test(text)) {
    ctx.addIssue({ code: "custom", message: "must be a non-negative decimal integer" });
    return z.NEVER;
  }
  return BigInt(text);
});

const rowSchema = z.object({
  id: hex(32),
  phash: bigintish.refine((value) => value <= 0xffffffffffffffffn, "phash does not fit in 64 bits"),
  blockhash: hex(32),
  creator: z.object({ id: hex(20) }),
  parent: z.object({ id: hex(32) }).nullish(),
  registeredAt: bigintish.refine((value) => value <= BigInt(Number.MAX_SAFE_INTEGER), "registeredAt is out of range"),
  // Only settles which of two passports with one fingerprint came first, so a row recorded before
  // the index served it still loads and falls back to its timestamp. A value that is there but
  // wrong still throws, like every other field.
  registeredBlock: bigintish
    .refine((value) => value <= BigInt(Number.MAX_SAFE_INTEGER), "registeredBlock is out of range")
    .optional(),
  metadataURI: z.string(),
  // Taken as they arrive and checked in src/recheck.ts. A re-check field the index stops serving,
  // or serves badly, must not stop this page loading: a picture nobody can match is a far worse
  // answer than a picture with no second opinion attached.
  attestationCount: z.unknown().optional(),
  matchedCount: z.unknown().optional(),
  mismatchedCount: z.unknown().optional(),
  attestations: z.unknown().optional(),
});

const responseSchema = z.object({
  errors: z.array(z.object({ message: z.string() })).optional(),
  data: z.object({ Passport: z.array(rowSchema) }).optional(),
});

/**
 * Reads registered passports from the Envio index over GraphQL.
 *
 * The verifier never talks to a chain itself: Envio has already turned the
 * registry's events into rows, so one paged query gives the matcher the whole
 * corpus without an RPC provider, a reorg watcher or a log scan of its own.
 *
 * Each row also carries what the index knows about the picture's re-checks: the
 * three counts and the newest verdict, one nested row per passport and no more,
 * so a verify answer can say what the Chainlink workflow found without a lookup
 * of its own per verification.
 */
export class EnvioSource implements PassportSource {
  private readonly url: string;
  private readonly pageSize: number;

  constructor(opts: { url: string; pageSize?: number }) {
    const pageSize = opts.pageSize ?? DEFAULT_PAGE_SIZE;
    if (!Number.isInteger(pageSize) || pageSize < 1) {
      throw new Error("EnvioSource pageSize must be a whole number of at least 1");
    }
    this.url = opts.url;
    this.pageSize = pageSize;
  }

  /**
   * Fetches every passport, one page at a time, ordered by id.
   *
   * Stops on the first short page, which is how Hasura says "that was the
   * last one". Throws when the endpoint is unreachable, answers with GraphQL
   * errors, returns a malformed row, or hands back a page that does not move
   * the cursor forward, because indexing nothing and reporting success would
   * tell every caller their image is unregistered.
   */
  async load(): Promise<IndexedRecord[]> {
    const records: IndexedRecord[] = [];
    let after = "";

    for (let page = 0; page < MAX_PAGES; page += 1) {
      const rows = await this.fetchPage(after);
      for (const row of rows) {
        records.push({
          id: row.id,
          phash: row.phash,
          blockhash: row.blockhash,
          creator: row.creator.id,
          parentId: row.parent?.id ?? null,
          registeredAt: Number(row.registeredAt),
          ...(row.registeredBlock === undefined ? {} : { registeredBlock: Number(row.registeredBlock) }),
          metadataURI: row.metadataURI,
          rechecks: rechecksFrom(row),
        });
      }

      if (rows.length < this.pageSize) {
        return records;
      }
      const last = rows[rows.length - 1];
      if (last === undefined || last.id <= after) {
        throw new Error(`ENVIO_GRAPHQL_URL ${this.url} returned a page that did not advance past ${after}`);
      }
      after = last.id;
    }

    throw new Error(`ENVIO_GRAPHQL_URL ${this.url} kept returning full pages after ${MAX_PAGES} of them`);
  }

  private async fetchPage(after: string): Promise<z.infer<typeof rowSchema>[]> {
    let response: Response;
    try {
      response = await fetch(this.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: PASSPORT_QUERY, variables: { limit: this.pageSize, after } }),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`ENVIO_GRAPHQL_URL ${this.url} could not be reached: ${detail}`);
    }

    if (!response.ok) {
      throw new Error(`ENVIO_GRAPHQL_URL ${this.url} returned ${response.status}`);
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new Error(`ENVIO_GRAPHQL_URL ${this.url} did not return JSON`);
    }

    const parsed = responseSchema.safeParse(body);
    if (!parsed.success) {
      const detail = parsed.error.issues
        .slice(0, 5)
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ");
      throw new Error(`ENVIO_GRAPHQL_URL ${this.url} returned a bad passport page: ${detail}`);
    }
    if (parsed.data.errors !== undefined && parsed.data.errors.length > 0) {
      const detail = parsed.data.errors.map((entry) => entry.message).join("; ");
      throw new Error(`ENVIO_GRAPHQL_URL ${this.url} answered with GraphQL errors: ${detail}`);
    }
    if (parsed.data.data === undefined) {
      throw new Error(`ENVIO_GRAPHQL_URL ${this.url} returned no data block`);
    }
    return parsed.data.data.Passport;
  }
}
