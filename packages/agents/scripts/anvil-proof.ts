import {
  createPublicClient,
  createWalletClient,
  http,
  type Hex,
  type PublicClient,
} from "viem";
import { MONAD_MAINNET, type Addresses } from "../src/chain/addresses.js";
import {
  anvilAccount,
  anvilPrivateKey,
  deployToFork,
  monadFork,
  startAnvilFork,
} from "../src/chain/anvil.js";
import { Kind, passportDigest, type PassportInput } from "../src/chain/eip712.js";
import { SoftwarePasskey } from "../src/chain/passkey.js";
import { RegistryClient } from "../src/chain/registry.js";

// The same measured fingerprints the contracts package uses in its live proof, from
// proofs/spike.txt. Nothing here is a made up number.
const ORIGINAL_SHA256 = "0xb95adc0cf9b3bb3af90bafa247b5a49dd5c5d50877537b47f7b000c5a573354c" as Hex;
const ORIGINAL_PHASH = 0x336b806a7e894e76n;
const ORIGINAL_BLOCKHASH =
  "0x000f003f187f3eff1878047c3c7d3c7b3e7f00ff01ff0007000300071fff3fff" as Hex;
const SIGNED_SHA256 = "0x7b4732f365aa235556b4b11b8916fd544f10acc034ae7e0b9e39068becae1a50" as Hex;
const SIGNED_MANIFEST_HASH =
  "0x43e6e3a61c1e49aae9135e12b0a6b354d0c56a27f11ca1cb2489cc5222e24e62" as Hex;
const STRIPPED_SHA256 = "0x9f0f2bde58513560923b5883ded38af5f13a15879f144fb17e44adde17252c35" as Hex;
const ZERO_BYTES32 = `0x${"00".repeat(32)}` as Hex;

const AGENT_CARD =
  'data:application/json,{"type":"https://eips.ethereum.org/EIPS/eip-8004#registration-v1",' +
  '"name":"Moolam demo generator","description":"The generator agent behind the Moolam demo. ' +
  'It signs the fingerprint of every image it makes, so each passport names the agent that made it.",' +
  '"services":[],"active":true}';

interface Step {
  what: string;
  gas: bigint;
  detail: string;
}

async function gasOf(client: PublicClient, hash: Hex): Promise<bigint> {
  const receipt = await client.getTransactionReceipt({ hash });
  return receipt.gasUsed;
}

/**
 * Every transaction mined between two block heights, with the gas each one used. The deploy
 * helper returns only addresses, so the deploy row is measured from the blocks it produced.
 */
async function minedBetween(
  client: PublicClient,
  from: bigint,
  to: bigint,
): Promise<{ gas: bigint; hashes: Hex[] }> {
  let gas = 0n;
  const hashes: Hex[] = [];
  for (let height = from + 1n; height <= to; height++) {
    const block = await client.getBlock({ blockNumber: height, includeTransactions: false });
    for (const hash of block.transactions) {
      gas += await gasOf(client, hash);
      hashes.push(hash);
    }
  }
  return { gas, hashes };
}

function table(steps: Step[]): string {
  const rows = steps.map((step, index) => ({
    n: String(index + 1),
    what: step.what,
    gas: step.gas.toLocaleString("en-US"),
    detail: step.detail,
  }));

  const width = (pick: (row: (typeof rows)[number]) => string, header: string) =>
    Math.max(header.length, ...rows.map((row) => pick(row).length));

  const wn = width((r) => r.n, "#");
  const ww = width((r) => r.what, "Step");
  const wg = width((r) => r.gas, "Gas used");

  const line = (n: string, what: string, gas: string, detail: string) =>
    `${n.padStart(wn)}  ${what.padEnd(ww)}  ${gas.padStart(wg)}  ${detail}`;

  const total = steps.reduce((sum, step) => sum + step.gas, 0n);

  return [
    line("#", "Step", "Gas used", "Transaction"),
    line("-".repeat(wn), "-".repeat(ww), "-".repeat(wg), "-".repeat(20)),
    ...rows.map((row) => line(row.n, row.what, row.gas, row.detail)),
    "",
    `Everything above, once: ${total.toLocaleString("en-US")} gas.`,
  ].join("\n");
}

async function main(): Promise<void> {
  console.log("Moolam registry client, proved against a local fork of Monad mainnet.");
  console.log("Nothing here spends MON. The ERC-8004 registry is the real one, forked.\n");

  const fork = await startAnvilFork(MONAD_MAINNET.rpc);
  try {
    const chain = monadFork(fork.rpc);
    const publicClient = createPublicClient({ chain, transport: http(fork.rpc) }) as PublicClient;

    const forkBlock = await publicClient.getBlockNumber({ cacheTime: 0 });
    console.log(`Forked Monad mainnet at block ${forkBlock.toLocaleString("en-US")}.\n`);

    const creatorAccount = anvilAccount(1);
    const agentOwnerAccount = anvilAccount(2);

    // cacheTime zero on both reads: viem caches the block height for its polling interval,
    // which would otherwise make the deploy look like it mined nothing.
    const beforeDeploy = await publicClient.getBlockNumber({ cacheTime: 0 });
    const addresses: Addresses = await deployToFork(fork.rpc, anvilPrivateKey(0));
    const afterDeploy = await publicClient.getBlockNumber({ cacheTime: 0 });
    const deployed = await minedBetween(publicClient, beforeDeploy, afterDeploy);

    const client = (account: typeof creatorAccount) =>
      new RegistryClient({
        publicClient,
        walletClient: createWalletClient({ account, chain, transport: http(fork.rpc) }),
        addresses,
      });

    const creator = client(creatorAccount);
    const agentOwner = client(agentOwnerAccount);

    const passkey = SoftwarePasskey.random();
    const deadline = (await publicClient.getBlock()).timestamp + 3600n;

    const base = (overrides: Partial<PassportInput>): PassportInput => ({
      exactHash: ORIGINAL_SHA256,
      parentId: ZERO_BYTES32,
      creator: creatorAccount.address,
      generatorAgentId: 0n,
      phash: ORIGINAL_PHASH,
      blockhash256: ORIGINAL_BLOCKHASH,
      manifestHash: ZERO_BYTES32,
      kind: Kind.Captured,
      fingerprintVersion: 1,
      metadataURI: "ipfs://bafkreiggnfemzyzzrs6ba2ycklbfghbmpwd6mmzcy3rxhh4ovfxkfvvzsm",
      deadline,
      ...overrides,
    });

    const steps: Step[] = [
      {
        what: "Deploy policy, registry, receiver and wire them",
        gas: deployed.gas,
        detail: `${deployed.hashes.length} transactions, listed below`,
      },
    ];

    const bindHash = await creator.bindPasskey(passkey);
    steps.push({
      what: "Bind the creator's passkey",
      gas: await gasOf(publicClient, bindHash),
      detail: bindHash,
    });

    const captured = base({});
    const capturedResult = await creator.register(
      captured,
      passkey.sign(passportDigest(captured, creator.domain)),
      "0x",
    );
    steps.push({
      what: "Register the Captured photo",
      gas: capturedResult.gasUsed,
      detail: capturedResult.hash,
    });

    const agent = await agentOwner.registerAgentOnIdentityRegistry(AGENT_CARD);
    steps.push({
      what: `Register agent ${agent.agentId} on the real ERC-8004 registry`,
      gas: await gasOf(publicClient, agent.hash),
      detail: agent.hash,
    });

    const generated = base({
      exactHash: SIGNED_SHA256,
      manifestHash: SIGNED_MANIFEST_HASH,
      kind: Kind.Generated,
      generatorAgentId: agent.agentId,
    });
    const generatedResult = await creator.register(
      generated,
      passkey.sign(passportDigest(generated, creator.domain)),
      await agentOwner.signAsGenerator(generated),
    );
    steps.push({
      what: "Register the Generated image, co-signed by the agent",
      gas: generatedResult.gasUsed,
      detail: generatedResult.hash,
    });

    const edit = base({
      exactHash: STRIPPED_SHA256,
      parentId: SIGNED_SHA256,
      kind: Kind.Edited,
    });
    const editResult = await creator.appendEdit(edit, "0x");
    steps.push({
      what: "Append the edit to its parent",
      gas: editResult.gasUsed,
      detail: editResult.hash,
    });

    console.log(table(steps));

    console.log("\nWhat the chain says afterwards:");
    for (const [label, id] of [
      ["Captured", ORIGINAL_SHA256],
      ["Generated", SIGNED_SHA256],
      ["Edited", STRIPPED_SHA256],
    ] as const) {
      const record = await creator.getPassport(id);
      const owner = await creator.ownerOf(id);
      console.log(
        `  ${label.padEnd(9)} ${id}\n` +
          `            owner ${owner}, agent ${record.generatorAgentId}, ` +
          `parent ${record.parentId === ZERO_BYTES32 ? "none" : record.parentId}`,
      );
    }

    console.log("\nStep 1 in full, and the contracts it left on the fork:");
    const deployRows: [string, string][] = [
      ["policy            ", addresses.policy],
      ["registry          ", addresses.registry],
      ["receiver          ", addresses.receiver],
      ["list the receiver ", ""],
      ["close the bootstrap", ""],
    ];
    deployed.hashes.forEach((hash, index) => {
      const row = deployRows[index];
      console.log(`  ${row?.[0] ?? "step"} ${(row?.[1] ?? "").padEnd(42)} ${hash}`);
    });
    console.log(`  ERC-8004           ${addresses.agentIdentity} (real, forked from mainnet)`);
  } finally {
    await fork.stop();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
