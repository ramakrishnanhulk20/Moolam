import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import { getAddress, isAddress, type Hex } from "viem";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..", "..", "..");

// The RPC URL lives in the repo root .env, one file for every package, so it has to be read
// before the MONAD_MAINNET constant below is built.
loadEnv({ path: join(REPO_ROOT, ".env"), quiet: true });

export const DEFAULT_DEPLOYMENT_FILE = join(
  REPO_ROOT,
  "packages",
  "contracts",
  "deployments",
  "monad-mainnet.json",
);

export const MONAD_MAINNET = {
  chainId: 143,
  rpc: process.env.MONAD_MAINNET_RPC_URL ?? "https://rpc.monad.xyz",
};

/** The canonical ERC-8004 Identity Registry on Monad mainnet. */
export const AGENT_IDENTITY: Hex = "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432";

/** The production Chainlink KeystoneForwarder on Monad mainnet. */
export const KEYSTONE_FORWARDER: Hex = "0x76c9cf548b4179F8901cda1f8623568b58215E62";

export interface Addresses {
  registry: Hex;
  policy: Hex;
  receiver: Hex;
  agentIdentity: Hex;
  chainId: number;
}

interface DeploymentFile {
  chainId?: number;
  registry?: string;
  policy?: string;
  receiver?: string;
  agentIdentity?: string;
}

/**
 * Reads the deployed addresses written by the Foundry deploy script.
 *
 * Throws a message naming the deploy command when the file is missing, and names the offending
 * field when one address is absent or malformed, so a half written file never silently produces
 * a client pointed at the zero address.
 */
export function loadDeployment(file: string = DEFAULT_DEPLOYMENT_FILE): Addresses {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    throw new Error(
      `No deployment file at ${file}. Deploy the contracts first:\n` +
        `  cd packages/contracts && npm run deploy:mainnet`,
    );
  }

  let parsed: DeploymentFile;
  try {
    parsed = JSON.parse(raw) as DeploymentFile;
  } catch (error) {
    throw new Error(`The deployment file at ${file} is not valid JSON: ${String(error)}`);
  }

  const pick = (field: keyof DeploymentFile): Hex => {
    const value = parsed[field];
    if (typeof value !== "string" || !isAddress(value)) {
      throw new Error(`The deployment file at ${file} has no valid "${field}" address.`);
    }
    return getAddress(value);
  };

  const chainId = parsed.chainId;
  if (typeof chainId !== "number" || !Number.isInteger(chainId) || chainId <= 0) {
    throw new Error(`The deployment file at ${file} has no valid "chainId".`);
  }

  return {
    registry: pick("registry"),
    policy: pick("policy"),
    receiver: pick("receiver"),
    agentIdentity: pick("agentIdentity"),
    chainId,
  };
}
