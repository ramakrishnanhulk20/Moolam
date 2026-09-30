import { BaseError, ContractFunctionRevertedError, getAddress, zeroAddress, type Address } from "viem";
import type { ConsentCall } from "../consentRead.js";
import { env } from "../env.js";
import { AGENT_IDENTITY_REGISTRY } from "../metadata.js";
import { FACT_ENDPOINT_TIMEOUT_MS, monadTransport, readClient } from "../reputation/registry.js";
import type { Hex } from "../types.js";
import { holderOf, registryUnsealAbi } from "../unseal.js";
import { heldReads } from "./memory.js";

/** MoolamConsent's consentAt: the statement in force at a past moment, in consentOf's own shape. */
const consentAtAbi = [
  {
    type: "function",
    name: "consentAt",
    stateMutability: "view",
    inputs: [
      { name: "passportId", type: "bytes32" },
      { name: "timestamp", type: "uint64" },
    ],
    outputs: [
      { name: "stated", type: "bool" },
      {
        name: "inForce",
        type: "tuple",
        components: [
          { name: "at", type: "uint64" },
          { name: "writer", type: "address" },
          {
            name: "consent",
            type: "tuple",
            components: [
              { name: "aiTraining", type: "uint8" },
              { name: "aiGenerativeTraining", type: "uint8" },
              { name: "aiInference", type: "uint8" },
              { name: "dataMining", type: "uint8" },
            ],
          },
          { name: "constraintInfo", type: "string" },
        ],
      },
    ],
  },
] as const;

/** The three ERC-8004 identity reads get_agent makes. */
const identityAbi = [
  {
    type: "function",
    name: "ownerOf",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "owner", type: "address" }],
  },
  {
    type: "function",
    name: "getAgentWallet",
    stateMutability: "view",
    inputs: [{ name: "agentId", type: "uint256" }],
    outputs: [{ name: "wallet", type: "address" }],
  },
  {
    type: "function",
    name: "tokenURI",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "uri", type: "string" }],
  },
] as const;

/** A registered passport as getPassport returns it, the zero parent and agent turned into null. */
export interface ChainPassportRecord {
  creator: Address;
  parentId: Hex | null;
  generatorAgentId: bigint;
  manifestHash: Hex;
  kind: number;
  registeredAt: bigint;
  disputed: boolean;
  metadataURI: string;
}

/**
 * An agent as the identity registry holds it. `wallet` is null when the registry would not say,
 * and the zero address when it says none is set, which a transfer leaves behind.
 */
export interface ChainAgent {
  owner: Address;
  wallet: Address | null;
  uri: string;
}

/**
 * Every chain read the MCP server makes. Each throws when the chain could not be read, so a caller
 * can only ever be told "not found" by a read that answered.
 */
export interface McpChain {
  /** The newest block's timestamp in unix seconds. */
  headTime: () => Promise<number>;
  /** The passport the registry holds, or undefined when it holds none. */
  passport: (id: Hex) => Promise<ChainPassportRecord | undefined>;
  /** ownerOf on the registry: who holds the passport now. */
  holder: (id: Hex) => Promise<Address>;
  /** consentAt on MoolamConsent, in the shape consentRead's answerFromChain reads. */
  consentAt: (id: Hex, at: bigint) => Promise<Awaited<ReturnType<ConsentCall>>>;
  /** The agent, or undefined when ownerOf reverts because no such token was minted. */
  agent: (agentId: bigint) => Promise<ChainAgent | undefined>;
}

/** How long one read may take in all, the same five seconds the verify facts get. */
const READ_TIMEOUT_MS = 5_000;

const ZERO_ID = `0x${"0".repeat(64)}`;

function within<T>(work: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const limit = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`the chain read took longer than ${READ_TIMEOUT_MS} ms`)), READ_TIMEOUT_MS);
  });
  return Promise.race([work, limit]).finally(() => {
    clearTimeout(timer);
  });
}

function reverted(error: unknown): boolean {
  return error instanceof BaseError && error.walk((inner) => inner instanceof ContractFunctionRevertedError) !== null;
}

/**
 * The live reads, through the service's one Monad transport with each endpoint held to
 * FACT_ENDPOINT_TIMEOUT_MS, so the fallback endpoint can answer inside the five seconds.
 */
export function liveMcpChain(): McpChain {
  const client = readClient({ transport: monadTransport({ timeout: FACT_ENDPOINT_TIMEOUT_MS }) });
  const registry = env.MOOLAM_REGISTRY_ADDRESS as Hex;
  const consent = env.CONSENT_ADDRESS as Hex;
  return {
    headTime: async () => Number((await within(client.getBlock({ blockTag: "latest" }))).timestamp),
    passport: async (id) => {
      const record = await within(
        client.readContract({ address: registry, abi: registryUnsealAbi, functionName: "getPassport", args: [id] }),
      );
      // An id nobody registered comes back zeroed rather than reverting; registeredAt is the field
      // the registry itself tells the two apart by.
      if (record.registeredAt === 0n) {
        return undefined;
      }
      return {
        creator: getAddress(record.creator),
        parentId: record.parentId.toLowerCase() === ZERO_ID ? null : (record.parentId.toLowerCase() as Hex),
        generatorAgentId: record.generatorAgentId,
        manifestHash: record.manifestHash.toLowerCase() as Hex,
        kind: Number(record.kind),
        registeredAt: record.registeredAt,
        disputed: record.disputed,
        metadataURI: record.metadataURI,
      };
    },
    holder: async (id) => getAddress(await within(holderOf(client, registry, id))),
    consentAt: async (id, at) =>
      await within(client.readContract({ address: consent, abi: consentAtAbi, functionName: "consentAt", args: [id, at] })),
    agent: async (agentId) => {
      let owner: Address;
      try {
        owner = getAddress(
          await within(
            client.readContract({ address: AGENT_IDENTITY_REGISTRY, abi: identityAbi, functionName: "ownerOf", args: [agentId] }),
          ),
        );
      } catch (error) {
        if (reverted(error)) {
          return undefined;
        }
        throw error;
      }
      const [wallet, uri] = await Promise.all([
        within(
          client.readContract({ address: AGENT_IDENTITY_REGISTRY, abi: identityAbi, functionName: "getAgentWallet", args: [agentId] }),
        ).then(
          (value) => getAddress(value),
          () => null,
        ),
        within(
          client.readContract({ address: AGENT_IDENTITY_REGISTRY, abi: identityAbi, functionName: "tokenURI", args: [agentId] }),
        ),
      ]);
      return { owner, wallet, uri };
    },
  };
}

/** Reads that fail at once without opening a connection: the default under a test runner. */
export function offlineMcpChain(): McpChain {
  const offline = async (): Promise<never> => {
    throw new Error("this host makes no chain reads under a test runner");
  };
  return { headTime: offline, passport: offline, holder: offline, consentAt: offline, agent: offline };
}

/**
 * The same reads behind short memories (M5). A passport, its holder and its terms can change with
 * the next block, so they are held ten seconds, the consent reader's own figure; the head moves
 * every half second, so it is held two; an agent's owner and card are held a minute, as the site
 * holds them. A read that throws is never held.
 */
export function heldChain(chain: McpChain): McpChain {
  const head = heldReads<number>({ ttlMs: 2_000, maxEntries: 1 });
  const passports = heldReads<ChainPassportRecord | undefined>({ ttlMs: 10_000, maxEntries: 2_000 });
  const holders = heldReads<Address>({ ttlMs: 10_000, maxEntries: 2_000 });
  const terms = heldReads<Awaited<ReturnType<ConsentCall>>>({ ttlMs: 10_000, maxEntries: 2_000 });
  const agents = heldReads<ChainAgent | undefined>({ ttlMs: 60_000, maxEntries: 500 });
  return {
    headTime: async () => await head.read("head", chain.headTime),
    passport: async (id) => await passports.read(id, async () => await chain.passport(id)),
    holder: async (id) => await holders.read(id, async () => await chain.holder(id)),
    consentAt: async (id, at) => await terms.read(`${id}@${at}`, async () => await chain.consentAt(id, at)),
    agent: async (agentId) => await agents.read(agentId.toString(), async () => await chain.agent(agentId)),
  };
}

/** Whether an address is the zero address, which the identity registry uses for "no wallet set". */
export function isZeroAddress(address: Address): boolean {
  return address === zeroAddress;
}
