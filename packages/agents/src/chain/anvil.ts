import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  bytesToHex,
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  parseEther,
  type Hex,
} from "viem";
import { mnemonicToAccount, privateKeyToAccount } from "viem/accounts";
import { AGENT_IDENTITY, KEYSTONE_FORWARDER, type Addresses } from "./addresses.js";
import { loadArtifact } from "./artifacts.js";

/** What a challenger stakes to flag a passport, the same figure the deploy script uses. */
export const DISPUTE_BOND = parseEther("1");

/**
 * Anvil's published default mnemonic. It is in Foundry's own documentation, it funds the ten
 * local accounts on a throwaway node, and it must never be used anywhere real money can land.
 */
export const ANVIL_TEST_PHRASE = "test test test test test test test test test test test junk";

/** One of anvil's ten prefunded local accounts. */
export function anvilAccount(index = 0) {
  return mnemonicToAccount(ANVIL_TEST_PHRASE, { addressIndex: index });
}

/** The private key behind one of anvil's prefunded local accounts. */
export function anvilPrivateKey(index = 0): Hex {
  const key = anvilAccount(index).getHdKey().privateKey;
  if (!key) throw new Error(`No private key for anvil account ${index}.`);
  return bytesToHex(key);
}

export interface AnvilFork {
  rpc: string;
  stop(): Promise<void>;
}

export const monadFork = (rpc: string) =>
  defineChain({
    id: 143,
    name: "Monad mainnet fork",
    nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
    rpcUrls: { default: { http: [rpc] } },
  });

function anvilPath(): string {
  const fromEnv = process.env.ANVIL_PATH;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;

  const local = join(homedir(), ".foundry", "bin", process.platform === "win32" ? "anvil.exe" : "anvil");
  if (existsSync(local)) return local;

  return "anvil";
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("Could not work out a free port for anvil."));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

async function waitForRpc(rpc: string, child: ChildProcess, log: string[]): Promise<void> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`anvil exited with code ${child.exitCode}:\n${log.join("")}`);
    }
    try {
      const response = await fetch(rpc, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      });
      const body = (await response.json()) as { result?: string };
      if (body.result) return;
    } catch {
      // anvil is not listening yet, which is the normal case for the first second or two.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`anvil did not answer on ${rpc} within 90 seconds:\n${log.join("")}`);
}

/**
 * Starts a local anvil forked from Monad mainnet, so every test runs against real chain state,
 * including the live ERC-8004 registry, without spending MON or waiting on a funded wallet.
 *
 * Throws when anvil is missing from the path, and when the fork does not answer in 90 seconds.
 */
export async function startAnvilFork(rpcUrl: string, port?: number): Promise<AnvilFork> {
  if (!rpcUrl) {
    throw new Error("startAnvilFork needs an RPC URL. Set MONAD_MAINNET_RPC_URL in the repo root .env.");
  }

  const chosen = port ?? (await freePort());
  const rpc = `http://127.0.0.1:${chosen}`;
  const log: string[] = [];

  const child = spawn(
    anvilPath(),
    ["--fork-url", rpcUrl, "--chain-id", "143", "--port", String(chosen), "--host", "127.0.0.1"],
    { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
  );

  child.stdout?.on("data", (chunk: Buffer) => log.push(chunk.toString()));
  child.stderr?.on("data", (chunk: Buffer) => log.push(chunk.toString()));
  child.on("error", (error) => log.push(`spawn failed: ${error.message}\n`));

  try {
    await waitForRpc(rpc, child, log);
  } catch (error) {
    child.kill();
    throw error;
  }

  return {
    rpc,
    async stop() {
      if (child.exitCode !== null) return;
      await new Promise<void>((resolve) => {
        child.once("exit", () => resolve());
        child.kill();
        setTimeout(() => {
          child.kill("SIGKILL");
          resolve();
        }, 5_000).unref();
      });
    },
  };
}

/**
 * Deploys the three Moolam contracts onto a fork and wires them together.
 *
 * This repeats what script/Deploy.s.sol does rather than calling it, because that script writes
 * deployments/monad-mainnet.json and would overwrite the record of the real mainnet deploy.
 * The ERC-8004 registry and the Chainlink forwarder are the real mainnet addresses, which is the
 * whole point of running on a fork.
 */
export async function deployToFork(rpc: string, deployerKey: Hex): Promise<Addresses> {
  const chain = monadFork(rpc);
  const account = privateKeyToAccount(deployerKey);
  const publicClient = createPublicClient({ chain, transport: http(rpc) });
  const walletClient = createWalletClient({ account, chain, transport: http(rpc) });

  const identityCode = await publicClient.getCode({ address: AGENT_IDENTITY });
  if (!identityCode || identityCode === "0x") {
    throw new Error(
      `The ERC-8004 Identity Registry at ${AGENT_IDENTITY} has no code on this fork. ` +
        "The RPC being forked is probably not Monad mainnet.",
    );
  }

  const deploy = async (name: Parameters<typeof loadArtifact>[0], args: unknown[]): Promise<Hex> => {
    const { abi, bytecode } = loadArtifact(name);
    const hash = await walletClient.deployContract({ abi, bytecode, args, chain, account });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success" || !receipt.contractAddress) {
      throw new Error(`Deploying ${name} on the fork failed in transaction ${hash}.`);
    }
    return receipt.contractAddress;
  };

  const policy = await deploy("VerifierPolicy", [
    account.address,
    account.address,
    account.address,
    DISPUTE_BOND,
  ]);
  const registry = await deploy("MoolamRegistry", [account.address, policy, AGENT_IDENTITY]);
  const receiver = await deploy("MoolamReceiver", [KEYSTONE_FORWARDER, registry]);

  const policyAbi = loadArtifact("VerifierPolicy").abi;
  for (const call of [
    { functionName: "bootstrapAddReceiver", args: [receiver] },
    { functionName: "finalizeBootstrap", args: [] },
  ]) {
    const hash = await walletClient.writeContract({
      address: policy,
      abi: policyAbi,
      functionName: call.functionName,
      args: call.args,
      chain,
      account,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") {
      throw new Error(`${call.functionName} on the fork failed in transaction ${hash}.`);
    }
  }

  return { registry, policy, receiver, agentIdentity: AGENT_IDENTITY, chainId: 143 };
}
