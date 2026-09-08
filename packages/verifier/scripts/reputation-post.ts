import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { formatEther, getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { PACKAGE_ROOT, env } from "../src/env.js";
import { postFeedback, readReputation, type ReputationSummary } from "../src/reputation/feedback.js";
import { REPUTATION_REGISTRY, readClient } from "../src/reputation/registry.js";
import type { Hex } from "../src/types.js";

const REPO_ROOT = path.resolve(PACKAGE_ROOT, "..", "..");
const DEPLOYMENT_FILE = path.join(REPO_ROOT, "packages", "contracts", "deployments", "monad-mainnet.json");
const REPORT_FILE = path.join(REPO_ROOT, "kitchen", "reports", "WO-6a-reputation.txt");
const EXPLORER = "https://monadvision.com";

/** The one Moolam function this script reads: the passport tells us who to rate and what to point at. */
const moolamRegistryAbi = [
  {
    type: "function",
    name: "getPassport",
    stateMutability: "view",
    inputs: [{ name: "id", type: "bytes32" }],
    outputs: [
      {
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

const lines: string[] = [];

function say(line = ""): void {
  lines.push(line);
  console.log(line);
}

/** Appends to the report so the earlier findings in that file stay where they are. */
function flush(): void {
  appendFileSync(REPORT_FILE, `\n\n${"=".repeat(72)}\n${lines.join("\n")}\n`, "utf8");
}

interface Args {
  passport: Hex;
  matched: boolean;
  distance: number;
  agentId?: bigint;
}

function parseArgs(argv: string[]): Args {
  let passport: string | undefined;
  let matched = false;
  let distance = 0;
  let agentId: bigint | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--passport" && value !== undefined) {
      passport = value;
      i += 1;
    } else if (flag === "--matched") {
      matched = true;
    } else if (flag === "--distance" && value !== undefined) {
      distance = Number(value);
      i += 1;
    } else if (flag === "--agent" && value !== undefined) {
      agentId = BigInt(value);
      i += 1;
    } else {
      throw new Error(`unknown argument ${String(flag)}; use --passport 0x... [--matched] [--distance N] [--agent ID]`);
    }
  }

  if (passport === undefined || !/^0x[0-9a-fA-F]{64}$/.test(passport)) {
    throw new Error("--passport must be the 32 byte passport id, 0x followed by 64 hex characters");
  }
  if (!Number.isInteger(distance) || distance < 0 || distance > 64) {
    throw new Error("--distance must be a whole number of bits between 0 and 64");
  }
  return { passport: passport.toLowerCase() as Hex, matched, distance, agentId };
}

/**
 * The endpoint goes into a permanent public record, so a development URL is
 * dropped. A judge reading the entry should find either a service they can call
 * or nothing at all, never a link to somebody's laptop.
 */
function publicEndpoint(base: string): string {
  if (base.length === 0) {
    return "";
  }
  const host = new URL(base).hostname;
  const isLocal =
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "::1" ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2[0-9]|3[01])\./.test(host);
  return isLocal ? "" : base.replace(/\/$/, "");
}

function showSummary(label: string, summary: ReputationSummary): void {
  say(`  ${label}: count ${summary.count}, value ${summary.value}, decimals ${summary.decimals}`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (env.VERIFIER_PRIVATE_KEY === undefined || env.VERIFIER_ADDRESS === undefined) {
    throw new Error("VERIFIER_PRIVATE_KEY and VERIFIER_ADDRESS must both be set in the repo .env");
  }
  const signerKey = env.VERIFIER_PRIVATE_KEY as Hex;
  const expected = getAddress(env.VERIFIER_ADDRESS);
  // The summary is read for one client address, so a key and an address that
  // disagree would rate from one wallet and report on another.
  const derived = privateKeyToAccount(signerKey).address;
  if (derived !== expected) {
    throw new Error(`VERIFIER_PRIVATE_KEY signs for ${derived}, but VERIFIER_ADDRESS is ${expected}`);
  }

  const deployment = JSON.parse(readFileSync(DEPLOYMENT_FILE, "utf8")) as { registry: Hex; chainId: number };
  const reader = readClient();

  const passport = await reader.readContract({
    address: deployment.registry,
    abi: moolamRegistryAbi,
    functionName: "getPassport",
    args: [args.passport],
  });
  if (passport.registeredAt === 0n) {
    throw new Error(`passport ${args.passport} is not registered on ${deployment.registry}`);
  }

  const agentId = args.agentId ?? passport.generatorAgentId;
  const endpoint = publicEndpoint(env.VERIFIER_BASE_URL);
  const balance = await reader.getBalance({ address: expected });

  say(`Moolam reputation post, live on Monad mainnet (chain ${deployment.chainId}).`);
  say(`Started ${new Date().toISOString()}`);
  say(`Signer   ${expected}, from VERIFIER_PRIVATE_KEY, ${formatEther(balance)} MON`);
  say(`Registry ${REPUTATION_REGISTRY} (ERC-8004 Reputation Registry)`);
  say(`Passport ${args.passport}`);
  say(`  read from the Moolam registry ${deployment.registry}`);
  say(`  generator agent ${passport.generatorAgentId}, creator ${passport.creator}`);
  say(`  metadataURI ${passport.metadataURI}`);
  say(`Verification: matched ${String(args.matched)}, pHash distance ${args.distance} of 64 bits`);
  say();

  say("Summary before, from getSummary(agent, [signer], \"moolam\", \"verification\")");
  const before = await readReputation(agentId, { clients: [expected as Hex] });
  showSummary("before", before);
  say();

  const result = await postFeedback({
    agentId,
    matched: args.matched,
    distance: args.distance,
    passportId: args.passport,
    metadataURI: passport.metadataURI,
    endpoint,
    signerKey,
  });

  say("giveFeedback(agentId, value, valueDecimals, tag1, tag2, endpoint, feedbackURI, feedbackHash)");
  say(`  agentId       ${agentId}`);
  say(`  value         ${result.score} with 0 decimals`);
  say(`  tags          "moolam", "verification"`);
  say(`  endpoint      ${endpoint.length === 0 ? '"", the verifier has no public URL yet' : endpoint}`);
  say(`  feedbackURI   ${passport.metadataURI}`);
  say(`  feedbackHash  ${result.feedbackHash}`);
  say(`  hashed bytes  ${result.summaryJson}`);
  say(`  signed by     ${result.signer}, the verifier wallet, not the agent owner`);
  say(`  transaction   ${result.txHash}`);
  say(`                ${EXPLORER}/tx/${result.txHash}`);
  say(`  block         ${result.blockNumber}`);
  say(`  gas           ${result.gasUsed} used of a ${result.gasLimit} limit, and Monad bills the limit`);
  say();

  const after = await readReputation(agentId, { clients: [expected as Hex] });
  say("Summary after");
  showSummary("after", after);
  say(`  the count moved from ${before.count} to ${after.count}`);
  say(`Wallet left with ${formatEther(await reader.getBalance({ address: expected }))} MON`);
}

main()
  .then(() => {
    say();
    flush();
  })
  .catch((error: unknown) => {
    const detail = error instanceof Error ? error.message : String(error);
    say(`FAILED: ${detail}`);
    say();
    flush();
    process.exitCode = 1;
  });
