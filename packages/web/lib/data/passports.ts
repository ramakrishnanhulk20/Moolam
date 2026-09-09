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
