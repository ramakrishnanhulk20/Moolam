import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { recoverMessageAddress, type Hex } from "viem";
import { walletSigners } from "@moolam/verifier/src/edit/signers.js";
import { ownerContext, ownerPublicKey, privy, privyErrorText } from "../src/privy/client.js";
import { readStore } from "../src/privy/serverWallet.js";
import {
  currentSigners,
  grantSessionSigner,
  revokeSessionSigners,
} from "../src/privy/sessionSigner.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = join(HERE, "..");
const REPO_ROOT = join(PACKAGE_ROOT, "..", "..");
const ENV_FILE = join(REPO_ROOT, ".env");

/** What this quorum is called on the Privy dashboard, so a human can tell it from the others. */
const DISPLAY_NAME = "moolam-edit-signer";

const SIGNER_VARIABLE = "PRIVY_EDIT_SIGNER_ID";
const POLICY_VARIABLE = "PRIVY_EDIT_POLICY_ID";

/** A key quorum as Privy returns it, cut down to the fields that decide whether it is ours. */
export interface QuorumRecord {
  id: string;
  authorization_keys: { public_key: string }[];
  authorization_threshold: number | null;
  user_ids?: string[] | null;
  key_quorum_ids?: string[];
}

export interface QuorumCreateInput {
  public_keys: string[];
  display_name: string;
  authorization_threshold: number;
}

/**
 * The two Privy calls this script needs.
 *
 * There is no list call: the API and @privy-io/node 0.34.0 offer create, get, patch and delete on
 * key quorums and nothing else. So the id written into the root .env is how a later run finds the
 * quorum again, and the get below is what proves that id still names a quorum with the right key
 * in it rather than a dead handle.
 */
export interface QuorumApi {
  get(id: string): Promise<QuorumRecord>;
  create(input: QuorumCreateInput): Promise<QuorumRecord>;
}

export type QuorumAction = "found" | "created";

/**
 * The key quorum whose only member is `publicKey`, reusing `cachedId` when that id still names
 * exactly that quorum, and creating one when it does not.
 *
 * A cached id on its own is not evidence: the quorum behind it can be deleted, or can hold a
 * different key, and either would have Privy refuse every edit at signing time for a reason the
 * route cannot explain. So the members are read back and checked before the id is reused.
 */
export async function findOrCreateQuorum(
  api: QuorumApi,
  publicKey: string,
  cachedId: string | undefined,
): Promise<{ id: string; action: QuorumAction }> {
  if (cachedId !== undefined && cachedId.length > 0) {
    const live = await readQuorum(api, cachedId);
    if (live !== undefined && onlyMemberIs(live, publicKey)) {
      return { id: live.id, action: "found" };
    }
  }
  const created = await api.create({
    public_keys: [publicKey],
    display_name: DISPLAY_NAME,
    authorization_threshold: 1,
  });
  return { id: created.id, action: "created" };
}

/** True when the quorum authorizes that one key and nobody else: no users, no nested quorums. */
function onlyMemberIs(quorum: QuorumRecord, publicKey: string): boolean {
  const keys = quorum.authorization_keys ?? [];
  const users = quorum.user_ids ?? [];
  const nested = quorum.key_quorum_ids ?? [];
  return (
    keys.length === 1 && keys[0]?.public_key === publicKey && users.length === 0 && nested.length === 0
  );
}

async function readQuorum(api: QuorumApi, id: string): Promise<QuorumRecord | undefined> {
  try {
    return await api.get(id);
  } catch {
    return undefined;
  }
}

/** The value of one variable in the text of a .env file, or undefined when it has no such line. */
export function readEnvValue(text: string, name: string): string | undefined {
  for (const line of text.split("\n")) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line.trim());
    if (match !== null && match[1] === name) return (match[2] ?? "").trim();
  }
  return undefined;
}

/**
 * The same .env text with one variable set, replacing the line that is there or appending one.
 *
 * Every other line comes through byte for byte, comments and blanks included, because this writes
 * over the file that holds every key the project has.
 */
export function upsertEnvLine(text: string, name: string, value: string): string {
  let written = false;
  const updated = text.split("\n").map((line) => {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line.trim());
    if (match === null || match[1] !== name || written) return line;
    written = true;
    return `${name}=${value}`;
  });
  if (written) return updated.join("\n");
  const separator = text.length === 0 || text.endsWith("\n") ? "" : "\n";
  return `${text}${separator}${name}=${value}\n`;
}

function quorumApi(): QuorumApi {
  const service = privy().keyQuorums();
  return {
    get: (id) => service.get(id),
    create: (input) => service.create(input),
  };
}

/**
 * Grants the quorum on the proof wallet, has Privy sign one message with the app's authorization
 * key, checks the signature comes back as that wallet, and takes the grant away again.
 *
 * The proof wallet is a Privy server wallet these scripts own, and a creator's wallet is an
 * embedded wallet that grants the same quorum id from the browser with addSigners. What differs is
 * who authorizes the grant, not what Privy checks when the key asks to sign. Nothing is sent to the
 * chain here: this is one signature and no transaction.
 */
async function proveSignature(keyQuorumId: string, envText: string): Promise<void> {
  const creator = readStore().creator;
  if (creator === undefined) {
    throw new Error(
      "There is no proof creator wallet in packages/agents/.moolam/wallets.json. Run npm run prove:privy first.",
    );
  }
  const policyId = readEnvValue(envText, POLICY_VARIABLE);
  if (policyId === undefined || policyId.length === 0) {
    throw new Error(`${POLICY_VARIABLE} is missing from the root .env, so there is no policy to grant with.`);
  }

  const before = await currentSigners(creator.id);
  console.log(`proof wallet ${creator.address}, signers before: ${before.join(", ") || "none"}`);

  await grantSessionSigner(creator.id, { keyQuorumId, policyId });
  const granted = await walletSigners(privy(), creator.id);
  const entry = granted.find((signer) => signer.signerId === keyQuorumId);
  if (entry === undefined) {
    throw new Error(`Privy does not list ${keyQuorumId} as a signer on the proof wallet after the grant.`);
  }
  if (!entry.policyIds.includes(policyId)) {
    throw new Error(`Privy lists ${keyQuorumId} on the proof wallet without policy ${policyId}.`);
  }
  console.log(`granted ${keyQuorumId} with policy ${policyId}`);

  const message = `moolam edit quorum ${keyQuorumId} at ${new Date().toISOString()}`;
  let signature: string;
  try {
    const signed = await privy()
      .wallets()
      .ethereum()
      .signMessage(creator.id, { message, authorization_context: ownerContext() });
    signature = signed.signature;
  } catch (error) {
    await revokeSessionSigners(creator.id);
    throw new Error(`Privy refused to sign for the edit quorum key: ${privyErrorText(error)}`);
  }

  const recovered = await recoverMessageAddress({ message, signature: signature as Hex });
  const matched = recovered.toLowerCase() === creator.address.toLowerCase();
  console.log(`Privy signed, and the signature recovers to ${recovered}: ${matched ? "PASS" : "FAIL"}`);

  const after = await revokeSessionSigners(creator.id);
  console.log(`grant removed, signers now: ${after.join(", ") || "none"}`);

  if (!matched) {
    throw new Error(`The signature recovered to ${recovered}, not to the proof wallet ${creator.address}.`);
  }
}

async function main(): Promise<void> {
  const publicKey = ownerPublicKey();
  const envText = readFileSync(ENV_FILE, "utf8");
  const cachedId = readEnvValue(envText, SIGNER_VARIABLE);

  const { id, action } = await findOrCreateQuorum(quorumApi(), publicKey, cachedId);
  if (cachedId !== id) {
    writeFileSync(ENV_FILE, upsertEnvLine(envText, SIGNER_VARIABLE, id), "utf8");
  }

  console.log(`${DISPLAY_NAME}: ${action} key quorum ${id}`);
  console.log("its one member is the public half of PRIVY_AUTHORIZATION_KEY, the key /edit signs with");
  console.log(
    cachedId === id
      ? `the root .env already had ${SIGNER_VARIABLE}=${id}`
      : `${SIGNER_VARIABLE} in the root .env is now ${id}`,
  );

  if (process.argv.slice(2).includes("--grant-proof-wallet")) {
    await proveSignature(id, readFileSync(ENV_FILE, "utf8"));
  }
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
