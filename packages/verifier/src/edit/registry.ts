import {
  BaseError,
  ContractFunctionRevertedError,
  encodeFunctionData,
  getAddress,
  type Hex,
  type PublicClient,
} from "viem";
import type { PassportInput } from "../generate/eip712.js";

/** Monad charges the gas limit rather than the gas used, so the estimate gets this much headroom. */
const GAS_MARGIN_PERCENT = 110n;

const PASSPORT_INPUT = {
  name: "p",
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
    { name: "metadataURI", type: "string" },
    { name: "deadline", type: "uint64" },
  ],
} as const;

/**
 * The slice of MoolamRegistry the edit route calls, hand written because the container ships only
 * this package's source and cannot read the Foundry build output.
 *
 * The errors matter as much as the functions: without them a refused edit comes back as raw bytes
 * and the answer cannot say which rule the registry enforced. Both Pausable errors are here for
 * the same reason, since appendEdit carries whenNotPaused.
 */
export const registryEditAbi = [
  {
    type: "function",
    name: "appendEdit",
    stateMutability: "nonpayable",
    inputs: [PASSPORT_INPUT, { name: "generatorSig", type: "bytes" }],
    outputs: [{ name: "tokenId", type: "uint256" }],
  },
  {
    type: "function",
    name: "ownerOf",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "passportExists",
    stateMutability: "view",
    inputs: [{ name: "id", type: "bytes32" }],
    outputs: [{ name: "", type: "bool" }],
  },
  { type: "error", name: "InvalidParent", inputs: [] },
  { type: "error", name: "ParentNotFound", inputs: [{ name: "parentId", type: "bytes32" }] },
  { type: "error", name: "InvalidExactHash", inputs: [] },
  { type: "error", name: "PassportAlreadyExists", inputs: [{ name: "passportId", type: "bytes32" }] },
  { type: "error", name: "InvalidKind", inputs: [] },
  { type: "error", name: "InvalidFingerprintVersion", inputs: [] },
  { type: "error", name: "EmptyMetadataURI", inputs: [] },
  { type: "error", name: "SignatureExpired", inputs: [{ name: "deadline", type: "uint64" }] },
  { type: "error", name: "NotParentOwner", inputs: [{ name: "caller", type: "address" }] },
  { type: "error", name: "InvalidCreator", inputs: [] },
  { type: "error", name: "InvalidAgentId", inputs: [] },
  { type: "error", name: "InvalidGeneratorSignature", inputs: [] },
  { type: "error", name: "UnknownAgent", inputs: [{ name: "agentId", type: "uint256" }] },
  { type: "error", name: "ERC721NonexistentToken", inputs: [{ name: "tokenId", type: "uint256" }] },
  { type: "error", name: "EnforcedPause", inputs: [] },
] as const;

type ReadClient = Pick<PublicClient, "readContract" | "estimateContractGas">;

/** A passport id is the token id, so the parent's NFT is addressed by the same 32 bytes. */
export function tokenIdOf(passportId: Hex): bigint {
  return BigInt(passportId);
}

/** Whether the registry already holds this passport. False for a parent id nobody registered. */
export async function passportExists(
  client: ReadClient,
  registry: Hex,
  passportId: Hex,
): Promise<boolean> {
  return (await client.readContract({
    address: registry,
    abi: registryEditAbi,
    functionName: "passportExists",
    args: [passportId],
  })) as boolean;
}

/**
 * Who holds the parent passport right now, read from the chain rather than from any index.
 *
 * This is the check the contract itself repeats, and reading it here is what turns a refusal into
 * a plain 403 instead of a paid-for revert. Throws when the token does not exist.
 */
export async function parentOwner(
  client: ReadClient,
  registry: Hex,
  parentId: Hex,
): Promise<Hex> {
  const owner = (await client.readContract({
    address: registry,
    abi: registryEditAbi,
    functionName: "ownerOf",
    args: [tokenIdOf(parentId)],
  })) as Hex;
  return getAddress(owner);
}

/** The calldata for one appendEdit. A human edit carries no agent, so the signature is empty. */
export function editCalldata(input: PassportInput, generatorSig: Hex = "0x"): Hex {
  return encodeFunctionData({
    abi: registryEditAbi,
    functionName: "appendEdit",
    args: [input, generatorSig],
  });
}

/**
 * What the edit will cost, plus a margin, measured from the owner's own address.
 *
 * This runs the call against current state before Privy is asked to sign anything, so a refusal
 * costs nothing and arrives with the registry's own error name on it. Throws whatever viem threw;
 * `revertName` reads the name back out.
 */
export async function estimateEditGas(
  client: ReadClient,
  registry: Hex,
  from: Hex,
  input: PassportInput,
  generatorSig: Hex = "0x",
): Promise<bigint> {
  const used = await client.estimateContractGas({
    address: registry,
    abi: registryEditAbi,
    functionName: "appendEdit",
    args: [input, generatorSig],
    account: from,
  });
  return (used * GAS_MARGIN_PERCENT) / 100n;
}

/** The custom error the registry raised, or undefined when the failure was not a revert. */
export function revertName(error: unknown): string | undefined {
  if (!(error instanceof BaseError)) return undefined;
  const reverted = error.walk((inner) => inner instanceof ContractFunctionRevertedError);
  return reverted instanceof ContractFunctionRevertedError ? reverted.data?.errorName : undefined;
}
