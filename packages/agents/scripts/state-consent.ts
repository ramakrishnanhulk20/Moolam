import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { APIError } from "@privy-io/node";
import type { Hex, PublicClient } from "viem";
import { NotTheHolder, planWork, type BatchCall, type PlannedRow } from "../src/consent/calls.js";
import { loadPlan, PlanError, type Plan } from "../src/consent/plan.js";
import {
  consentDeployment,
  estimateBatchGas,
  holdersOf,
  latestConsents,
  monadClient,
  simulate,
  type ConsentDeployment,
} from "../src/consent/reads.js";
import { matchesStatement, USE_FIELDS, type OnChainEntry, type Statement } from "../src/consent/statements.js";
import { ownerContext, privyErrorText } from "../src/privy/client.js";
import {
  readStore,
  sendFromWallet,
  SponsoredSendFailed,
  SponsoredSendPending,
} from "../src/privy/serverWallet.js";
import { heading, renderTable, verdict } from "../src/prove/table.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = join(HERE, "..");
const REPO_ROOT = join(PACKAGE_ROOT, "..", "..");
const PLAN_FILE = join(PACKAGE_ROOT, "consent-plan.json");
const PROOF_FILE = join(REPO_ROOT, "proofs", "consent-statements.txt");

const EXPLORER_TX = "https://monadvision.com/tx/";

/** An address with no key behind it, used to show the contract refusing anyone but the holder. */
const STRANGER = "0x000000000000000000000000000000000000dEaD" as Hex;

const USAGE = [
  "Usage:",
  "  npm run consent:state              read the chain, print the plan, simulate every call, send nothing",
  "  npm run consent:state -- --send    the same, then write the statements from the creator's wallet",
].join("\n");

interface Options {
  send: boolean;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options === undefined) {
    console.log(USAGE);
    return;
  }

  const say = (line = "") => console.log(line);

  const plan = loadPlan(PLAN_FILE);
  const deployment = consentDeployment();
  const client = monadClient();
  const wallet = creatorWallet();

  say(`Moolam consent, live on Monad mainnet (chain ${deployment.chainId}).`);
  say(`Started  ${new Date().toISOString()}`);
  say(`Consent  ${deployment.consent}${deployment.consentBlock ? ` (deployed in block ${deployment.consentBlock})` : ""}`);
  say(`Registry ${deployment.registry}`);
  say(`Wallet   ${wallet.address}, the demo agent's Privy creator wallet`);
  say(`Plan     ${PLAN_FILE}`);
  say(`Mode     ${options.send ? "send" : "dry run, nothing is sent"}`);

  for (const line of heading("The statements this plan can make")) say(line);
  for (const line of statementTable(plan)) say(line);

  const ids = plan.entries.map((entry) => entry.passportId);
  const holders = await holdersOf(client, deployment.registry, ids);
  const latest = await latestConsents(client, deployment.consent, ids);
  const work = planWork(plan, { wallet: wallet.address, holders, latest });

  for (const line of heading(`The plan, against what the chain says right now (${ids.length} pictures)`)) say(line);
  for (const line of planTable(work.rows, latest)) say(line);

  if (work.calls.length === 0) {
    say();
    say("Every picture already carries the statement this plan asks for, so there is nothing to send.");
    return;
  }

  for (const line of heading("The calls")) say(line);
  const gas = new Map<BatchCall, bigint>();
  const rows: string[][] = [];
  let allPassed = true;
  for (const [index, call] of work.calls.entries()) {
    const limit = await estimateBatchGas(client, wallet.address, deployment.consent, call.data);
    gas.set(call, limit);
    const result = await simulate(client, wallet.address, deployment.consent, call.data);
    allPassed &&= result.passed;
    rows.push([
      String(index + 1),
      call.statement.name,
      String(call.passportIds.length),
      limit.toLocaleString("en-US"),
      `${(call.data.length - 2) / 2} bytes`,
      result.passed ? verdict(true) : `${verdict(false)} ${result.error}`,
    ]);
  }
  for (const line of renderTable(
    [
      { header: "#" },
      { header: "statement" },
      { header: "pictures", align: "right" },
      { header: "gas limit", align: "right" },
      { header: "calldata", align: "right" },
      { header: `simulated from ${wallet.address}` },
    ],
    rows,
  )) {
    say(line);
  }

  const first = work.calls[0];
  if (first !== undefined) {
    for (const line of heading("The same call from a stranger")) say(line);
    const refused = await simulate(client, STRANGER, deployment.consent, first.data);
    say(`From ${STRANGER}: ${refused.passed ? `${verdict(false)} the call went through` : refused.error}`);
    say("Holding the passport is the only authority the contract accepts, and it reads it fresh per picture.");
    allPassed &&= !refused.passed;
  }

  if (!options.send) {
    say();
    say(`${allPassed ? verdict(true) : verdict(false)}: every call was simulated against the live contract and nothing was sent.`);
    say("Run with --send to write these statements from the creator's wallet.");
    if (!allPassed) process.exitCode = 1;
    return;
  }

  if (!allPassed) {
    throw new Error("A simulated call was refused, so nothing is sent. Fix the plan and run the dry run again.");
  }
  await sendCalls({ client, deployment, wallet, calls: work.calls, gas, say });
}

interface CreatorWallet {
  id: string;
  address: Hex;
}

/**
 * The Privy wallet that holds the demo agent's pictures, read from the local record the earlier
 * scripts wrote. The same wallet that will send is the one the dry run simulates from, so the
 * simulation is about the real signer and not about a wallet chosen for the occasion.
 */
function creatorWallet(): CreatorWallet {
  const creator = readStore().creator;
  if (creator === undefined) {
    throw new Error(
      "There is no creator wallet in packages/agents/.moolam/wallets.json. Run npm run prove:privy once to create it.",
    );
  }
  return { id: creator.id, address: creator.address };
}

function parseArgs(argv: string[]): Options | undefined {
  if (argv.includes("--help") || argv.includes("-h")) return undefined;

  let send = false;
  for (const arg of argv) {
    if (arg === "--send") send = true;
    else if (arg !== "--dry-run") throw new Error(`I do not know the option ${arg}.\n${USAGE}`);
  }
  return { send };
}

function statementTable(plan: Plan): string[] {
  const rows = [...plan.statements.values()].map((statement) => [
    statement.name,
    ...USE_FIELDS.map((field) => statement.consent[field]),
    statement.constraintInfo.length === 0 ? "-" : statement.constraintInfo,
  ]);
  return renderTable(
    [
      { header: "name" },
      { header: "aiTraining" },
      { header: "aiGenerativeTraining" },
      { header: "aiInference" },
      { header: "dataMining" },
      { header: "constraintInfo" },
    ],
    rows,
  );
}

function planTable(rows: PlannedRow[], latest: Map<Hex, OnChainEntry>): string[] {
  const body = rows.map((row) => {
    const entry = latest.get(row.passportId);
    const now =
      entry === undefined
        ? "nothing stated"
        : `${describe(entry)} since ${new Date(Number(entry.at) * 1000).toISOString()}`;
    return [row.passportId, row.statement, "yes", now, row.action];
  });
  return renderTable(
    [
      { header: "passport" },
      { header: "statement" },
      { header: "held by this wallet" },
      { header: "on chain now" },
      { header: "action" },
    ],
    body,
  );
}

/** The four numbers of an entry as the four words, so the table reads the same as the plan does. */
function describe(entry: OnChainEntry): string {
  return USE_FIELDS.map((field) => `${field}=${entry.consent[field]}`).join(" ");
}

interface SendArgs {
  client: PublicClient;
  deployment: ConsentDeployment;
  wallet: CreatorWallet;
  calls: BatchCall[];
  gas: Map<BatchCall, bigint>;
  say: (line?: string) => void;
}

/**
 * Writes every batch from the creator's Privy wallet and proves each one by reading it back.
 *
 * Sponsorship is tried first and a refusal from Privy, which arrives before anything is submitted,
 * drops to the wallet paying for itself. Anything that is not a refusal stops the run instead:
 * that send may still be on its way, and sending the same batch twice would hit the ten minute
 * rule and revert.
 */
async function sendCalls(args: SendArgs): Promise<void> {
  const { client, deployment, wallet, calls, gas, say } = args;
  const owner = ownerContext();

  for (const line of heading("Writing the statements")) say(line);
  for (const [index, call] of calls.entries()) {
    const gasLimit = gas.get(call) ?? (await estimateBatchGas(client, wallet.address, deployment.consent, call.data));
    const request = {
      to: deployment.consent,
      data: call.data,
      gasLimit,
      chainId: deployment.chainId,
      context: owner,
    };

    let sent;
    try {
      sent = await sendFromWallet(wallet.id, { ...request, sponsor: true });
    } catch (error) {
      if (!isPrivyRefusal(error)) throw error;
      say(`  Privy refused the sponsored send: ${privyErrorText(error)}`);
      sent = await sendFromWallet(wallet.id, request);
    }

    const receipt = await client.waitForTransactionReceipt({ hash: sent.hash });
    if (receipt.status !== "success") {
      throw new Error(`Batch ${index + 1} (${call.statement.name}) reverted on chain in ${sent.hash}.`);
    }

    const written = await latestConsents(client, deployment.consent, call.passportIds);
    const proof: string[] = [];
    for (const passportId of call.passportIds) {
      const entry = written.get(passportId);
      if (entry === undefined || !matchesStatement(entry, call.statement)) {
        throw new Error(
          `${passportId} does not read back as "${call.statement.name}" after ${sent.hash}, so no proof was written.`,
        );
      }
      proof.push(
        [
          passportId,
          call.statement.name,
          sent.hash,
          `block ${receipt.blockNumber}`,
          `written ${new Date(Number(entry.at) * 1000).toISOString()}`,
          `by ${entry.writer}`,
        ].join("  "),
      );
    }

    say(
      `${index + 1}. ${call.statement.name} for ${call.passportIds.length} pictures: ${sent.hash} (sponsored: ${sent.sponsored ? "yes" : "no"})`,
    );
    say(`   ${EXPLORER_TX}${sent.hash}`);
    say(`   read back from the contract: all ${call.passportIds.length} carry this statement`);

    await mkdir(dirname(PROOF_FILE), { recursive: true });
    await appendFile(PROOF_FILE, `${proof.join("\n")}\n`, "utf8");
  }
  say(`Proof lines appended to ${PROOF_FILE}`);
}

/**
 * Whether Privy turned the send down before it submitted anything, which is the only case where
 * sending the same batch again is safe. A stall or a timeout is not a refusal.
 */
function isPrivyRefusal(error: unknown): boolean {
  if (error instanceof SponsoredSendPending || error instanceof SponsoredSendFailed) return false;
  if (!(error instanceof APIError)) return false;
  return typeof error.status === "number" && error.status >= 400 && error.status < 500;
}

// Running this file starts the run; importing it, as the tests do, does not. The comparison is
// lowercased because Windows hands back the drive letter in either case.
const entry = process.argv[1];
const here = fileURLToPath(import.meta.url).toLowerCase();
if (entry !== undefined && resolve(entry).toLowerCase() === here) {
  main().catch((error: unknown) => {
    if (error instanceof PlanError || error instanceof NotTheHolder) {
      console.error(error.message);
    } else {
      console.error(error instanceof Error ? error.message : error);
    }
    process.exitCode = 1;
  });
}
