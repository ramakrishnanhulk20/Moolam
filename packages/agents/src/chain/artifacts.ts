import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Abi, Hex } from "viem";

const HERE = dirname(fileURLToPath(import.meta.url));

// Four levels up from src/chain lands on packages/, where the contracts build output lives.
const FORGE_OUT = join(HERE, "..", "..", "..", "contracts", "out");

export type ContractName = "VerifierPolicy" | "MoolamRegistry" | "MoolamReceiver";

export interface Artifact {
  abi: Abi;
  bytecode: Hex;
}

interface ForgeArtifact {
  abi: Abi;
  bytecode: { object: string };
}

const cache = new Map<ContractName, Artifact>();

/**
 * Loads one contract's ABI and creation bytecode from the Foundry build output.
 *
 * Throws with the exact command to run when the build output is missing, because a fresh
 * clone has no out/ directory and the error otherwise reads as a broken import path.
 */
export function loadArtifact(name: ContractName): Artifact {
  const cached = cache.get(name);
  if (cached) return cached;

  const path = join(FORGE_OUT, `${name}.sol`, `${name}.json`);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw new Error(
      `No compiled artifact for ${name} at ${path}. Build the contracts first:\n` +
        `  cd packages/contracts && export PATH="$HOME/.foundry/bin:$PATH" && forge build`,
    );
  }

  const parsed = JSON.parse(raw) as ForgeArtifact;
  const object = parsed.bytecode?.object;
  if (!object || object === "0x") {
    throw new Error(
      `The artifact for ${name} at ${path} has no creation bytecode. Rebuild it:\n` +
        `  cd packages/contracts && export PATH="$HOME/.foundry/bin:$PATH" && forge build --force`,
    );
  }

  const artifact: Artifact = {
    abi: parsed.abi,
    bytecode: (object.startsWith("0x") ? object : `0x${object}`) as Hex,
  };
  cache.set(name, artifact);
  return artifact;
}

export const registryAbi = (): Abi => loadArtifact("MoolamRegistry").abi;
export const policyAbi = (): Abi => loadArtifact("VerifierPolicy").abi;
export const receiverAbi = (): Abi => loadArtifact("MoolamReceiver").abi;

/**
 * The slice of the canonical ERC-8004 Identity Registry this client calls. The live contract
 * overloads register three ways; only the one argument form and the reads are declared here.
 */
export const agentIdentityAbi = [
  {
    type: "function",
    name: "register",
    stateMutability: "nonpayable",
    inputs: [{ name: "agentURI", type: "string" }],
    outputs: [{ name: "agentId", type: "uint256" }],
  },
  {
    type: "function",
    name: "ownerOf",
    stateMutability: "view",
    inputs: [{ name: "agentId", type: "uint256" }],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "event",
    name: "Transfer",
    inputs: [
      { name: "from", type: "address", indexed: true },
      { name: "to", type: "address", indexed: true },
      { name: "tokenId", type: "uint256", indexed: true },
    ],
  },
] as const;
