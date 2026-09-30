import { getAddress, type Address, type Hex } from "viem";
import { env } from "../env.js";
import { AGENT_IDENTITY_REGISTRY } from "../metadata.js";
import { readClient } from "../reputation/registry.js";

/** ERC-721 ownerOf on the ERC-8004 identity registry: who owns an agent right now. */
const identityOwnerAbi = [
  {
    type: "function",
    name: "ownerOf",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "owner", type: "address" }],
  },
] as const;

/** The registry's getPassport, hand written like the unseal route's slice. */
const getPassportAbi = [
  {
    type: "function",
    name: "getPassport",
    stateMutability: "view",
    inputs: [{ name: "id", type: "bytes32" }],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "exactHash", type: "bytes32" },
          { name: "parentId", type: "bytes32" },
          { name: "creator", type: "address" },
          { name: "generatorAgentId", type: "uint256" },
          { name: "phash", type: "uint64" },
          { name: "blockhash256", type: "bytes32" },
          { name: "manifestHash", type: "bytes32" },
          { name: "kind", type: "uint8" },
          { name: "fingerprintVersion", type: "uint8" },
          { name: "registeredAt", type: "uint64" },
          { name: "disputed", type: "bool" },
          { name: "metadataURI", type: "string" },
        ],
      },
    ],
  },
] as const;

/** The fields of a registered passport that say whose it is and what it commits to. */
export interface ChainPassport {
  creator: Address;
  generatorAgentId: bigint;
  manifestHash: Hex;
  kind: number;
  metadataURI: string;
  registeredAt: bigint;
}

/** The three chain reads the platform routes make. Every answer is read at the moment it is asked. */
export interface PlatformChain {
  /** The latest block's timestamp in unix seconds: the clock every window here is read against. */
  now: () => Promise<bigint>;
  /** ownerOf(agentId) on the ERC-8004 identity registry. Throws when the agent does not exist. */
  agentOwner: (agentId: bigint) => Promise<Address>;
  /** The passport the registry holds for this id, or undefined when it holds none. */
  passport: (exactHash: Hex) => Promise<ChainPassport | undefined>;
}

/**
 * The live reads, through the service's one Monad transport. Every call throws what the RPC threw,
 * and each route turns that into its own answer rather than guessing a value.
 */
export function liveChain(): PlatformChain {
  const client = readClient();
  const registry = env.MOOLAM_REGISTRY_ADDRESS as Hex;
  return {
    now: async () => (await client.getBlock({ blockTag: "latest" })).timestamp,
    agentOwner: async (agentId) =>
      getAddress(
        await client.readContract({
          address: AGENT_IDENTITY_REGISTRY,
          abi: identityOwnerAbi,
          functionName: "ownerOf",
          args: [agentId],
        }),
      ),
    passport: async (exactHash) => {
      const record = await client.readContract({
        address: registry,
        abi: getPassportAbi,
        functionName: "getPassport",
        args: [exactHash],
      });
      // An id nobody registered comes back zeroed rather than reverting; registeredAt is the field
      // the registry itself tells the two apart by.
      if (record.registeredAt === 0n) {
        return undefined;
      }
      return {
        creator: getAddress(record.creator),
        generatorAgentId: record.generatorAgentId,
        manifestHash: record.manifestHash,
        kind: Number(record.kind),
        metadataURI: record.metadataURI,
        registeredAt: record.registeredAt,
      };
    },
  };
}
