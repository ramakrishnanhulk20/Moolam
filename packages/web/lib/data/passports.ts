import { unstable_cache } from "next/cache";
import type { AbiEvent, Hex } from "viem";
import { readArt, type Art } from "@/components/passport/art";
import {
  CACHE_TAGS,
  DEPLOY_BLOCK,
  HOLD_SECONDS,
  METADATA_HOLD_SECONDS,
  addresses,
  chain,
  registryAbi,
} from "@/lib/chain/client";
import { USE_FIELDS, asUseWord, type Consent, type Statement, type UseField } from "@/lib/chain/consent";
import { isChainlinkReceiver } from "@/lib/chain/receivers";
import { passportTag } from "@/lib/chain/registry";
import { reaches, type DisputedReach } from "./lineage";
import { withUnseal } from "./unseal";
import { activeSource, envioUrl } from "./source";

/** One row of the latest-passports strip. */
export interface PassportSummary {
  id: Hex;
  creator: Hex;
  agentId: bigint;
  registeredAt: bigint;
  blockNumber: bigint;
}

export interface LatestPassports {
  source: "envio" | "chain";
  passports: PassportSummary[];
}

const registeredEvent = (registryAbi as AbiEvent[]).find(
  (item) => item.type === "event" && item.name === "PassportRegistered",
) as AbiEvent;

/** How far back the fallback scan walks when an RPC refuses a wide log range. */
const FALLBACK_SPAN = 1_000n;
const FALLBACK_CHUNKS = 50n;

/**
 * The newest passports, whichever index is live.
 *
 * Throws with the provider's own words when neither answers, because a strip
 * that quietly shows nothing looks the same as a registry with nothing in it.
 */
export async function latestPassports(limit = 6): Promise<LatestPassports> {
  const source = activeSource();
  return {
    source,
    passports: source === "envio" ? await fromEnvio(limit) : await fromChain(limit),
  };
}

async function fromEnvio(limit: number): Promise<PassportSummary[]> {
  const query = `query LatestPassports($limit: Int!) {
    Passport(order_by: { registeredAt: desc }, limit: $limit) {
      id
      creator { id }
      generator { id }
      registeredAt
      registeredBlock
    }
  }`;

  const response = await fetch(envioUrl(), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables: { limit } }),
    signal: AbortSignal.timeout(10_000),
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`the Envio endpoint answered ${response.status}`);
  }

  const body = (await response.json()) as {
    errors?: { message: string }[];
    data?: {
      Passport: {
        id: Hex;
        creator: { id: Hex };
        generator: { id: string } | null;
        registeredAt: string;
        registeredBlock: string;
      }[];
    };
  };

  if (body.errors !== undefined && body.errors.length > 0) {
    throw new Error(body.errors.map((entry) => entry.message).join("; "));
  }
  if (body.data === undefined) {
    throw new Error("the Envio endpoint returned no data block");
  }

  return body.data.Passport.map((row) => ({
    id: row.id,
    creator: row.creator.id,
    agentId: BigInt(row.generator?.id ?? "0"),
    registeredAt: BigInt(row.registeredAt),
    blockNumber: BigInt(row.registeredBlock),
  }));
}

/**
 * Reads the registry's own PassportRegistered events.
 *
 * One wide query is tried first, which the default endpoint allows. Providers
 * that cap the range refuse it, and the fallback then walks backwards from the
 * head in small windows until it has enough rows.
 */
async function fromChain(limit: number): Promise<PassportSummary[]> {
  const head = await chain.getBlockNumber();

  let logs;
  try {
    logs = await chain.getLogs({
      address: addresses.registry,
      event: registeredEvent,
      fromBlock: DEPLOY_BLOCK,
      toBlock: head,
    });
  } catch {
    logs = await scanBackwards(head, limit);
  }

  const newest = logs.slice(-limit).reverse();

  const times = await Promise.all(
    newest.map((log) =>
      chain.readContract({
        address: addresses.registry,
        abi: registryAbi,
        functionName: "getPassport",
        args: [log.topics[1] as Hex],
      }) as Promise<{ registeredAt: bigint }>,
    ),
  );

  return newest.map((log, index) => ({
    id: log.topics[1] as Hex,
    creator: `0x${(log.topics[2] as string).slice(26)}` as Hex,
    agentId: BigInt(log.topics[3] as string),
    registeredAt: times[index].registeredAt,
    blockNumber: log.blockNumber ?? 0n,
  }));
}

async function scanBackwards(head: bigint, limit: number) {
  const found: Awaited<ReturnType<typeof chain.getLogs>> = [];

  for (let chunk = 0n; chunk < FALLBACK_CHUNKS; chunk += 1n) {
    const toBlock = head - chunk * FALLBACK_SPAN;
    const fromBlock = toBlock - FALLBACK_SPAN + 1n;
    if (toBlock < DEPLOY_BLOCK) {
      break;
    }

    const page = await chain.getLogs({
      address: addresses.registry,
      event: registeredEvent,
      fromBlock: fromBlock < DEPLOY_BLOCK ? DEPLOY_BLOCK : fromBlock,
      toBlock,
    });
    found.unshift(...page);
    if (found.length >= limit) {
      return found;
    }
  }

  if (found.length === 0) {
    throw new Error(
      "this RPC endpoint caps how many blocks one log query may cover, and nothing was found in the window it allows. Point NEXT_PUBLIC_MONAD_RPC_URL at an endpoint with a wider range, or set NEXT_PUBLIC_ENVIO_GRAPHQL_URL",
    );
  }
  return found;
}

/** One row of a creator's or a generator's list of passports. */
export interface PassportListing {
  id: Hex;
  kind: number;
  registeredAt: bigint;
  registeredBlock: bigint;
  metadataURI: string;
}

const LISTING_FIELDS = "id kind registeredAt registeredBlock metadataURI";

/** One listing exactly as the index sends it, before the two counters become bigints. */
interface ListingRow {
  id: Hex;
  kind: number;
  registeredAt: string;
  registeredBlock: string;
  metadataURI: string;
}

const BY_GENERATOR = `query PassportsByGenerator($generator: String!, $limit: Int!) {
      Passport(where: { generator_id: { _eq: $generator } }, order_by: { registeredAt: desc }, limit: $limit) {
        ${LISTING_FIELDS}
      }
    }`;

/**
 * Every passport one creator registered, newest first.
 *
 * The address is lowercased because the index stores it that way, so a
 * checksummed address from a wallet still finds its rows. This reads Envio
 * only: the chain fallback would need a log scan per creator, which is a
 * different and much slower thing than the strip's one query.
 *
 * `offset` skips that many of the newest rows, which is how /mine reads the
 * pages after its first.
 */
export async function passportsByCreator(address: Hex, limit = 24, offset = 0): Promise<PassportListing[]> {
  return await listPassports(
    `query PassportsByCreator($creator: String!, $limit: Int!, $offset: Int!) {
      Passport(where: { creator_id: { _eq: $creator } }, order_by: [{ registeredAt: desc }, { id: desc }], limit: $limit, offset: $offset) {
        ${LISTING_FIELDS}
      }
    }`,
    { creator: address.toLowerCase(), limit, offset },
  );
}

/** Every passport one generating agent signed for, newest first. */
export async function passportsByGenerator(agentId: bigint | string, limit = 24): Promise<PassportListing[]> {
  return await listPassports(BY_GENERATOR, { generator: agentId.toString(), limit });
}

/**
 * The same list, held for a minute, for the agent page that draws it on every
 * visit. What is held is the index's own rows, because the two block numbers
 * are bigints by the time a caller sees them and a bigint cannot be stored.
 */
const heldGeneratorRows = unstable_cache(
  async (agentId: string, limit: number) => await listRows(BY_GENERATOR, { generator: agentId, limit }),
  ["moolam-passports-by-generator"],
  { revalidate: HOLD_SECONDS, tags: [CACHE_TAGS.index] },
);

export async function heldPassportsByGenerator(agentId: bigint | string, limit = 24): Promise<PassportListing[]> {
  return (await heldGeneratorRows(agentId.toString(), limit)).map(toListing);
}

function toListing(row: ListingRow): PassportListing {
  return {
    id: row.id,
    kind: row.kind,
    registeredAt: BigInt(row.registeredAt),
    registeredBlock: BigInt(row.registeredBlock),
    metadataURI: row.metadataURI,
  };
}

async function listPassports(query: string, variables: Record<string, unknown>): Promise<PassportListing[]> {
  return (await listRows(query, variables)).map(toListing);
}

async function listRows(query: string, variables: Record<string, unknown>): Promise<ListingRow[]> {
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

  const body = (await response.json()) as {
    errors?: { message: string }[];
    data?: { Passport: ListingRow[] };
  };

  if (body.errors !== undefined && body.errors.length > 0) {
    throw new Error(body.errors.map((entry) => entry.message).join("; "));
  }
  if (body.data === undefined) {
    throw new Error("the Envio endpoint returned no data block");
  }

  return body.data.Passport;
}

/**
 * Passports this tab watched Monad confirm, by lowercased creator, each with the
 * Date.now() it was confirmed at. An id leaves once the index lists it.
 *
 * Kept here, outside any one grid, so /mine opened a moment after a
 * registration knows what the studio knows. Replaced whole on every change,
 * never edited in place, so a grid can tell when it moved. Only a browser ever
 * writes to it.
 */
export type ConfirmedPassports = ReadonlyMap<string, ReadonlyMap<string, number>>;

let confirmed: ConfirmedPassports = new Map();
const confirmedListeners = new Set<() => void>();

function publishConfirmed(next: ConfirmedPassports): void {
  confirmed = next;
  for (const listener of confirmedListeners) {
    listener();
  }
}

export function confirmedPassports(): ConfirmedPassports {
  return confirmed;
}

export function subscribeConfirmedPassports(listener: () => void): () => void {
  confirmedListeners.add(listener);
  return () => {
    confirmedListeners.delete(listener);
  };
}

/**
 * Tells every grid for this creator that Monad holds this passport, so the grid
 * reads the index again until the row is there and never calls the account
 * empty in the meantime.
 */
export function awaitPassport(creator: Hex, id: Hex, at = Date.now()): void {
  const key = creator.toLowerCase();
  const ids = new Map(confirmed.get(key) ?? []);
  ids.set(id.toLowerCase(), at);
  publishConfirmed(new Map(confirmed).set(key, ids));
}

/** Drops the confirmed passports the index now lists for this creator. */
export function settleListedPassports(creator: Hex, rows: readonly { id: Hex }[]): void {
  const key = creator.toLowerCase();
  const held = confirmed.get(key);
  if (held === undefined) {
    return;
  }
  const left = new Map(held);
  for (const row of rows) {
    left.delete(row.id.toLowerCase());
  }
  if (left.size === held.size) {
    return;
  }
  const next = new Map(confirmed);
  if (left.size === 0) {
    next.delete(key);
  } else {
    next.set(key, left);
  }
  publishConfirmed(next);
}

/** Where the index says one passport was written: the block, and the transaction that carried it. */
export interface PassportRegistration {
  registeredBlock: bigint;
  txHash: Hex;
}

/**
 * The block and the transaction hash for one passport, or null when the index
 * has not seen it yet.
 *
 * The registry stores neither: a passport record carries its timestamp, and the
 * transaction that wrote it only exists in the log. So when a wallet answers a
 * send without a hash, this is where the receipt's transaction link comes from.
 * Ids are lowercased because the index stores a bytes32 that way.
 */
export async function passportRegistration(id: Hex): Promise<PassportRegistration | null> {
  return toRegistration(await registrationRow(id));
}

/**
 * The same read, held for a minute under this passport's own name.
 *
 * The passport page is built once and handed to everybody who asks inside that
 * minute, so this read cannot be the one thing on it that still waits for the
 * index. A write to the record drops the name and the page is built again.
 */
export async function heldRegistration(id: Hex): Promise<PassportRegistration | null> {
  const held = unstable_cache(
    async () => await registrationRow(id),
    ["moolam-passport-registration", id.toLowerCase()],
    { revalidate: HOLD_SECONDS, tags: [CACHE_TAGS.index, passportTag(id)] },
  );
  return toRegistration(await held());
}

/** The row with its block still a string, because a bigint cannot be held. */
type RegistrationRow = { registeredBlock: string; txHash: string };

function toRegistration(row: RegistrationRow | null): PassportRegistration | null {
  return row === null ? null : { registeredBlock: BigInt(row.registeredBlock), txHash: row.txHash as Hex };
}

async function registrationRow(id: Hex): Promise<RegistrationRow | null> {
  const query = `query PassportRegistration($id: String!) {
    Passport(where: { id: { _eq: $id } }, limit: 1) {
      registeredBlock
      txHash
    }
  }`;

  const response = await fetch(envioUrl(), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables: { id: id.toLowerCase() } }),
    signal: AbortSignal.timeout(10_000),
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`the Envio endpoint answered ${response.status}`);
  }

  const body = (await response.json()) as {
    errors?: { message: string }[];
    data?: { Passport: RegistrationRow[] };
  };

  if (body.errors !== undefined && body.errors.length > 0) {
    throw new Error(body.errors.map((entry) => entry.message).join("; "));
  }
  if (body.data === undefined) {
    throw new Error("the Envio endpoint returned no data block");
  }

  return body.data.Passport[0] ?? null;
}

/** What the index has counted for one generating agent, in the index's own field names. */
export interface GeneratorRecord {
  passportCount: number;
  matchedCount: number;
  mismatchedCount: number;
  disputesUpheld: number;
  /** 0 to 100, smoothed, from packages/indexer/src/trust.ts. */
  trustScore: number;
  firstSeenAt: bigint;
}

/**
 * The Generator row for one agent, or null when the index has never seen it
 * sign a passport.
 *
 * These counts exist only in the index: the registry stores the agent id on
 * each passport and nothing that adds them up. A page that shows them has to
 * say where they came from, which is what the "index" line under them does.
 */
export async function generatorRecord(agentId: bigint | string): Promise<GeneratorRecord | null> {
  const row = await generatorRow(agentId.toString());
  return row === null ? null : { ...row, firstSeenAt: BigInt(row.firstSeenAt) };
}

/**
 * The same row, held for a minute, for the agent page and the home story, which
 * both draw it on every visit.
 */
const heldGeneratorRow = unstable_cache(async (id: string) => await generatorRow(id), ["moolam-generator-row"], {
  revalidate: HOLD_SECONDS,
  tags: [CACHE_TAGS.index],
});

export async function heldGeneratorRecord(agentId: bigint | string): Promise<GeneratorRecord | null> {
  const row = await heldGeneratorRow(agentId.toString());
  return row === null ? null : { ...row, firstSeenAt: BigInt(row.firstSeenAt) };
}

/** The Generator row with its one counter still a string, so it can be held. */
type GeneratorRow = Omit<GeneratorRecord, "firstSeenAt"> & { firstSeenAt: string };

async function generatorRow(id: string): Promise<GeneratorRow | null> {
  const query = `query GeneratorById($id: String!) {
    Generator(where: { id: { _eq: $id } }) {
      passportCount
      matchedCount
      mismatchedCount
      disputesUpheld
      trustScore
      firstSeenAt
    }
  }`;

  const response = await fetch(envioUrl(), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables: { id } }),
    signal: AbortSignal.timeout(10_000),
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`the Envio endpoint answered ${response.status}`);
  }

  const body = (await response.json()) as {
    errors?: { message: string }[];
    data?: { Generator: GeneratorRow[] };
  };

  if (body.errors !== undefined && body.errors.length > 0) {
    throw new Error(body.errors.map((entry) => entry.message).join("; "));
  }
  if (body.data === undefined) {
    throw new Error("the Envio endpoint returned no data block");
  }

  return body.data.Generator[0] ?? null;
}

/** The word a passport carries in manifestHash when nothing was signed into the file. */
export const NO_MANIFEST = `0x${"0".repeat(64)}`;

/** Which half of the registry a view shows: the real pictures, or the seed test cards. */
export type PassportPictures = "real" | "test";

/**
 * What a sheet may be narrowed to by what the holder has said about AI use.
 *
 * Three of them are the index's own summary words. "none" is the other side of
 * the same field: a passport nobody has spoken for. A statement that answers
 * each use on its own terms is summarised "mixed" and is deliberately not one
 * of these, because no one of these four words would be true of it.
 */
export type PassportConsent = "open" | "closed" | "ask" | "none";

/** What the Explore grid may narrow the registry down to. Nothing set means everything. */
export interface PassportFilter {
  /** 0 Generated, 1 Captured, 2 Edited. */
  kind?: number;
  /** Only passports that pinned a C2PA manifest with the picture. */
  manifest?: boolean;
  /** Only passports an independent re-check has already been written for. */
  rechecked?: boolean;
  disputed?: boolean;
  /**
   * How the Disputed chip reaches the edits made from a disputed picture,
   * worked out in lib/data/lineage.ts before the query is built.
   *
   * Left out, the chip asks for the mark the registry itself wrote, which
   * misses every copy of a picture proven fake.
   */
  disputedReach?: DisputedReach;
  /**
   * What the holder has said about AI use of the picture.
   *
   * The index flattens the newest statement onto the passport itself, so this
   * is one indexed clause rather than a walk through every statement ever
   * written.
   */
  ai?: PassportConsent;
  /** An ERC-8004 agent id, as the index stores it. */
  generator?: string;
  /** Matched against the passport id. The index stores no title, so there is nothing else to match. */
  search?: string;
  /**
   * The real pictures on their own, or the seed test cards on their own.
   *
   * This one is not a where clause. The index stores no title, and the title in
   * the pinned metadata is the only thing that tells the two apart, so
   * passportWhere leaves it out and explorePassports sifts the rows it read
   * through the caller's own test.
   */
  pictures?: PassportPictures;
}

/** Where the last page stopped: the second its last row was registered in, and that row's id. */
export interface PassportCursor {
  registeredAt: string;
  id: string;
}

/**
 * The search term as the index can use it.
 *
 * Only the id is searchable: a title lives in the pinned metadata on IPFS and
 * the index never reads it. A term that already looks like an id is matched
 * from the front, anything shorter is matched anywhere inside one, and the two
 * SQL wildcards are dropped so a term cannot widen its own query.
 */
export function searchPattern(term: string | undefined): string | null {
  const clean = (term ?? "").trim().toLowerCase().replace(/[%_\\]/g, "");
  if (clean === "") {
    return null;
  }
  return clean.startsWith("0x") ? `${clean}%` : `%${clean}%`;
}

/**
 * The index's where clause for one set of chips, plus the cursor when there is one.
 *
 * The cursor is a pair rather than a timestamp on its own. Several passports can
 * be registered in the same second, and a plain "older than this second" would
 * drop every one of them that shared it with the last row of the page.
 */
export function passportWhere(filter: PassportFilter, cursor?: PassportCursor | null): Record<string, unknown> {
  const clauses: Record<string, unknown>[] = [];

  if (filter.kind !== undefined) {
    clauses.push({ kind: { _eq: filter.kind } });
  }
  if (filter.manifest === true) {
    clauses.push({ manifestHash: { _neq: NO_MANIFEST } });
  }
  if (filter.rechecked === true) {
    clauses.push({ attestationCount: { _gt: 0 } });
  }
  if (filter.disputed === true) {
    clauses.push(disputedClause(filter.disputedReach));
  }
  if (filter.ai !== undefined) {
    clauses.push(...consentClauses(filter.ai));
  }
  if (filter.generator !== undefined && filter.generator !== "") {
    clauses.push({ generator_id: { _eq: filter.generator } });
  }

  const pattern = searchPattern(filter.search);
  if (pattern !== null) {
    clauses.push({ id: { _ilike: pattern } });
  }

  if (cursor !== undefined && cursor !== null) {
    clauses.push({
      _or: [
        { registeredAt: { _lt: cursor.registeredAt } },
        { _and: [{ registeredAt: { _eq: cursor.registeredAt } }, { id: { _lt: cursor.id } }] },
      ],
    });
  }

  return clauses.length === 0 ? {} : { _and: clauses };
}

/**
 * What the Disputed chip asks the index for.
 *
 * A challenge that is upheld marks one passport, and every edit made from that
 * picture is a copy of something proven fake, so the chip has to cover both.
 * The index answers that itself where it has the field. Where it does not, the
 * ids were walked out of the parent links first and are named here, and an
 * empty list is the right answer for a registry with no upheld dispute on it.
 */
function disputedClause(reach: DisputedReach | undefined): Record<string, unknown> {
  if (reach === undefined) {
    return { disputed: { _eq: true } };
  }
  return reach === "field" ? { inheritedDisputed: { _eq: true } } : { id: { _in: [...reach.ids] } };
}

/**
 * What one AI-use chip asks the index for.
 *
 * The flag comes first in every case. `consentSummary` reads "none" both for a
 * passport nobody has spoken for and for a statement whose holder named no use
 * at all, so asking for the word alone would put the two of them on the same
 * sheet, and silence and a choice are not the same answer.
 */
function consentClauses(ai: PassportConsent): Record<string, unknown>[] {
  if (ai === "none") {
    return [{ consentStated: { _eq: false } }];
  }
  return [{ consentStated: { _eq: true } }, { consentSummary: { _eq: ai } }];
}

/** The statement that stands about one picture, as the index flattened it onto the passport. */
export interface PassportStatement {
  /** The plain summary the index worked out from the four uses. */
  summary: Statement;
  /** When it was written, in whole seconds, so a plate can print the date. */
  at: number;
  /** The four uses in the app's own words, never the contract's numbers. */
  uses: Consent;
}

/** The summary words the index writes. Anything else is a statement this build will not read. */
const SUMMARY_WORDS: readonly Statement[] = ["open", "closed", "ask", "mixed", "none"];

/** Which index column holds each of the four uses. */
const CONSENT_COLUMNS = {
  aiTraining: "consentAiTraining",
  aiGenerativeTraining: "consentAiGenerativeTraining",
  aiInference: "consentAiInference",
  dataMining: "consentDataMining",
} as const satisfies Record<UseField, string>;

/** One passport's consent columns, exactly as the index sends them. */
interface ConsentRow {
  consentStated: boolean;
  consentSummary: string;
  consentAt: string;
  consentAiTraining: number;
  consentAiGenerativeTraining: number;
  consentAiInference: number;
  consentDataMining: number;
}

/**
 * The statement on one row, or null where the holder has not written one.
 *
 * A use outside the contract's own enum, or a summary word this build does not
 * know, reads as no statement at all rather than as a guess. A plate then draws
 * silence, which is the one answer that can never claim a permission nobody
 * gave.
 */
export function statementFrom(row: ConsentRow): PassportStatement | null {
  if (!row.consentStated) {
    return null;
  }

  const summary = SUMMARY_WORDS.find((word) => word === row.consentSummary);
  if (summary === undefined) {
    return null;
  }

  const uses = {} as Consent;
  for (const field of USE_FIELDS) {
    const word = asUseWord(row[CONSENT_COLUMNS[field]]);
    if (word === undefined) {
      return null;
    }
    uses[field] = word;
  }

  const at = Number(row.consentAt);
  return Number.isSafeInteger(at) && at >= 0 ? { summary, at, uses } : null;
}

/** One row of the Explore grid, as the index has it. The picture is read separately. */
export interface ExplorePassport {
  id: Hex;
  kind: number;
  registeredAt: bigint;
  registeredBlock: bigint;
  metadataURI: string;
  manifest: boolean;
  rechecked: boolean;
  /** True when one of those re-checks was written through one of the Chainlink receivers. */
  chainlink: boolean;
  /** The mark the registry itself wrote, which names one passport and nothing under it. */
  disputed: boolean;
  /** That mark, or the same one on any picture this was edited from. */
  inheritedDisputed: boolean;
  generatorId: string | null;
  /** What the holder has said about AI use, or null where nobody has spoken for it. */
  consent: PassportStatement | null;
}

export interface ExplorePage {
  passports: ExplorePassport[];
  /** Where to carry on from, or null when this was the last page. */
  cursor: PassportCursor | null;
}

/** How many rows one page of the grid asks for. */
export const EXPLORE_PAGE = 24;

/** How many pages a sifted view reads before it stops and hands back its cursor. */
const MAX_SCANS = 8;

/**
 * One page of the registry, newest first.
 *
 * Envio only: a filtered, paged list of every passport cannot be had from the
 * chain without replaying every log, so a missing index is an error the page
 * shows rather than a slower path it takes.
 *
 * When the filter names real or test pictures, the index cannot answer on its
 * own and `keep` decides which of the rows it returned belong on the page. Whole
 * pages are read and whole pages are kept, so the cursor always points at the
 * row the scan stopped on and "load more" cannot step over a passport that fell
 * in the middle of one. A registry that is all test cards stops at the scan cap
 * with a cursor rather than walking the whole index in one render.
 */
export async function explorePassports(input: {
  filter?: PassportFilter;
  cursor?: PassportCursor | null;
  limit?: number;
  keep?: (rows: ExplorePassport[]) => Promise<ExplorePassport[]>;
}): Promise<ExplorePage> {
  const filter = input.filter ?? {};
  const limit = input.limit ?? EXPLORE_PAGE;
  const sift = input.keep;

  let at = input.cursor ?? null;
  const held: ExplorePassport[] = [];

  for (let scan = 0; scan < MAX_SCANS; scan += 1) {
    const page = await readPage(filter, at, limit);
    held.push(...(sift === undefined ? page.passports : await sift(page.passports)));
    at = page.cursor;

    if (filter.pictures === undefined || at === null || held.length >= limit) {
      break;
    }
  }

  return { passports: held, cursor: at };
}

/** One row of the Explore query, exactly as the index sends it, counters and all. */
interface ExploreRow extends ConsentRow {
  id: Hex;
  kind: number;
  registeredAt: string;
  registeredBlock: string;
  metadataURI: string;
  manifestHash: string;
  disputed: boolean;
  inheritedDisputed?: boolean;
  attestationCount: number;
  attestations: { receiver: string }[];
  generator: { id: string } | null;
}

/** One straight read of the index, with no sifting and no second page. */
async function readPage(
  filter: PassportFilter,
  cursor: PassportCursor | null,
  limit: number,
): Promise<ExplorePage> {
  // The inherited mark is only asked for where the index has it. On a schema
  // without that column the same field would fail the whole query, so the flag
  // is read off the ids the walk worked out instead.
  const inheritedField = filter.disputedReach === "field" ? "inheritedDisputed" : "";

  const query = `query ExplorePassports($where: Passport_bool_exp!, $limit: Int!) {
    Passport(where: $where, order_by: [{ registeredAt: desc }, { id: desc }], limit: $limit) {
      id
      kind
      registeredAt
      registeredBlock
      metadataURI
      manifestHash
      disputed
      ${inheritedField}
      attestationCount
      attestations(limit: 5) { receiver }
      generator { id }
      consentStated
      consentSummary
      consentAt
      consentAiTraining
      consentAiGenerativeTraining
      consentAiInference
      consentDataMining
    }
  }`;

  const data = await askIndex<{ Passport: ExploreRow[] }>(query, {
    where: passportWhere(filter, cursor),
    limit,
  });

  const passports = data.Passport.map((row) => ({
    id: row.id,
    kind: row.kind,
    registeredAt: BigInt(row.registeredAt),
    registeredBlock: BigInt(row.registeredBlock),
    metadataURI: row.metadataURI,
    manifest: row.manifestHash.toLowerCase() !== NO_MANIFEST,
    rechecked: row.attestationCount > 0,
    chainlink: row.attestations.some((one) => isChainlinkReceiver(one.receiver)),
    disputed: row.disputed,
    inheritedDisputed: row.disputed || reaches(filter.disputedReach, row),
    generatorId: row.generator?.id ?? null,
    consent: statementFrom(row),
  }));

  const last = data.Passport[data.Passport.length - 1];
  return {
    passports,
    cursor:
      data.Passport.length < limit || last === undefined
        ? null
        : { registeredAt: last.registeredAt, id: last.id },
  };
}

/** The numbers over the grid. */
export interface RegistryCounts {
  total: number;
  generated: number;
  rechecked: number;
  /**
   * How many pictures carry a statement on AI use, counted by the index itself,
   * or null when it did not answer that counter. Null is printed as nothing at
   * all rather than as a zero, which would read as a registry where nobody has
   * spoken.
   */
  stated: number | null;
  /** True when a count reached the cap below and is a floor rather than a total. */
  capped: boolean;
}

/** How many ids one count query will ask for before it stops counting. */
const COUNT_CAP = 1_000;

/**
 * How many passports the index holds, how many of them were generated, how many
 * carry an independent re-check, and how many carry a statement on AI use.
 *
 * The index has no aggregate for the middle two, so they are counted by asking
 * for ids and nothing else, up to a cap. Reaching the cap is reported rather
 * than hidden: a number the page cannot stand behind should not be printed as a
 * total. The last one the index does keep a counter for, so it is a true total
 * whatever the cap does.
 */
export async function registryCounts(): Promise<RegistryCounts> {
  const query = `query RegistryCounts($cap: Int!) {
    GlobalStats(limit: 1) { passports passportsWithConsent }
    generated: Passport(where: { kind: { _eq: 0 } }, limit: $cap) { id }
    rechecked: Passport(where: { attestationCount: { _gt: 0 } }, limit: $cap) { id }
  }`;

  const data = await askIndex<{
    GlobalStats: { passports: number; passportsWithConsent: number | null }[];
    generated: { id: string }[];
    rechecked: { id: string }[];
  }>(query, { cap: COUNT_CAP });

  return {
    total: data.GlobalStats[0]?.passports ?? 0,
    generated: data.generated.length,
    rechecked: data.rechecked.length,
    stated: data.GlobalStats[0]?.passportsWithConsent ?? null,
    capped: data.generated.length === COUNT_CAP || data.rechecked.length === COUNT_CAP,
  };
}

/**
 * The same three numbers, held for a minute. It is the most expensive query the
 * Explore page makes, it is the same for everybody, and the index it counts
 * only moves on that cadence anyway.
 */
export const heldRegistryCounts = unstable_cache(async () => await registryCounts(), ["moolam-registry-counts"], {
  revalidate: HOLD_SECONDS,
  tags: [CACHE_TAGS.index],
});

/** One passport reduced to where its pinned metadata lives. */
export interface PassportMetadata {
  id: Hex;
  metadataURI: string;
}

/** How many rows the real-versus-test line reads before it stops counting. */
export const SPLIT_CAP = 200;

/**
 * Every passport in the index with the address of its metadata, newest first.
 *
 * What separates a real picture from a seed test card is the title in that
 * pinned document, which the index does not hold, so the page reads the
 * documents itself. Capped, and a caller that reached the cap says on screen
 * that its two numbers cover the newest rows rather than the whole registry.
 */
export async function passportMetadata(limit = SPLIT_CAP): Promise<PassportMetadata[]> {
  const query = `query PassportMetadata($limit: Int!) {
    Passport(order_by: [{ registeredAt: desc }, { id: desc }], limit: $limit) {
      id
      metadataURI
    }
  }`;

  const data = await askIndex<{ Passport: { id: Hex; metadataURI: string }[] }>(query, { limit });
  return data.Passport;
}

/** Thrown inside the held read when the gateway gave nothing back, so the miss is not kept. */
class GatewaySilent extends Error {
  constructor(metadataURI: string) {
    super(`the gateway gave nothing for ${metadataURI}`);
    this.name = "GatewaySilent";
  }
}

const heldDocumentRead = unstable_cache(
  async (metadataURI: string) => {
    const art = await readArt(metadataURI);
    // readArt writes the title key on every document it read, sealed or empty,
    // and leaves it off only when no gateway handed one over. A document that
    // was read and names nothing is still an answer, and is held like any other.
    if (!Object.hasOwn(art, "title")) {
      throw new GatewaySilent(metadataURI);
    }
    return art;
  },
  ["moolam-passport-art"],
  { revalidate: METADATA_HOLD_SECONDS, tags: [CACHE_TAGS.metadata] },
);

/**
 * A document that was read, as the cache kept it.
 *
 * The cache stores its answer as JSON, which drops a key whose value is
 * undefined, and the title key is what recordUnread (components/passport/unread.ts)
 * tells a read record by. Everything that comes out of the cache was read, so
 * the key is put back here, or an empty document would come back as unread.
 */
async function heldDocument(metadataURI: string): Promise<Art> {
  return { title: undefined, ...(await heldDocumentRead(metadataURI)) };
}

/**
 * One passport's pinned metadata, held for a day.
 *
 * This is the read that costs the grid its first byte: a page of the registry
 * is two dozen gateway fetches, each of them a second or more when the gateway
 * has not seen the document lately. The address is a content id, so the answer
 * can never change under it and the day is a floor rather than a risk.
 *
 * A gateway that says nothing at all is not kept. That failure is a bad minute
 * on somebody else's service, and remembering it for a day would cost a real
 * picture its place on the sheet long after the gateway came back. Anywhere
 * there is no cache to hold it in, a unit test for one, the document is simply
 * read: a picture is worth more than the saving.
 */
export async function heldArt(metadataURI: string, id?: Hex): Promise<Art> {
  let art: Art;
  try {
    art = await heldDocument(metadataURI);
  } catch (error) {
    if (error instanceof GatewaySilent || (error as Error | undefined)?.name === "GatewaySilent") {
      return { missing: true };
    }
    art = await readArt(metadataURI);
  }
  // Only a sealed document costs a lookup, and the answer to that one is held
  // under the passport's own name rather than with the document, because the
  // document can never change and the record can appear at any time.
  return await withUnseal(art, id);
}

/** One generating agent the index has seen, with everything it has counted for it. */
export interface GeneratorStanding extends GeneratorRecord {
  id: string;
}

/**
 * Every generator in the index, the busiest first.
 *
 * Ordering by passport count is what puts the two demo agents at the top: they
 * have signed the most, and nothing on this list is placed by hand.
 */
export async function generatorStandings(limit = 50): Promise<GeneratorStanding[]> {
  return (await standingRows(limit)).map((row) => ({ ...row, firstSeenAt: BigInt(row.firstSeenAt) }));
}

/**
 * The same roster, held for a minute, for the agents board that is built ahead
 * of time and refreshed on that cadence. What is held is the index's own rows,
 * because the first-seen stamp is a bigint by the time a caller sees it and a
 * bigint cannot be stored.
 */
function heldStandingRows(limit: number): Promise<StandingRow[]> {
  // The limit is part of the name. Held under one name for every limit, the
  // agents board asking for fifty would be answered with whatever shorter
  // roster a caller asking for five had put there a moment earlier.
  const held = unstable_cache(async () => await standingRows(limit), ["moolam-generator-standings", String(limit)], {
    revalidate: HOLD_SECONDS,
    tags: [CACHE_TAGS.index],
  });

  return held();
}

export async function heldGeneratorStandings(limit = 50): Promise<GeneratorStanding[]> {
  return (await heldStandingRows(limit)).map((row) => ({ ...row, firstSeenAt: BigInt(row.firstSeenAt) }));
}

/** The roster rows with the one counter still a string, so they can be held. */
type StandingRow = Omit<GeneratorStanding, "firstSeenAt"> & { firstSeenAt: string };

async function standingRows(limit: number): Promise<StandingRow[]> {
  const query = `query GeneratorStandings($limit: Int!) {
    Generator(order_by: [{ passportCount: desc }, { trustScore: desc }], limit: $limit) {
      id
      passportCount
      matchedCount
      mismatchedCount
      disputesUpheld
      trustScore
      firstSeenAt
    }
  }`;

  const data = await askIndex<{ Generator: StandingRow[] }>(query, { limit });
  return data.Generator;
}

/**
 * One query to the index, with the endpoint's own words on any failure.
 *
 * A page that reads the registry has to be able to tell "nothing matched" from
 * "nobody answered", so everything here throws instead of returning an empty list.
 */
export async function askIndex<T>(query: string, variables: Record<string, unknown>): Promise<T> {
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
