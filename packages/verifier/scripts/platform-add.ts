// The only way a platform joins the list: a Moolam operator runs this, commits
// the changed platforms.json, and the list is public in git history from then
// on. No route of the service or the site writes it.
//
// 1. Make the key and the message both parties sign:
//    npx tsx scripts/platform-add.ts message --name "Acme Images" --agent-id 42 \
//      --owner 0x<agent owner> --creator 0x<creator wallet> --valid-from 1790000000 \
//      --origin https://acme.example --origin https://staging.acme.example
//    Each --origin is a site the platform opens Moolam's connect page from, written
//    exactly as the browser reports it: https, lowercase host, no default port,
//    no path. Both parties sign these origins along with everything else.
//    The key is printed once, for the operator to hand to the platform. It is
//    never written to a file; only its sha256 enters the list.
// 2. The agent's owner and the creator wallet each sign the printed typed data.
// 3. Add the entry with both signatures:
//    npx tsx scripts/platform-add.ts add --name ... --agent-id ... --owner ... \
//      --creator ... --valid-from ... --origin ... --key-hash 0x... --owner-sig 0x... --creator-sig 0x...
// Rotating a key, a creator wallet or the origins is step 1 and 2 again, then "rotate" with
// the same flags plus --replaces <old key hash>. The old entry gets validTo set
// to the new validFrom, so its earlier passports keep the label.

import { createHash, randomBytes } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { getAddress } from "viem";
import {
  canonicalOrigin,
  cleanName,
  loadPlatforms,
  nameProblem,
  originsProblem,
  onboardingTypedData,
  platformListSchema,
  platformRecordSchema,
  recordMessage,
  recordProblem,
  type PlatformRecord,
} from "../src/platforms/platforms.js";
import { SOURCE_DIR, syncPlatforms } from "./platforms-sync.js";

const LIST_FILE = path.join(SOURCE_DIR, "platforms.json");

class Refusal extends Error {}

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    name: { type: "string" },
    "agent-id": { type: "string" },
    owner: { type: "string" },
    creator: { type: "string" },
    "valid-from": { type: "string" },
    origin: { type: "string", multiple: true },
    "key-hash": { type: "string" },
    "owner-sig": { type: "string" },
    "creator-sig": { type: "string" },
    replaces: { type: "string" },
  },
});

function required(flag: keyof typeof values): string {
  const value = values[flag];
  if (typeof value !== "string" || value.trim() === "") throw new Refusal(`--${flag} is required`);
  return value.trim();
}

function unixSeconds(flag: keyof typeof values): number {
  const raw = required(flag);
  if (!/^[1-9][0-9]{0,15}$/.test(raw)) throw new Refusal(`--${flag} must be unix seconds`);
  return Number(raw);
}

/** Refuses any spelling the list would refuse rather than fixing it, and says the canonical one when there is one. */
function origins(): string[] {
  const given = values.origin ?? [];
  for (const origin of given) {
    const canonical = canonicalOrigin(origin);
    if (canonical !== null && canonical !== origin) throw new Refusal(`--origin ${origin} must be written as ${canonical}`);
  }
  const problem = originsProblem(given);
  if (problem !== null) throw new Refusal(`--origin: ${problem}`);
  return given;
}

function checksummed(flag: keyof typeof values): string {
  try {
    return getAddress(required(flag));
  } catch {
    throw new Refusal(`--${flag} is not an address`);
  }
}

/** The shared fields of every mode, cleaned the way the list stores them. */
function baseFields() {
  const name = cleanName(required("name"));
  const problem = nameProblem(name);
  if (problem !== null) throw new Refusal(problem);
  const agentId = required("agent-id");
  if (!platformRecordSchema.shape.agentId.safeParse(agentId).success || BigInt(agentId) >= 1n << 256n) {
    throw new Refusal("--agent-id must be a decimal ERC-8004 agent id above zero");
  }
  return {
    name,
    agentId,
    ownerAtOnboarding: checksummed("owner"),
    creatorWallet: checksummed("creator"),
    origins: origins(),
    validFrom: unixSeconds("valid-from"),
  };
}

async function currentList(): Promise<PlatformRecord[]> {
  const document: unknown = JSON.parse(readFileSync(LIST_FILE, "utf8"));
  const loaded = await loadPlatforms(document);
  if (!loaded.ok) throw new Refusal(`the list on disk is already refused: ${loaded.reason}`);
  return platformListSchema.parse(document);
}

/** Refuses anything the loader would refuse, then writes the list and the web app's copy. */
async function writeList(records: PlatformRecord[]): Promise<void> {
  const loaded = await loadPlatforms(records);
  if (!loaded.ok) throw new Refusal(`the list would be refused: ${loaded.reason}`);
  const temporary = `${LIST_FILE}.writing`;
  writeFileSync(temporary, `${JSON.stringify(records, null, 2)}\n`);
  renameSync(temporary, LIST_FILE);
  syncPlatforms();
}

function printMessage(): void {
  const fields = baseFields();
  const key = randomBytes(32);
  const keyHash = `0x${createHash("sha256").update(key).digest("hex")}`;
  const typed = onboardingTypedData(recordMessage({ ...fields, keyHash, acceptedAt: 1, ownerSignature: "", creatorSignature: "" }));
  console.log("Platform key, shown once. Hand it to the platform over a private channel. It is not saved anywhere:");
  console.log(`  ${key.toString("hex")}`);
  console.log(`Key hash (sha256 of those 32 bytes): ${keyHash}`);
  console.log(`Origins both parties are signing for: ${fields.origins.join(", ")}`);
  console.log("Typed data for the agent owner and the creator wallet to sign with signTypedData:");
  console.log(JSON.stringify(typed, (_key, value: unknown) => (typeof value === "bigint" ? value.toString() : value), 2));
}

async function buildRecord(acceptedAt: number): Promise<PlatformRecord> {
  const candidate = {
    ...baseFields(),
    keyHash: required("key-hash").toLowerCase(),
    acceptedAt,
    ownerSignature: required("owner-sig").toLowerCase(),
    creatorSignature: required("creator-sig").toLowerCase(),
  };
  const parsed = platformRecordSchema.safeParse(candidate);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Refusal(`entry refused at ${issue?.path.join(".") ?? "?"}: ${issue?.message ?? "invalid"}`);
  }
  const problem = await recordProblem(parsed.data);
  if (problem !== null) throw new Refusal(problem);
  return parsed.data;
}

async function add(): Promise<void> {
  const records = await currentList();
  const record = await buildRecord(Math.floor(Date.now() / 1000));
  await writeList([...records, record]);
  console.log(`Added "${record.name}" (agent ${record.agentId}, creator ${record.creatorWallet}). Commit platforms.json and the web copy.`);
}

async function rotate(): Promise<void> {
  const replaces = required("replaces").toLowerCase();
  const records = await currentList();
  const index = records.findIndex((record) => record.keyHash === replaces);
  const old = records[index];
  if (old === undefined) throw new Refusal("no entry has that key hash");
  if (old.validTo !== undefined) throw new Refusal("that entry was already retired");
  const record = await buildRecord(Math.floor(Date.now() / 1000));
  const retired = records.map((entry, at) => (at === index ? { ...entry, validTo: record.validFrom } : entry));
  await writeList([...retired, record]);
  console.log(`Rotated "${record.name}": the old entry ends at ${record.validFrom}. Commit platforms.json and the web copy.`);
}

try {
  const mode = positionals[0];
  if (mode === "message") printMessage();
  else if (mode === "add") await add();
  else if (mode === "rotate") await rotate();
  else throw new Refusal('the mode is one of "message", "add" or "rotate"');
} catch (error) {
  if (!(error instanceof Refusal)) throw error;
  console.error(`Refused: ${error.message}`);
  process.exitCode = 1;
}
