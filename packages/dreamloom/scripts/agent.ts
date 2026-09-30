// Step 2 of Dreamloom's setup, after Ram has funded the wallet: register Dreamloom's ERC-8004 agent
// on Monad's identity registry, from the Dreamloom wallet, which becomes the agent's owner.
//
//   npm run setup:agent --workspace packages/dreamloom
//
// Reads DREAMLOOM_WALLET_KEY and MONAD_RPC_URL from packages/dreamloom/.env.local, writes
// DREAMLOOM_AGENT_ID there, and prints the transaction and the agent id. Costs about 0.042 MON.

import { AGENT_IDENTITY_REGISTRY } from "@moolam/platform";
import { getAddress, parseEventLogs, zeroAddress, type Address, type Hex } from "viem";
import { Refusal, invokedDirectly, runCli } from "./cli";
import { assertWritable, dreamloomEnvFile, readEnvFile, requiredValue, valueOf, writeEnvValue } from "./env-file";
import { dreamloomClients } from "./monad";

export const identityRegistryAbi = [
  {
    type: "function",
    name: "register",
    stateMutability: "nonpayable",
    inputs: [{ name: "agentURI", type: "string" }],
    outputs: [{ name: "agentId", type: "uint256" }],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
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

/**
 * Dreamloom's agent card: the ERC-8004 registration file, carried inline so no host has to stay up for
 * it. It says what Dreamloom is and nothing more; there are no services to list.
 */
export const AGENT_CARD_DOCUMENT = {
  type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
  name: "Dreamloom image generator",
  description: "The image generator behind Dreamloom, a demo site built to show the Moolam platform kit.",
  services: [],
  active: true,
} as const;

/** Written raw after the comma, the form Moolam's demo agent uses and every Moolam card reader decodes. */
export const AGENT_CARD = `data:application/json,${JSON.stringify(AGENT_CARD_DOCUMENT)}`;

export interface AgentRegistration {
  wallet: Address;
  agentId: bigint;
  tx: Hex;
}

/**
 * Registers Dreamloom's agent from the wallet `walletKey` opens and writes its id into `envFile` as
 * DREAMLOOM_AGENT_ID.
 *
 * The call is simulated before it is sent, and the id is read from the registry's own mint event in
 * the receipt, never from the simulation, since another registration landing first would shift it.
 *
 * Throws Refusal, before anything is sent, when `envFile` already has DREAMLOOM_AGENT_ID, when it
 * cannot be written, when the RPC is not Monad, and when the wallet already owns an agent (a lost id
 * is looked up, not paid for twice). Throws Error when the registration reverts or mints nothing to
 * the wallet.
 */
export async function registerAgent(options: { envFile: string; walletKey: string; rpcUrl: string }): Promise<AgentRegistration> {
  if (valueOf(readEnvFile(options.envFile), "DREAMLOOM_AGENT_ID") !== undefined) {
    throw new Refusal(`DREAMLOOM_AGENT_ID is already set in ${options.envFile}; nothing was sent`);
  }
  assertWritable(options.envFile);
  const { account, publicClient, walletClient } = await dreamloomClients(options.walletKey, options.rpcUrl);
  const wallet = getAddress(account.address);

  const owned = await publicClient.readContract({
    address: AGENT_IDENTITY_REGISTRY,
    abi: identityRegistryAbi,
    functionName: "balanceOf",
    args: [wallet],
  });
  if (owned > 0n) {
    throw new Refusal(`the wallet ${wallet} already owns an ERC-8004 agent; nothing was sent`);
  }

  const { request } = await publicClient.simulateContract({
    address: AGENT_IDENTITY_REGISTRY,
    abi: identityRegistryAbi,
    functionName: "register",
    args: [AGENT_CARD],
    account,
  });
  const tx = await walletClient.writeContract(request);
  const receipt = await publicClient.waitForTransactionReceipt({ hash: tx });
  if (receipt.status !== "success") {
    throw new Error(`the agent registration ${tx} reverted on chain`);
  }
  const minted = parseEventLogs({ abi: identityRegistryAbi, eventName: "Transfer", logs: receipt.logs }).filter(
    (log) => getAddress(log.address) === getAddress(AGENT_IDENTITY_REGISTRY) && log.args.from === zeroAddress && log.args.to === wallet,
  );
  const [mint] = minted;
  if (mint === undefined || minted.length !== 1) {
    throw new Error(`the transaction ${tx} landed without exactly one agent minted to ${wallet}`);
  }

  writeEnvValue(options.envFile, "DREAMLOOM_AGENT_ID", mint.args.tokenId.toString());
  return { wallet, agentId: mint.args.tokenId, tx };
}

async function main(): Promise<void> {
  const envFile = dreamloomEnvFile();
  const result = await registerAgent({
    envFile,
    walletKey: requiredValue(envFile, "DREAMLOOM_WALLET_KEY"),
    rpcUrl: requiredValue(envFile, "MONAD_RPC_URL"),
  });
  console.log(`Agent registered from ${result.wallet} in transaction ${result.tx}`);
  console.log(`Agent id: ${result.agentId} (written to ${envFile} as DREAMLOOM_AGENT_ID)`);
  console.log("Next: set DREAMLOOM_PASSKEY_RP_ID to Dreamloom's hostname, then npm run setup:passkey.");
}

if (invokedDirectly(import.meta.url)) runCli(main);
