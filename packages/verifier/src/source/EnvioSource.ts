import { z } from "zod";
import { FETCH_TIMEOUT_MS } from "../env.js";
import { rechecksFrom } from "../recheck.js";
import type { IndexedRecord } from "../index.js";
import { MONAD_CHAIN_ID } from "../reputation/registry.js";
import type { IndexerProgress } from "../types.js";
import { hex } from "./hex.js";
import type { PassportSource, SourceLoad } from "./PassportSource.js";

/**
 * The fields of `Passport` in packages/indexer/schema.graphql that the verifier
 * needs. Envio's Cloud API is Hasura, so the cursor is a plain `_gt` on the id
 * with an ascending sort: no offset, which would drift while the index is still
 * syncing and could skip or repeat rows.
 */
const PASSPORT_PAGE = `Passport(where: { id: { _gt: $after } }, order_by: { id: asc }, limit: $limit) {
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
  }`;

const PASSPORT_QUERY = `query MoolamPassports($limit: Int!, $after: String!) {
  ${PASSPORT_PAGE}
}`;

/**
 * The first page also asks Envio how far it has indexed (review pass 10, V99). Both come out of one
 * request, so the progress was read no later than the first rows, and every passport registered up
 * to that block is in the list this load builds. chain_metadata is Envio's own view of its progress:
 * latest_processed_block is the newest block it has finished, and
 * timestamp_caught_up_to_head_or_endblock stays null until it has caught up with the chain once,
 * which is where a redeployed indexer replaying from its start block shows.
 */
const FIRST_PAGE_QUERY = `query MoolamPassportsAndProgress($limit: Int!, $after: String!) {
  chain_metadata {
    chain_id
    latest_processed_block
    timestamp_caught_up_to_head_or_endblock
  }
  ${PASSPORT_PAGE}
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
  // Read on its own in progressFrom, so a progress row the index serves badly costs this load its
  // word on freshness, which then reads stale, and never the passports themselves.
  data: z.object({ Passport: z.array(rowSchema), chain_metadata: z.unknown().optional() }).optional(),
});

const progressRowSchema = z.object({
  chain_id: z.union([z.number(), z.string()]),
  latest_processed_block: z.number().int().nonnegative().nullable(),
  timestamp_caught_up_to_head_or_endblock: z.string().nullable().optional(),
});

/** What the indexer said about itself on the first page: its newest processed block, and whether it is syncing. */
interface IndexerSays {
  block: number;
  syncing: boolean;
}

/**
 * The row for this chain, or null when there is none or it cannot be read. A block the indexer has
 * not set yet is null too: an indexer that has processed nothing can vouch for nothing.
 */
function progressFrom(metadata: unknown, chainId: number): IndexerSays | null {
  if (!Array.isArray(metadata)) {
    return null;
  }
  for (const entry of metadata) {
    const row = progressRowSchema.safeParse(entry);
    if (!row.success || Number(row.data.chain_id) !== chainId) {
      continue;
    }
    const block = row.data.latest_processed_block;
    if (block === null || !Number.isSafeInteger(block)) {
      return null;
    }
    const caughtUp = row.data.timestamp_caught_up_to_head_or_endblock;
    return { block, syncing: caughtUp === null || caughtUp === undefined || caughtUp.length === 0 };
  }
  return null;
}

/** The one chain read this source makes: a block's time, the newest block's when no number is given. A viem public client has it. */
export interface BlockReader {
  getBlock(args?: { blockNumber: bigint }): Promise<{ timestamp: bigint }>;
}

/** A block's time in unix seconds, or null for a read that failed or an answer that is not a time. */
async function blockTime(chain: BlockReader | undefined, blockNumber?: bigint): Promise<number | null> {
  if (chain === undefined) {
    return null;
  }
  try {
    const block = await (blockNumber === undefined ? chain.getBlock() : chain.getBlock({ blockNumber }));
    const time: unknown = block.timestamp;
    return typeof time === "bigint" && time >= 0n && time <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(time) : null;
  } catch {
    return null;
  }
}

/** Both block times, the indexer's newest block first, read side by side. Never rejects. */
type BlockTimes = Promise<[number | null, number | null]>;

async function progressOf(says: IndexerSays | null, times: BlockTimes | undefined): Promise<IndexerProgress | null> {
  const [blockAt, headAt] = (await times) ?? [null, null];
  if (says === null) {
    return null;
  }
  return { block: says.block, blockTime: blockAt, headTime: headAt, syncing: says.syncing };
}

/**
 * Reads registered passports from the Envio index over GraphQL.
 *
 * The passports never come from the chain itself: Envio has already turned the
 * registry's events into rows, so one paged query gives the matcher the whole
 * corpus without a reorg watcher or a log scan of its own.
 *
 * Each row also carries what the index knows about the picture's re-checks: the
 * three counts and the newest verdict, one nested row per passport and no more,
 * so a verify answer can say what the Chainlink workflow found without a lookup
 * of its own per verification.
 *
 * Each load also reads how far the indexer has got from Envio's chain_metadata, and asks the chain
 * for two block times, the indexer's newest block and the chain head, so the service can tell an
 * indexer that has stopped or is re-syncing from one that is current (review pass 10, V99). With no
 * `chain` both times are null, which the service reads as stale.
 */
export class EnvioSource implements PassportSource {
  private readonly url: string;
  private readonly pageSize: number;
  private readonly chain: BlockReader | undefined;
  private readonly chainId: number;

  constructor(opts: { url: string; pageSize?: number; chain?: BlockReader; chainId?: number }) {
    const pageSize = opts.pageSize ?? DEFAULT_PAGE_SIZE;
    if (!Number.isInteger(pageSize) || pageSize < 1) {
      throw new Error("EnvioSource pageSize must be a whole number of at least 1");
    }
    this.url = opts.url;
    this.pageSize = pageSize;
    this.chain = opts.chain;
    this.chainId = opts.chainId ?? MONAD_CHAIN_ID;
  }

  /** Every passport, read exactly as loadWithProgress reads them. */
  async load(): Promise<IndexedRecord[]> {
    return (await this.loadWithProgress()).records;
  }

  /**
   * Fetches every passport, one page at a time, ordered by id, and how far the indexer had read.
   *
   * Stops on the first short page, which is how Hasura says "that was the
   * last one". Throws when the endpoint is unreachable, answers with GraphQL
   * errors, returns a malformed row, or hands back a page that does not move
   * the cursor forward, because indexing nothing and reporting success would
   * tell every caller their image is unregistered.
   *
   * `progress` is null when the first page carried no readable chain_metadata row for this chain.
   * The two block times are read while the pages load, and each is null when the chain did not
   * answer; neither ever fails the load.
   */
  async loadWithProgress(): Promise<SourceLoad & { records: IndexedRecord[] }> {
    const records: IndexedRecord[] = [];
    let after = "";
    let says: IndexerSays | null = null;
    let times: BlockTimes | undefined;

    for (let page = 0; page < MAX_PAGES; page += 1) {
      const { rows, metadata } = await this.fetchPage(after, page === 0);
      if (page === 0) {
        says = progressFrom(metadata, this.chainId);
        const indexed = says === null ? Promise.resolve(null) : blockTime(this.chain, BigInt(says.block));
        times = Promise.all([indexed, blockTime(this.chain)]);
      }
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
        return { records, progress: await progressOf(says, times) };
      }
      const last = rows[rows.length - 1];
      if (last === undefined || last.id <= after) {
        throw new Error(`ENVIO_GRAPHQL_URL ${this.url} returned a page that did not advance past ${after}`);
      }
      after = last.id;
    }

    throw new Error(`ENVIO_GRAPHQL_URL ${this.url} kept returning full pages after ${MAX_PAGES} of them`);
  }

  private async fetchPage(
    after: string,
    withProgress: boolean,
  ): Promise<{ rows: z.infer<typeof rowSchema>[]; metadata: unknown }> {
    let response: Response;
    try {
      response = await fetch(this.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          query: withProgress ? FIRST_PAGE_QUERY : PASSPORT_QUERY,
          variables: { limit: this.pageSize, after },
        }),
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
    return { rows: parsed.data.data.Passport, metadata: parsed.data.data.chain_metadata };
  }
}
