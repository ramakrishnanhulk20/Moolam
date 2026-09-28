import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createWalletClient,
  custom,
  formatEther,
  formatGwei,
  http,
  isHex,
  parseTransaction,
  size,
  type Account,
  type Hex,
  type Transport,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { monad } from "viem/chains";
import { MONAD_MAINNET } from "../src/chain/addresses.js";
import { RegistryClient, type Passport } from "../src/chain/registry.js";
import {
  attestFromStranger,
  publicReceiver,
  receiverReplayAndWrongChain,
  reportFromFakeForwarder,
  type AttackContext,
  type AttackResult,
} from "../src/prove/attacks.js";
import {
  passportExists,
  proveContext,
  requiredKey,
  type Original,
  type ProveContext,
  type Signer,
} from "../src/prove/steps.js";
import { heading, verdict } from "../src/prove/table.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = join(HERE, "..");
const REPO_ROOT = join(PACKAGE_ROOT, "..", "..");
const ATTACKS_DIR = join(REPO_ROOT, "docs", "security", "attacks");

export const COMMAND = "npm run prove:receivers";

const USAGE = [
  `usage: ${COMMAND} -- --passport <id> [--live]`,
  "",
  "  --passport <id>  a passport already registered on the Moolam registry, 0x and 64 hex digits",
  "  --live           send the refused calls for real and rewrite the three transcripts in",
  "                   docs/security/attacks. Without it the run only reads and sends nothing.",
].join("\n");

/** The order prove.ts runs them in, so the transcripts read the same whichever command wrote them. */
export const RECEIVER_ATTACKS = [
  attestFromStranger,
  reportFromFakeForwarder,
  receiverReplayAndWrongChain,
] as const;

/** None of the three receiver attacks calls the verify service, so no service is started. */
const NO_VERIFY_SERVICE = "";

/**
 * Anything that would put a transaction on the network: eth_sendRawTransaction, its Sync variant,
 * eth_sendTransaction and wallet_sendCalls all match. Reads never start with a send prefix.
 */
const SEND_METHOD = /^(eth|wallet)_send/;

export interface Options {
  passport: Hex;
  live: boolean;
}

/**
 * Reads the command line. Returns undefined when help was asked for.
 *
 * Throws on a missing or malformed passport id, on a second --passport, and on any option it does
 * not know, so a typo can never turn into a run against the wrong record or a live run by accident.
 */
export function parseArgs(argv: string[]): Options | undefined {
  if (argv.includes("--help") || argv.includes("-h")) return undefined;

  let passport: Hex | undefined;
  let live = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--live") {
      live = true;
    } else if (arg === "--passport") {
      if (passport !== undefined) throw new Error(`Give --passport once.\n${USAGE}`);
      const value = argv[index + 1];
      if (value === undefined || !isHex(value, { strict: true }) || size(value) !== 32) {
        throw new Error(`--passport needs a passport id: 0x and 64 hex digits.\n${USAGE}`);
      }
      passport = value.toLowerCase() as Hex;
      index += 1;
    } else {
      throw new Error(`I do not know the option ${arg}.\n${USAGE}`);
    }
  }

  if (passport === undefined) throw new Error(`Say which passport to attack.\n${USAGE}`);
  return { passport, live };
}

/** The two parts of a registered passport the receiver attacks read. */
export type ChosenPassport = Pick<Original, "passportId" | "input">;

/**
 * Turns the registry's record of the requested passport into what the attacks need.
 *
 * `record` is undefined when the registry says the passport does not exist. Throws a plain
 * sentence when it is not registered, and when the registry answered for a different id than the
 * one asked for.
 */
export function choosePassport(requested: Hex, record: Passport | undefined): ChosenPassport {
  if (record === undefined || record.registeredAt === 0n) {
    throw new Error(
      `Passport ${requested} is not registered on the Moolam registry, so there is nothing to attack. Pass the id of a registered passport.`,
    );
  }
  if (record.exactHash.toLowerCase() !== requested.toLowerCase()) {
    throw new Error(
      `The registry answered for ${record.exactHash} when asked for ${requested}, so the run stops rather than attack the wrong record.`,
    );
  }
  if (record.kind !== 0 && record.kind !== 1 && record.kind !== 2) {
    throw new Error(`Passport ${requested} has kind ${record.kind}, which this client does not know.`);
  }

  return {
    passportId: requested,
    input: {
      exactHash: record.exactHash,
      parentId: record.parentId,
      creator: record.creator,
      generatorAgentId: record.generatorAgentId,
      phash: record.phash,
      blockhash256: record.blockhash256,
      manifestHash: record.manifestHash,
      kind: record.kind,
      fingerprintVersion: record.fingerprintVersion,
      metadataURI: record.metadataURI,
      // The chain keeps no signing deadline, and none of the receiver attacks signs anything.
      deadline: 0n,
    },
  };
}

/**
 * The attacks take a full Original, which prove.ts gets by registering a new passport. This run
 * registers nothing, so it hands over the record it read and refuses every other field loudly: if
 * an attack ever starts reading one, the run stops instead of attacking with undefined.
 */
export function originalFor(chosen: ChosenPassport): Original {
  return new Proxy(chosen, {
    get(target, key) {
      if (key === "passportId" || key === "input") return target[key];
      if (typeof key === "symbol") return undefined;
      throw new Error(
        `A receiver attack read original.${key}, and this run only has the passport id and its record. Run npm run prove instead.`,
      );
    },
  }) as unknown as Original;
}

/** What the refused sends cost. Monad bills the gas limit, not the gas used, so the limit is what counts. */
export function liveCost(gasLimits: bigint[], gasPrice: bigint): bigint {
  return gasLimits.reduce((total, gas) => total + gas * gasPrice, 0n);
}

/** Twice the estimate, so a gas price that moves between the check and the sends cannot strand a run halfway. */
export function enoughFor(balance: bigint, cost: bigint): boolean {
  return balance >= 2n * cost;
}

/** The transcript prove.ts writes, header and all, with this command's name in it. */
export function attackFileText(
  attack: AttackResult,
  run: { startedAt: Date; chainId: number; registry: Hex },
): string {
  const header = [
    `Moolam attack: ${attack.name}`,
    attack.refused ? "REFUSED" : "NOT REFUSED",
    "",
    `run         ${run.startedAt.toISOString()}`,
    `command     ${COMMAND}`,
    `network     Monad mainnet, chain ${run.chainId}`,
    `registry    ${run.registry}`,
    "",
  ];
  return `${[...header, attack.evidence].join("\n")}\n`;
}

/**
 * An RPC connection that answers every read from Monad and refuses every send. A refused send is
 * kept, still signed, so the run can say how many transactions --live would send and what gas
 * limit each one carries. Nothing it keeps ever leaves this process.
 */
function sendlessTransport(held: Set<Hex>): Transport {
  const upstream = http(MONAD_MAINNET.rpc)({ chain: monad });
  return custom(
    {
      async request({ method, params }: { method: string; params?: unknown }) {
        if (SEND_METHOD.test(method)) {
          const raw = Array.isArray(params) ? params[0] : undefined;
          if (typeof raw === "string" && isHex(raw)) held.add(raw);
          throw new Error("dry run: signed and held, never broadcast");
        }
        return upstream.request({ method, params } as never);
      },
    },
    // A retry would only ask the guard again, and each ask must be counted once.
    { retryCount: 0 },
  );
}

function sendlessWallet(account: Account, held: Set<Hex>): Signer {
  return createWalletClient({ account, chain: monad, transport: sendlessTransport(held) }) as Signer;
}

/** The same context with the deployer unable to send too, so the dry run sends nothing from anyone. */
function sendlessContext(ctx: ProveContext, held: Set<Hex>): ProveContext {
  const deployer = sendlessWallet(ctx.deployer.account, held);
  return {
    ...ctx,
    deployer,
    registry: new RegistryClient({
      publicClient: ctx.publicClient,
      walletClient: deployer,
      addresses: ctx.addresses,
    }),
  };
}

async function runAll(a: AttackContext): Promise<AttackResult[]> {
  const results: AttackResult[] = [];
  for (const run of RECEIVER_ATTACKS) results.push(await run(a));
  return results;
}

function gasLimitOf(raw: Hex): bigint {
  const gas = parseTransaction(raw).gas;
  if (gas === undefined) throw new Error("A held transaction carries no gas limit, so its cost cannot be estimated.");
  return gas;
}

const mon = (wei: bigint): string => `${Number(formatEther(wei)).toFixed(4)} MON`;

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options === undefined) {
    console.log(USAGE);
    return;
  }

  const say = (line = ""): void => console.log(line);
  const startedAt = new Date();
  const ctx = proveContext(say);
  const outsiderAccount = privateKeyToAccount(requiredKey("VERIFIER_PRIVATE_KEY"));
  const receiver = publicReceiver();
  const block = await ctx.publicClient.getBlockNumber();

  const record = (await passportExists(ctx, options.passport))
    ? await ctx.registry.getPassport(options.passport)
    : undefined;
  const chosen = choosePassport(options.passport, record);
  const original = originalFor(chosen);
  const balance = await ctx.publicClient.getBalance({ address: outsiderAccount.address });

  say(`Moolam receiver attacks, ${options.live ? "live: the refused calls are sent" : "dry run: reads only, nothing is sent"}`);
  say();
  say(`started     ${startedAt.toISOString()}`);
  say(`network     Monad mainnet, chain ${ctx.addresses.chainId}, block ${block}`);
  say(`registry    ${ctx.addresses.registry}`);
  say(`policy      ${ctx.addresses.policy}`);
  say(`receiver    ${receiver}, the public SimulationReceiver`);
  say(`passport    ${chosen.passportId}, registered ${new Date(Number(record?.registeredAt ?? 0n) * 1000).toISOString()}`);
  say(`outsider    ${outsiderAccount.address}, ${mon(balance)}`);

  const held = new Set<Hex>();
  const rehearsal = await runAll({
    ctx: sendlessContext(ctx, held),
    original,
    outsider: sendlessWallet(outsiderAccount, held),
    baseUrl: NO_VERIFY_SERVICE,
  });

  for (const line of heading("eth_call against the live contracts")) say(line);
  for (const attack of rehearsal) {
    const ethCall = attack.evidence.split("\n").find((line) => line.startsWith("eth_call"));
    say(`  ${verdict(attack.refused)}  ${attack.name}`);
    say(`        ${ethCall ?? attack.evidence.split("\n")[0] ?? ""}`);
  }

  const gasLimits = [...held].map(gasLimitOf);
  const gasPrice = await ctx.publicClient.getGasPrice();
  const cost = liveCost(gasLimits, gasPrice);
  const covered = enoughFor(balance, cost);
  for (const line of heading("What --live would spend")) say(line);
  say(`  transactions  ${gasLimits.length}, gas limits ${gasLimits.map((gas) => gas.toLocaleString("en-US")).join(" and ") || "none"}`);
  say(`  gas price     ${formatGwei(gasPrice)} gwei now`);
  say(`  cost          about ${mon(cost)}, paid by the outsider`);
  say(`  outsider      holds ${mon(balance)}, twice the cost is ${mon(2n * cost)}: ${covered ? "enough" : "NOT enough"}`);

  if (!options.live) {
    say();
    say("Dry run: nothing was sent and no file was written. Add --live to send the refused calls");
    say("and rewrite the three transcripts in docs/security/attacks.");
    process.exitCode = rehearsal.every((attack) => attack.refused) ? 0 : 1;
    return;
  }

  if (!covered) {
    throw new Error(
      `The outsider ${outsiderAccount.address} holds ${mon(balance)} and the run wants twice the ${mon(cost)} estimate before it sends anything. Top it up and run again.`,
    );
  }

  const outsider = createWalletClient({
    account: outsiderAccount,
    chain: monad,
    transport: http(MONAD_MAINNET.rpc),
  }) as Signer;
  const attacks = await runAll({ ctx, original, outsider, baseUrl: NO_VERIFY_SERVICE });

  for (const line of heading("Sent")) say(line);
  for (const attack of attacks) {
    say(`  ${verdict(attack.refused)}  ${attack.name}`);
    say(`        ${attack.evidence.split("\n")[0] ?? ""}`);
  }

  await mkdir(ATTACKS_DIR, { recursive: true });
  for (const attack of attacks) {
    const file = join(ATTACKS_DIR, `${attack.name}.txt`);
    await writeFile(
      file,
      attackFileText(attack, { startedAt, chainId: ctx.addresses.chainId, registry: ctx.addresses.registry }),
      "utf8",
    );
    say(`  saved ${file}`);
  }

  const allRefused = attacks.every((attack) => attack.refused);
  say();
  say(`${verdict(allRefused)}: ${attacks.filter((attack) => attack.refused).length} of ${attacks.length} receiver attacks refused.`);
  process.exitCode = allRefused ? 0 : 1;
}

// Running this file does the work; importing it, as the tests do, does not. The comparison is
// lowercased because Windows hands back the drive letter in either case.
const entry = process.argv[1];
const here = fileURLToPath(import.meta.url).toLowerCase();
if (entry !== undefined && resolve(entry).toLowerCase() === here) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
