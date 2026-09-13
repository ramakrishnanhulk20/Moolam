import type { AbiEvent, Hex } from "viem";
import { DEPLOY_BLOCK, addresses, chain, registryAbi } from "@/lib/chain/client";
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

/**
 * Every passport one creator registered, newest first.
 *
 * The address is lowercased because the index stores it that way, so a
 * checksummed address from a wallet still finds its rows. This reads Envio
 * only: the chain fallback would need a log scan per creator, which is a
 * different and much slower thing than the strip's one query.
 */
export async function passportsByCreator(address: Hex, limit = 24): Promise<PassportListing[]> {
  return await listPassports(
    `query PassportsByCreator($creator: String!, $limit: Int!) {
      Passport(where: { creator_id: { _eq: $creator } }, order_by: { registeredAt: desc }, limit: $limit) {
        ${LISTING_FIELDS}
      }
    }`,
    { creator: address.toLowerCase(), limit },
  );
}

/** Every passport one generating agent signed for, newest first. */
export async function passportsByGenerator(agentId: bigint | string, limit = 24): Promise<PassportListing[]> {
  return await listPassports(
    `query PassportsByGenerator($generator: String!, $limit: Int!) {
      Passport(where: { generator_id: { _eq: $generator } }, order_by: { registeredAt: desc }, limit: $limit) {
        ${LISTING_FIELDS}
      }
    }`,
    { generator: agentId.toString(), limit },
  );
}

async function listPassports(query: string, variables: Record<string, unknown>): Promise<PassportListing[]> {
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
    data?: {
      Passport: { id: Hex; kind: number; registeredAt: string; registeredBlock: string; metadataURI: string }[];
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
    kind: row.kind,
    registeredAt: BigInt(row.registeredAt),
    registeredBlock: BigInt(row.registeredBlock),
    metadataURI: row.metadataURI,
  }));
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
    data?: { Passport: { registeredBlock: string; txHash: string }[] };
  };

  if (body.errors !== undefined && body.errors.length > 0) {
    throw new Error(body.errors.map((entry) => entry.message).join("; "));
  }
  if (body.data === undefined) {
    throw new Error("the Envio endpoint returned no data block");
  }

  const row = body.data.Passport[0];
  return row === undefined ? null : { registeredBlock: BigInt(row.registeredBlock), txHash: row.txHash as Hex };
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
    body: JSON.stringify({ query, variables: { id: agentId.toString() } }),
    signal: AbortSignal.timeout(10_000),
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`the Envio endpoint answered ${response.status}`);
  }

  const body = (await response.json()) as {
    errors?: { message: string }[];
    data?: {
      Generator: {
        passportCount: number;
        matchedCount: number;
        mismatchedCount: number;
        disputesUpheld: number;
        trustScore: number;
        firstSeenAt: string;
      }[];
    };
  };

  if (body.errors !== undefined && body.errors.length > 0) {
    throw new Error(body.errors.map((entry) => entry.message).join("; "));
  }
  if (body.data === undefined) {
    throw new Error("the Envio endpoint returned no data block");
  }

  const row = body.data.Generator[0];
  return row === undefined ? null : { ...row, firstSeenAt: BigInt(row.firstSeenAt) };
}

/** The word a passport carries in manifestHash when nothing was signed into the file. */
export const NO_MANIFEST = `0x${"0".repeat(64)}`;

/** What the Explore grid may narrow the registry down to. Nothing set means everything. */
export interface PassportFilter {
  /** 0 Generated, 1 Captured, 2 Edited. */
  kind?: number;
  /** Only passports that pinned a C2PA manifest with the picture. */
  manifest?: boolean;
  /** Only passports an independent re-check has already been written for. */
  rechecked?: boolean;
  disputed?: boolean;
  /** An ERC-8004 agent id, as the index stores it. */
  generator?: string;
  /** Matched against the passport id. The index stores no title, so there is nothing else to match. */
  search?: string;
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
    clauses.push({ disputed: { _eq: true } });
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

/** One row of the Explore grid, as the index has it. The picture is read separately. */
export interface ExplorePassport {
  id: Hex;
  kind: number;
  registeredAt: bigint;
  registeredBlock: bigint;
  metadataURI: string;
  manifest: boolean;
  rechecked: boolean;
  /** True when one of those re-checks was written through the Chainlink receiver. */
  chainlink: boolean;
  disputed: boolean;
  generatorId: string | null;
}

export interface ExplorePage {
  passports: ExplorePassport[];
  /** Where to carry on from, or null when this was the last page. */
  cursor: PassportCursor | null;
}

/** How many rows one page of the grid asks for. */
export const EXPLORE_PAGE = 24;

/**
 * One page of the registry, newest first.
 *
 * Envio only: a filtered, paged list of every passport cannot be had from the
 * chain without replaying every log, so a missing index is an error the page
 * shows rather than a slower path it takes.
 */
export async function explorePassports(input: {
  filter?: PassportFilter;
  cursor?: PassportCursor | null;
  limit?: number;
}): Promise<ExplorePage> {
  const limit = input.limit ?? EXPLORE_PAGE;
  const query = `query ExplorePassports($where: Passport_bool_exp!, $limit: Int!) {
    Passport(where: $where, order_by: [{ registeredAt: desc }, { id: desc }], limit: $limit) {
      id
      kind
      registeredAt
      registeredBlock
      metadataURI
      manifestHash
      disputed
      attestationCount
      attestations(limit: 5) { receiver }
      generator { id }
    }
  }`;

  const data = await askIndex<{
    Passport: {
      id: Hex;
      kind: number;
      registeredAt: string;
      registeredBlock: string;
      metadataURI: string;
      manifestHash: string;
      disputed: boolean;
      attestationCount: number;
      attestations: { receiver: string }[];
      generator: { id: string } | null;
    }[];
  }>(query, { where: passportWhere(input.filter ?? {}, input.cursor), limit });

  const passports = data.Passport.map((row) => ({
    id: row.id,
    kind: row.kind,
    registeredAt: BigInt(row.registeredAt),
    registeredBlock: BigInt(row.registeredBlock),
    metadataURI: row.metadataURI,
    manifest: row.manifestHash.toLowerCase() !== NO_MANIFEST,
    rechecked: row.attestationCount > 0,
    chainlink: row.attestations.some((one) => one.receiver.toLowerCase() === addresses.receiver.toLowerCase()),
    disputed: row.disputed,
    generatorId: row.generator?.id ?? null,
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

/** The three numbers over the grid. */
export interface RegistryCounts {
  total: number;
  generated: number;
  rechecked: number;
  /** True when a count reached the cap below and is a floor rather than a total. */
  capped: boolean;
}

/** How many ids one count query will ask for before it stops counting. */
const COUNT_CAP = 1_000;

/**
 * How many passports the index holds, how many of them were generated, and how
 * many carry an independent re-check.
 *
 * The index has no aggregate to ask, so the last two are counted by asking for
 * ids and nothing else, up to a cap. Reaching the cap is reported rather than
 * hidden: a number the page cannot stand behind should not be printed as a total.
 */
export async function registryCounts(): Promise<RegistryCounts> {
  const query = `query RegistryCounts($cap: Int!) {
    GlobalStats(limit: 1) { passports }
    generated: Passport(where: { kind: { _eq: 0 } }, limit: $cap) { id }
    rechecked: Passport(where: { attestationCount: { _gt: 0 } }, limit: $cap) { id }
  }`;

  const data = await askIndex<{
    GlobalStats: { passports: number }[];
    generated: { id: string }[];
    rechecked: { id: string }[];
  }>(query, { cap: COUNT_CAP });

  return {
    total: data.GlobalStats[0]?.passports ?? 0,
    generated: data.generated.length,
    rechecked: data.rechecked.length,
    capped: data.generated.length === COUNT_CAP || data.rechecked.length === COUNT_CAP,
  };
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

  const data = await askIndex<{
    Generator: {
      id: string;
      passportCount: number;
      matchedCount: number;
      mismatchedCount: number;
      disputesUpheld: number;
      trustScore: number;
      firstSeenAt: string;
    }[];
  }>(query, { limit });

  return data.Generator.map((row) => ({ ...row, firstSeenAt: BigInt(row.firstSeenAt) }));
}

/**
 * One query to the index, with the endpoint's own words on any failure.
 *
 * A page that reads the registry has to be able to tell "nothing matched" from
 * "nobody answered", so everything here throws instead of returning an empty list.
 */
async function askIndex<T>(query: string, variables: Record<string, unknown>): Promise<T> {
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
