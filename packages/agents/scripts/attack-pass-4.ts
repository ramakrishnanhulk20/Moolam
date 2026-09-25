import { execFileSync } from "node:child_process";
import { createPrivateKey, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  encodeAbiParameters,
  encodePacked,
  getAddress,
  http,
  type Hex,
} from "viem";
import { sealedMetadataSchema } from "@moolam/verifier/src/sealed.js";
import { MONAD_MAINNET, loadDeployment } from "../src/chain/addresses.js";

/**
 * The fourth attack pass, the live half: the private re-check attacked from outside, against the
 * hosted verify service, IPFS and the sealed receiver on Monad mainnet.
 *
 * Nothing here sends a transaction or spends anything. Every chain call is an eth_call or a read,
 * and every HTTP request is made once, with no loop and no retry. Nothing read from .env is printed:
 * the link token, the gateway, the Privy app id and the RPC address are used and never shown, and an
 * RPC error is printed by its short message only, because a full one names the RPC URL.
 *
 * The route half, with the real routes and a recording Pinata, is
 * packages/verifier/test/attacks-private.test.ts.
 */

const VERIFIER = "https://verifier-production-d76f.up.railway.app";

/** The one privately re-checkable passport on mainnet (proofs/sealed-passports.txt). */
const PRIVATE_ID = "0x864c33c6806185d4dc7acd65f465fc4c3cb6b8faaa157c32880cbef9dd93fc09" as Hex;
/** The public Monsoon passport, whose document never asked for a private re-check. */
const MONSOON_ID = "0xcdb25d3755452efa3b746f168cf9cefd3a1b693ab2b81d260a2d64f13d771638" as Hex;
/** The private re-check run of 2026-09-25 (proofs/sealed-passports.txt). */
const REPORT_TX = "0xdc1834ea3d801fd965433dfefe02a70e7f06889655dceb7934d4668f9b790bef" as Hex;

const SEALED_RECEIVER = getAddress("0x7b9eF7cD5e40Af9c29d8b7d0D22E54B80947E45A");

const REQUEST_TIMEOUT_MS = 20_000;

const HERE = dirname(fileURLToPath(import.meta.url));
const SEALED_DEPLOYMENT = join(HERE, "..", "..", "contracts", "deployments", "sealed-receiver-monad-mainnet.json");

const getPassportAbi = [
  {
    type: "function",
    name: "getPassport",
    stateMutability: "view",
    inputs: [{ name: "id", type: "bytes32" }],
    outputs: [
      {
        name: "",
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

/** The registry's attestation door and reads, with every error attest can raise. */
const registryAbi = [
  {
    type: "function",
    name: "attest",
    stateMutability: "nonpayable",
    inputs: [
      { name: "passportId", type: "bytes32" },
      { name: "matched", type: "bool" },
      { name: "distance", type: "uint16" },
      { name: "recomputed", type: "bytes32" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "attestationCount",
    stateMutability: "view",
    inputs: [{ name: "id", type: "bytes32" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "getAttestations",
    stateMutability: "view",
    inputs: [
      { name: "id", type: "bytes32" },
      { name: "offset", type: "uint256" },
      { name: "limit", type: "uint256" },
    ],
    outputs: [
      {
        name: "page",
        type: "tuple[]",
        components: [
          { name: "receiver", type: "address" },
          { name: "matched", type: "bool" },
          { name: "distance", type: "uint16" },
          { name: "recomputed", type: "bytes32" },
          { name: "at", type: "uint64" },
        ],
      },
    ],
  },
  { type: "error", name: "NotReceiver", inputs: [{ name: "caller", type: "address" }] },
  { type: "error", name: "PassportNotFound", inputs: [{ name: "passportId", type: "bytes32" }] },
  { type: "error", name: "AttestationCapReached", inputs: [{ name: "passportId", type: "bytes32" }] },
] as const;

/** Chainlink's ReceiverTemplate as MoolamReceiver inherits it, with every error onReport can raise. */
const receiverAbi = [
  {
    type: "function",
    name: "onReport",
    stateMutability: "nonpayable",
    inputs: [
      { name: "metadata", type: "bytes" },
      { name: "report", type: "bytes" },
    ],
    outputs: [],
  },
  { type: "function", name: "getForwarderAddress", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
  { type: "function", name: "getExpectedAuthor", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
  { type: "function", name: "getExpectedWorkflowName", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "bytes10" }] },
  {
    type: "error",
    name: "InvalidSender",
    inputs: [
      { name: "sender", type: "address" },
      { name: "expected", type: "address" },
    ],
  },
  {
    type: "error",
    name: "InvalidAuthor",
    inputs: [
      { name: "received", type: "address" },
      { name: "expected", type: "address" },
    ],
  },
  {
    type: "error",
    name: "InvalidWorkflowName",
    inputs: [
      { name: "received", type: "bytes10" },
      { name: "expected", type: "bytes10" },
    ],
  },
  {
    type: "error",
    name: "InvalidWorkflowId",
    inputs: [
      { name: "received", type: "bytes32" },
      { name: "expected", type: "bytes32" },
    ],
  },
  { type: "error", name: "WorkflowNameRequiresAuthorValidation", inputs: [] },
  {
    type: "error",
    name: "WrongChain",
    inputs: [
      { name: "reported", type: "uint256" },
      { name: "expected", type: "uint256" },
    ],
  },
  {
    type: "error",
    name: "StaleReport",
    inputs: [
      { name: "passportId", type: "bytes32" },
      { name: "reported", type: "uint64" },
      { name: "lastSeen", type: "uint64" },
    ],
  },
] as const;

interface SealedDeployment {
  receiver: string;
  forwarder: string;
  workflowAuthor: string;
  workflowNameEncoded: string;
}

type Verdict = "REFUSED" | "PASS" | "LANDED AS EXPECTED" | "LANDED, NOT EXPECTED" | "FAILED";

interface Line {
  n: string;
  what: string;
  found: string;
  notCovered: string;
  verdict: Verdict;
}

const lines: Line[] = [];
const say = (text = ""): void => console.log(text);

function commitHash(): string {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is not set. Put it in the repo root .env, next to the other keys.`);
  }
  return value;
}

function base64url(value: Buffer | string): string {
  return Buffer.from(value).toString("base64url");
}

/** An ES256 token with this app's issuer and audience, signed by a key made on the spot. */
function strangersToken(audience: string): string {
  const now = Math.floor(Date.now() / 1000);
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const head = base64url(JSON.stringify({ alg: "ES256", typ: "JWT", kid: "attack-pass-4" }));
  const body = base64url(
    JSON.stringify({ iss: "privy.io", aud: audience, sub: "did:privy:attack-pass-4", iat: now, exp: now + 3600 }),
  );
  const signature = sign("sha256", Buffer.from(`${head}.${body}`), {
    key: createPrivateKey(privateKey.export({ format: "pem", type: "pkcs8" })),
    dsaEncoding: "ieee-p1363",
  });
  return `${head}.${body}.${base64url(signature)}`;
}

interface Answer {
  status: number;
  cache: string;
  body: string;
}

async function call(url: string, init: RequestInit = {}): Promise<Answer> {
  const response = await fetch(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  return {
    status: response.status,
    cache: response.headers.get("cache-control") ?? "(none)",
    body: await response.text(),
  };
}

function short(text: string, limit = 160): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit)}...`;
}

/** A body that may be printed: never one that carries a URL, which on /sealed/link is a live read link. */
function printable(answer: Answer): string {
  return /https?:\/\//i.test(answer.body) ? "(body withheld: it carries a URL)" : short(answer.body);
}

function strings(value: unknown, at = ""): { path: string; text: string }[] {
  if (typeof value === "string") return [{ path: at, text: value }];
  if (Array.isArray(value)) return value.flatMap((item, index) => strings(item, `${at}[${index}]`));
  if (typeof value === "object" && value !== null) {
    return Object.entries(value).flatMap(([key, item]) => strings(item, at.length === 0 ? key : `${at}.${key}`));
  }
  return [];
}

function errorOf(body: string): string | undefined {
  try {
    return (JSON.parse(body) as { error?: string }).error;
  } catch {
    return undefined;
  }
}

/** An error's words without the RPC address: viem's long message names the URL, its short one does not. */
function safeMessage(error: unknown): string {
  if (error instanceof BaseError) return error.shortMessage;
  return error instanceof Error ? error.name : "unknown error";
}

/** Runs an eth_call that should revert and names the custom error it reverted with. */
async function revertOf(run: () => Promise<unknown>): Promise<{ name: string; args: string }> {
  try {
    await run();
    return { name: "(no revert)", args: "" };
  } catch (error) {
    if (error instanceof BaseError) {
      const revert = error.walk((inner) => inner instanceof ContractFunctionRevertedError);
      if (revert instanceof ContractFunctionRevertedError) {
        return {
          name: revert.data?.errorName ?? revert.signature ?? "(undecoded revert)",
          args: (revert.data?.args ?? []).map((arg) => String(arg)).join(", "),
        };
      }
    }
    return { name: "(not a revert)", args: safeMessage(error) };
  }
}

function push(line: Line): void {
  lines.push(line);
}

async function main(): Promise<void> {
  const startedAt = new Date();
  const audience = required("PRIVY_APP_ID");
  const gateway = required("PINATA_GATEWAY_URL").replace(/\/?$/, "/");
  const linkToken = required("SEALED_LINK_TOKEN");
  const { registry } = loadDeployment();
  const sealed = JSON.parse(readFileSync(SEALED_DEPLOYMENT, "utf8")) as SealedDeployment;
  if (getAddress(sealed.receiver) !== SEALED_RECEIVER) {
    throw new Error("the sealed receiver deployment file names another address than this pass attacks");
  }
  const client = createPublicClient({ transport: http(MONAD_MAINNET.rpc) });

  const block = await client.getBlockNumber({ cacheTime: 0 });
  const passport = await client.readContract({
    address: registry,
    abi: getPassportAbi,
    functionName: "getPassport",
    args: [PRIVATE_ID],
    blockNumber: block,
  });

  say("Moolam attack pass 4, the live half: the private re-check, attacked from outside.");
  say("HTTP and eth_call only. No transaction is sent and nothing is spent.");
  say();
  say(`date        ${startedAt.toISOString()}`);
  say(`commit      ${commitHash()}`);
  say(`chain       Monad mainnet, chain 143, read at block ${block.toLocaleString("en-US")}`);
  say(`registry    ${registry}`);
  say(`receiver    ${SEALED_RECEIVER} (the sealed receiver)`);
  say(`passport    ${PRIVATE_ID} (privately re-checkable)`);
  say(`            registered at unix ${passport.registeredAt}, metadata ${passport.metadataURI}`);
  say(`monsoon     ${MONSOON_ID} (public)`);
  say(`verifier    ${VERIFIER}`);
  say();

  // Before the real token is sent, the queue is asked whether a runner holds the passport: with a
  // live claim the service would mint a real link, and this pass exists to show the token alone
  // opens nothing. A claim found here skips 6c rather than minting.
  const queue = await call(`${VERIFIER}/recheck/status/${PRIVATE_ID}`);
  const queueState = (() => {
    try {
      return (JSON.parse(queue.body) as { status?: string }).status ?? "(none)";
    } catch {
      return "(unreadable)";
    }
  })();
  say(`queue       GET /recheck/status/<private id>: ${queue.status}, status ${queueState}, cache-control ${queue.cache}`);
  say();

  const linkBody = JSON.stringify({ passportId: PRIVATE_ID });
  const linkAttempts: [string, string, string | undefined][] = [
    ["6a", "no token", undefined],
    ["6b", "a random 48 character token", randomBytes(24).toString("hex")],
  ];
  for (const [n, label, token] of linkAttempts) {
    const answer = await call(`${VERIFIER}/sealed/link`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token === undefined ? {} : { authorization: `Bearer ${token}` }) },
      body: linkBody,
    });
    const refused = answer.status === 401 && !/https?:\/\//i.test(answer.body);
    say(`${n}  POST /sealed/link for the private passport with ${label}`);
    say(`      ${answer.status}, cache-control ${answer.cache}, ${printable(answer)}`);
    push({
      n,
      what: `POST /sealed/link with ${label}`,
      found: `${answer.status} ${printable(answer)}, cache-control ${answer.cache}`,
      notCovered: "the real token, which 6c sends",
      verdict: refused ? "REFUSED" : "LANDED, NOT EXPECTED",
    });
  }

  if (queueState === "running") {
    say("6c  skipped: the queue says a runner holds the private passport, so the real token would mint a live link");
    push({
      n: "6c",
      what: "POST /sealed/link with the real SEALED_LINK_TOKEN while nothing is claimed",
      found: "skipped, a claim was live at the time of the run",
      notCovered: "the refusal itself, which the route attacks 1c and 1e show",
      verdict: "FAILED",
    });
  } else {
    const answer = await call(`${VERIFIER}/sealed/link`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${linkToken}` },
      body: linkBody,
    });
    const refused = answer.status === 409 && errorOf(answer.body) === "not-claimed" && !/https?:\/\//i.test(answer.body);
    say("6c  POST /sealed/link for the private passport with the real SEALED_LINK_TOKEN, nothing claimed");
    say(`      ${answer.status}, cache-control ${answer.cache}, ${printable(answer)}`);
    push({
      n: "6c",
      what: "POST /sealed/link with the real SEALED_LINK_TOKEN while nothing is claimed",
      found: `${answer.status} ${printable(answer)}, cache-control ${answer.cache}: the real token alone opens nothing`,
      notCovered: "the token together with a live claim, which mints by design and is bounded by 1k and 1l",
      verdict: refused ? "REFUSED" : "LANDED, NOT EXPECTED",
    });
  }

  const forgetAttempts: [string, string, string | undefined][] = [
    ["6d", "no token", undefined],
    ["6e", "an ES256 token signed by a key made on the spot, right issuer and audience", strangersToken(audience)],
  ];
  for (const [n, label, token] of forgetAttempts) {
    const answer = await call(`${VERIFIER}/sealed/forget`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token === undefined ? {} : { authorization: `Bearer ${token}` }) },
      body: linkBody,
    });
    say(`${n}  POST /sealed/forget for the private passport with ${label}`);
    say(`      ${answer.status}, cache-control ${answer.cache}, ${printable(answer)}`);
    push({
      n,
      what: `POST /sealed/forget with ${label}`,
      found: `${answer.status} ${printable(answer)}, cache-control ${answer.cache}`,
      notCovered: "a token Privy itself issued to someone who is not the holder, which the route attack 3a covers",
      verdict: answer.status === 401 ? "REFUSED" : "LANDED, NOT EXPECTED",
    });
  }

  const statuses: [string, string, Hex, string, boolean][] = [
    ["6f", "the private passport", PRIVATE_ID, "kept", true],
    ["6g", "the public Monsoon passport", MONSOON_ID, "gone", false],
  ];
  for (const [n, label, id, state, privateRecheck] of statuses) {
    const answer = await call(`${VERIFIER}/sealed/status/${id}`);
    let parsed: { state?: string; privateRecheck?: boolean; passportId?: string } = {};
    try {
      parsed = JSON.parse(answer.body) as typeof parsed;
    } catch {
      parsed = {};
    }
    const ok =
      answer.status === 200 && parsed.state === state && parsed.privateRecheck === privateRecheck && parsed.passportId === id;
    say(`${n}  GET /sealed/status for ${label}`);
    say(`      ${answer.status}, cache-control ${answer.cache}, ${printable(answer)}`);
    push({
      n,
      what: `GET /sealed/status for ${label}, expecting ${state} and privateRecheck ${String(privateRecheck)}`,
      found: `${answer.status} state ${String(parsed.state)}, privateRecheck ${String(parsed.privateRecheck)}, cache-control ${answer.cache}`,
      notCovered: "the unknown answer, which only a failing Pinata produces and the route attack 2a shows",
      verdict: ok ? "PASS" : "FAILED",
    });
  }

  const metadataCid = passport.metadataURI.replace(/^ipfs:\/\//, "").split("/")[0] ?? "";
  let documentOk = false;
  let documentFound = "";
  try {
    const document = await call(`${gateway}${metadataCid}`, { headers: { accept: "application/json" } });
    const parsed: unknown = JSON.parse(document.body);
    const checked = sealedMetadataSchema.safeParse(parsed);
    const keys = Object.keys(parsed as Record<string, unknown>);
    const found = strings(parsed);
    const links = found.filter(({ text }) => /(https?|ipfs):\/\//i.test(text));
    const commitment = (parsed as { commitment?: { value?: string } }).commitment?.value;
    const flag = (parsed as { privateRecheck?: unknown }).privateRecheck;
    documentOk =
      document.status === 200 && checked.success && links.length === 0 && commitment === PRIVATE_ID && flag === true;
    say("7a  the private passport's document on IPFS, through the gateway named in .env");
    say(
      `      ${document.status}, strict schema ${checked.success ? "accepts it" : `refuses it: ${checked.error.issues.map((issue) => issue.path.join(".")).join(", ")}`}`,
    );
    say(`      keys ${keys.join(", ")}`);
    say(`      privateRecheck ${String(flag)}`);
    say(
      `      string values scanned ${found.length}, http, https or ipfs links ${links.length === 0 ? "none" : links.map((link) => link.path).join(", ")}`,
    );
    say(`      commitment ${commitment === PRIVATE_ID ? "equals the passport id" : `is ${String(commitment)}, not the passport id`}`);
    documentFound = `${document.status}, schema ${checked.success ? "accepts" : "refuses"}, ${keys.length} keys, privateRecheck ${String(flag)}, ${links.length} links, commitment ${commitment === PRIVATE_ID ? "matches" : "differs"}`;
  } catch (error) {
    documentFound = `could not read or parse it: ${safeMessage(error)}`;
    say(`7a  the private passport's document on IPFS: ${documentFound}`);
  }
  push({
    n: "7a",
    what: "the private passport's live document, validated with the verify service's own strict schema",
    found: documentFound,
    notCovered: "copies of the document on other gateways, which are the same bytes by content address",
    verdict: documentOk ? "PASS" : "FAILED",
  });

  // A stranger's address with no code and no history: made fresh for this run.
  const stranger = getAddress(`0x${randomBytes(20).toString("hex")}`);
  const author = getAddress(sealed.workflowAuthor);
  const encodedName = sealed.workflowNameEncoded.toLowerCase() as Hex;
  // The metadata a real report carries (workflow id, name, owner), filled with the pinned name and
  // author, so the only thing wrong about the call is who sent it. The report says "not matched".
  const metadata = encodePacked(["bytes32", "bytes10", "address"], [`0x${"00".repeat(32)}`, encodedName, author]);
  const report = encodeAbiParameters(
    [{ type: "uint256" }, { type: "uint64" }, { type: "bytes32" }, { type: "bool" }, { type: "uint16" }, { type: "bytes32" }],
    [143n, BigInt(Math.floor(Date.now() / 1000)), PRIVATE_ID, false, 64, `0x${"00".repeat(32)}`],
  );
  const onReport = await revertOf(
    async () =>
      await client.simulateContract({
        account: stranger,
        address: SEALED_RECEIVER,
        abi: receiverAbi,
        functionName: "onReport",
        args: [metadata, report],
        blockNumber: block,
      }),
  );
  say("8a  eth_call onReport on the sealed receiver from a stranger, the pinned name and author in the metadata, a false verdict in the report");
  say(`      reverted ${onReport.name}(${onReport.args})`);
  push({
    n: "8a",
    what: "onReport on the sealed receiver from a stranger's address, eth_call",
    found: `reverted ${onReport.name}`,
    notCovered: "the simulation forwarder during an operator run, when the pin is open by design (ruling D10)",
    verdict: onReport.name === "InvalidSender" ? "REFUSED" : "LANDED, NOT EXPECTED",
  });

  const [forwarder, pinnedAuthor, pinnedName] = await Promise.all([
    client.readContract({ address: SEALED_RECEIVER, abi: receiverAbi, functionName: "getForwarderAddress", blockNumber: block }),
    client.readContract({ address: SEALED_RECEIVER, abi: receiverAbi, functionName: "getExpectedAuthor", blockNumber: block }),
    client.readContract({ address: SEALED_RECEIVER, abi: receiverAbi, functionName: "getExpectedWorkflowName", blockNumber: block }),
  ]);
  const pinned =
    getAddress(forwarder) === getAddress(sealed.forwarder) &&
    getAddress(pinnedAuthor) === author &&
    pinnedName.toLowerCase() === encodedName;
  say("8b  the sealed receiver's pin, read back");
  say(`      forwarder ${forwarder} (${getAddress(forwarder) === getAddress(sealed.forwarder) ? "Chainlink's production forwarder" : "NOT the production forwarder"})`);
  say(`      author    ${pinnedAuthor} (${getAddress(pinnedAuthor) === author ? "the workflow author" : "NOT the workflow author"})`);
  say(`      name      ${pinnedName} (${pinnedName.toLowerCase() === encodedName ? "moolam-sealed-verifier, encoded" : "NOT the sealed workflow's name"})`);
  push({
    n: "8b",
    what: "the sealed receiver's forwarder, author and workflow name, read back",
    found: pinned ? "production forwarder, workflow author and moolam-sealed-verifier, all pinned" : "the pin is not what the deployment file names",
    notCovered: "the window during an operator run when the pin is cleared, which the runbook closes and the run report reads back",
    verdict: pinned ? "PASS" : "FAILED",
  });

  const attest = await revertOf(
    async () =>
      await client.simulateContract({
        account: stranger,
        address: registry,
        abi: registryAbi,
        functionName: "attest",
        args: [PRIVATE_ID, false, 64, `0x${"00".repeat(32)}`],
        blockNumber: block,
      }),
  );
  say("8c  eth_call attest on the registry from a stranger, a false verdict for the private passport");
  say(`      reverted ${attest.name}(${attest.args})`);
  push({
    n: "8c",
    what: "attest on the registry from a stranger's address, eth_call",
    found: `reverted ${attest.name}`,
    notCovered: "a receiver the policy lists later, which takes the policy's 24 hour queue and is an owner action",
    verdict: attest.name === "NotReceiver" ? "REFUSED" : "LANDED, NOT EXPECTED",
  });

  const [count, rows, receipt] = await Promise.all([
    client.readContract({ address: registry, abi: registryAbi, functionName: "attestationCount", args: [PRIVATE_ID], blockNumber: block }),
    client.readContract({ address: registry, abi: registryAbi, functionName: "getAttestations", args: [PRIVATE_ID, 0n, 10n], blockNumber: block }),
    client.getTransactionReceipt({ hash: REPORT_TX }),
  ]);
  const reportBlock = await client.getBlock({ blockNumber: receipt.blockNumber });
  const row = rows[0];
  const rowOk =
    count === 1n &&
    rows.length === 1 &&
    row !== undefined &&
    getAddress(row.receiver) === SEALED_RECEIVER &&
    row.matched === true &&
    row.distance === 1 &&
    receipt.status === "success" &&
    row.at === reportBlock.timestamp;
  say("8d  the private passport's attestation list");
  say(`      attestationCount ${count}`);
  for (const one of rows) {
    say(`      receiver ${one.receiver}, matched ${String(one.matched)}, distance ${one.distance}, recomputed ${one.recomputed}, at ${one.at}`);
  }
  say(
    `      report tx ${REPORT_TX}: ${receipt.status}, block ${receipt.blockNumber.toLocaleString("en-US")}, block time ${reportBlock.timestamp} (${row !== undefined && row.at === reportBlock.timestamp ? "equals the row's at" : "differs from the row's at"})`,
  );
  push({
    n: "8d",
    what: "the private passport's attestations, against the report tx of 2026-09-25",
    found: row === undefined ? `${count} rows` : `${count} row, receiver the sealed receiver ${getAddress(row.receiver) === SEALED_RECEIVER ? "yes" : "NO"}, matched ${String(row.matched)}, distance ${row.distance}, written in the report tx's block`,
    notCovered: "which machine ran the workflow, which the chain does not record; the receiver says which workflow name wrote it",
    verdict: rowOk ? "PASS" : "FAILED",
  });

  say();
  say("Summary, one line per live attack: what it found | what it did not cover | verdict");
  say("====================================================================================");
  for (const line of lines) {
    say(`  ${line.n}  ${line.what}: ${line.found} | not covered: ${line.notCovered} | ${line.verdict}`);
  }
  say();
  say(`finished ${new Date().toISOString()}, chain block ${block.toLocaleString("en-US")}`);

  if (lines.some((line) => line.verdict === "FAILED" || line.verdict === "LANDED, NOT EXPECTED")) {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(safeMessage(error));
  process.exit(1);
});
