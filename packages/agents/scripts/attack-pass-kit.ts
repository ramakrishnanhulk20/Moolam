import { execFileSync } from "node:child_process";
import { createHash, createPrivateKey, generateKeyPairSync, randomBytes, sign as signBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import { readFileSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { parse as parseEnv } from "dotenv";
import sharp from "sharp";
import { createPublicClient, getAddress, http, keccak256, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { platformKeyHash } from "@moolam/verifier/src/platform/key.js";
import { MODE, PREPARE_DOMAIN, PREPARE_TYPES } from "@moolam/verifier/src/platform/signatures.js";

/**
 * The live attack pass on the platform kit, the MCP server and Dreamloom (WO-254). Every request
 * goes out once, through one throttle that keeps the whole run under 30 requests a minute, and the
 * run stops at the first attack that does not behave as its invariant says.
 *
 * Spend, by design: one co-sign prepare (a C2PA signing and files frozen on the verify service's
 * volume, no pin, no gas) and one Dreamloom weave (about a cent). No transaction is sent. Every
 * other prepare carries bytes that are not a picture, so a check that failed open would end at the
 * image check instead of reaching the signer.
 *
 * Secrets are read from packages/dreamloom/.env.local and nowhere else, and never printed: every
 * printed line is checked against every secret before it is written, and the platform key, the
 * co-sign handle, the Dreamloom session values and the picture id are shown as placeholders.
 */

const VERIFIER = "https://verifier-production-d76f.up.railway.app";
const DREAMLOOM = "https://dreamloom-production-3e74.up.railway.app";
const WEB = "http://localhost:3210";
const PUBLIC_RPC = "https://rpc.monad.xyz";
const AGENT_IDENTITY_REGISTRY = getAddress("0x8004A169FB4a3325136EB29fA0ceB6D2e539a432");

/** ceil(20 MiB / 3) * 4 base64 characters plus 64 KB of envelope, MCP_BODY_LIMIT in routes/mcp.ts. */
const MCP_BODY_LIMIT = Math.ceil((20 * 1024 * 1024) / 3) * 4 + 64 * 1024;
const URL_UNFETCHABLE = "that address could not be fetched";

/** 2.2 seconds between any two requests: at most 27 a minute, under the 30 this pass was allowed. */
const GAP_MS = 2_200;
const GROUP_PAUSE_MS = 8_000;
const TIMEOUT_MS = 30_000;

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..");
const DREAMLOOM_ENV = join(REPO, "packages", "dreamloom", ".env.local");
const PLATFORM_LIST = join(REPO, "packages", "verifier", "src", "platforms", "platforms.json");

/** The .env.local names that hold secrets. The others there are public settings. */
const SECRET_NAMES = [
  "DREAMLOOM_WALLET_KEY",
  "DREAMLOOM_PASSKEY_KEY",
  "DREAMLOOM_PLATFORM_KEY",
  "OPENAI_API_KEY",
  "MONAD_RPC_URL",
] as const;

type Verdict = "REFUSED" | "PASSED" | "NOT AS EXPECTED";

interface Line {
  n: string;
  invariant: string;
  what: string;
  found: string;
  verdict: Verdict;
}

interface Answer {
  status: number;
  headers: Record<string, string>;
  body: string;
}

const lines: Line[] = [];
const answers: { tag: string; answer: Answer }[] = [];
const sentAt: number[] = [];
const redactions = new Map<string, string>();
let secretForms: { name: string; form: string }[] = [];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let lastSend = 0;
async function turn(): Promise<void> {
  const wait = lastSend + GAP_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastSend = Date.now();
  sentAt.push(lastSend);
}

function redact(text: string): string {
  let out = text;
  for (const [value, label] of redactions) {
    out = out.split(value).join(label);
    out = out.split(value.toLowerCase()).join(label);
  }
  return out;
}

/** Prints a line only after redaction, and stops the run rather than print a secret. */
function say(text = ""): void {
  const clean = redact(text);
  const lower = clean.toLowerCase();
  for (const { name, form } of secretForms) {
    if (lower.includes(form)) {
      throw new Error(`a printed line would carry ${name}; the run stops here`);
    }
  }
  console.log(clean);
}

function short(text: string, limit = 180): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit)}...`;
}

function headersOf(response: Response): Record<string, string> {
  const out: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    out[name] = value;
  });
  return out;
}

async function call(tag: string, url: string, init: RequestInit = {}, timeoutMs = TIMEOUT_MS): Promise<Answer> {
  await turn();
  const response = await fetch(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
  const bytes = Buffer.from(await response.arrayBuffer());
  const answer = { status: response.status, headers: headersOf(response), body: bytes.toString("latin1") };
  answers.push({ tag, answer });
  return answer;
}

function jsonOf(body: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(body);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** The answer's error word: the JSON error field, a JSON-RPC error's message, or "(none)". */
function wordOf(answer: Answer): string {
  const parsed = jsonOf(answer.body);
  if (parsed === undefined) return "(not JSON)";
  const error = parsed.error;
  if (typeof error === "string") return short(error, 90);
  if (typeof error === "object" && error !== null) {
    const { code, message } = error as { code?: unknown; message?: unknown };
    return `${String(code)} ${short(String(message), 90)}`;
  }
  return "(none)";
}

function onlyKeys(answer: Answer, keys: string[]): boolean {
  const parsed = jsonOf(answer.body);
  if (parsed === undefined) return false;
  const found = Object.keys(parsed).sort();
  return found.length === keys.length && found.every((key, index) => key === [...keys].sort()[index]);
}

function stop(): never {
  say();
  say("The run stopped at the attack above: it did not behave as its invariant says.");
  printSummary();
  process.exit(1);
}

function push(line: Line): void {
  lines.push(line);
  say(`      ${line.verdict}`);
  if (line.verdict === "NOT AS EXPECTED") stop();
}

/** One attack: prints what was sent and what came back, then judges it. */
function judge(n: string, invariant: string, what: string, sent: string, answer: Answer, ok: boolean, extra = ""): void {
  const cache = answer.headers["cache-control"] ?? "(none)";
  say(`${n}  ${invariant}  ${what}`);
  say(`      sent: ${sent}`);
  say(`      answer: ${answer.status}, error ${wordOf(answer)}, cache-control ${cache}${extra === "" ? "" : `, ${extra}`}`);
  push({ n, invariant, what, found: `${answer.status} ${wordOf(answer)}`, verdict: ok ? "REFUSED" : "NOT AS EXPECTED" });
}

function commitHash(): string {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

function base64url(value: Buffer | string): string {
  return Buffer.from(value).toString("base64url");
}

/** An ES256 token shaped like a Privy access token, signed by a key made on the spot. */
function forgedPrivyToken(): string {
  const now = Math.floor(Date.now() / 1000);
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const head = base64url(JSON.stringify({ alg: "ES256", typ: "JWT", kid: "attack-pass-kit" }));
  const body = base64url(JSON.stringify({ iss: "privy.io", aud: "attack-pass-kit", sub: "did:privy:attack-pass-kit", iat: now, exp: now + 3600 }));
  const signature = signBytes("sha256", Buffer.from(`${head}.${body}`), {
    key: createPrivateKey(privateKey.export({ format: "pem", type: "pkcs8" })),
    dsaEncoding: "ieee-p1363",
  });
  return `${head}.${body}.${base64url(signature)}`;
}

/** A 640 by 480 JPEG nobody has registered: shapes placed from fresh random bytes. */
async function freshPicture(): Promise<Buffer> {
  const r = randomBytes(12);
  const at = (i: number, span: number): number => (r[i] ?? 0) % span;
  const hue = at(0, 360);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480">
    <rect width="640" height="480" fill="hsl(${hue},50%,24%)"/>
    <circle cx="${80 + at(1, 420)}" cy="${70 + at(2, 300)}" r="${40 + at(3, 90)}" fill="hsl(${(hue + 140) % 360},80%,66%)"/>
    <rect x="${30 + at(4, 300)}" y="${300 + at(5, 120)}" width="${140 + at(6, 250)}" height="${40 + at(7, 70)}" fill="hsl(${(hue + 40) % 360},70%,45%)"/>
    <polygon points="${420 + at(8, 90)},${40 + at(9, 60)} ${600 - at(10, 70)},${210 + at(11, 50)} ${400 + at(1, 60)},${260 + at(2, 40)}" fill="hsl(${(hue + 250) % 360},60%,80%)"/>
    <rect x="0" y="${430 - at(3, 40)}" width="640" height="24" fill="#101018"/>
  </svg>`;
  return await sharp(Buffer.from(svg)).jpeg({ quality: 92 }).toBuffer();
}

function sha256Hex(bytes: Buffer): Hex {
  return `0x${createHash("sha256").update(bytes).digest("hex")}` as Hex;
}

function nonce(): Hex {
  return `0x${randomBytes(32).toString("hex")}` as Hex;
}

interface PrepareParts {
  mode: "platform" | "cosign";
  bytes: Buffer;
  fileName: string;
  title: string;
  nonce: Hex;
  issuedAt: bigint;
  signature?: string;
  training?: string;
  creator?: string;
  wallet?: string;
}

function prepareForm(parts: PrepareParts): FormData {
  const form = new FormData();
  form.append("mode", parts.mode);
  form.append("title", parts.title);
  form.append("nonce", parts.nonce);
  form.append("issuedAt", parts.issuedAt.toString());
  if (parts.signature !== undefined) form.append("signature", parts.signature);
  if (parts.training !== undefined) form.append("training", parts.training);
  if (parts.creator !== undefined) form.append("creator", parts.creator);
  if (parts.wallet !== undefined) form.append("wallet", parts.wallet);
  form.append("file", new Blob([new Uint8Array(parts.bytes)], { type: "image/jpeg" }), parts.fileName);
  return form;
}

async function signPrepare(
  signer: PrivateKeyAccount,
  platformId: Hex,
  mode: "platform" | "cosign",
  bytes: Buffer,
  once: Hex,
  issuedAt: bigint,
): Promise<Hex> {
  return await signer.signTypedData({
    domain: PREPARE_DOMAIN,
    types: PREPARE_TYPES,
    primaryType: "PlatformPrepare",
    message: { mode: MODE[mode], pictureHash: sha256Hex(bytes), platformId, nonce: once, issuedAt },
  });
}

const ownerOfAbi = [
  {
    type: "function",
    name: "ownerOf",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "", type: "address" }],
  },
] as const;

function printSummary(): void {
  say();
  say("Summary, one line per attack: invariant | what | answer | verdict");
  say("================================================================");
  for (const line of lines) {
    say(`  ${line.n.padEnd(4)} ${line.invariant.padEnd(4)} ${line.what}: ${line.found} | ${line.verdict}`);
  }
  let busiest = 0;
  for (let i = 0; i < sentAt.length; i += 1) {
    const start = sentAt[i] as number;
    const inWindow = sentAt.filter((at) => at >= start && at < start + 60_000).length;
    busiest = Math.max(busiest, inWindow);
  }
  const refused = lines.filter((line) => line.verdict === "REFUSED").length;
  const passed = lines.filter((line) => line.verdict === "PASSED").length;
  const off = lines.filter((line) => line.verdict === "NOT AS EXPECTED").length;
  say();
  say(`attacks ${lines.length}: ${refused} REFUSED, ${passed} PASSED (positive controls), ${off} NOT AS EXPECTED`);
  say(`requests ${sentAt.length} in all, the most in any 60 seconds ${busiest}`);
  say(`finished ${new Date().toISOString()}`);
}

async function main(): Promise<void> {
  const startedAt = new Date();
  const env = parseEnv(readFileSync(DREAMLOOM_ENV, "utf8"));
  for (const name of SECRET_NAMES) {
    if ((env[name] ?? "").trim().length === 0) throw new Error(`${name} is missing from packages/dreamloom/.env.local`);
  }
  const forms: { name: string; form: string }[] = [];
  for (const name of SECRET_NAMES) {
    const value = (env[name] as string).trim();
    const lower = value.toLowerCase();
    forms.push({ name, form: lower });
    if (lower.startsWith("0x")) forms.push({ name, form: lower.slice(2) });
    if (name === "MONAD_RPC_URL") {
      try {
        const url = new URL(value);
        for (const piece of [...url.pathname.split("/"), ...url.search.slice(1).split("&")]) {
          if (piece.length >= 12) forms.push({ name, form: piece.toLowerCase() });
        }
      } catch {
        // A value that is not a URL is scanned whole, above.
      }
    }
  }
  secretForms = forms;

  const platformKey = (env.DREAMLOOM_PLATFORM_KEY as string).trim();
  const owner = privateKeyToAccount((env.DREAMLOOM_WALLET_KEY as string).trim() as Hex);
  const stranger = privateKeyToAccount(generatePrivateKey());
  redactions.set(platformKey, "<platform key>");

  const list = JSON.parse(readFileSync(PLATFORM_LIST, "utf8")) as { name: string; agentId: string; keyHash: string; creatorWallet: string }[];
  const entry = list.find((one) => one.name === "Dreamloom");
  if (entry === undefined) throw new Error("the bundled platform list has no Dreamloom entry");
  const platformId = entry.keyHash.toLowerCase() as Hex;
  if (`0x${platformKeyHash(platformKey).toString("hex")}` !== platformId) {
    throw new Error("the platform key in .env.local does not hash to Dreamloom's listed keyHash");
  }
  if (owner.address !== getAddress(entry.creatorWallet)) {
    throw new Error("the wallet key in .env.local is not Dreamloom's listed creator wallet");
  }
  const agentId = BigInt(entry.agentId);

  const chain = createPublicClient({ transport: http(PUBLIC_RPC) });
  await turn();
  const chainOwner = await chain.readContract({ address: AGENT_IDENTITY_REGISTRY, abi: ownerOfAbi, functionName: "ownerOf", args: [agentId] });
  if (getAddress(chainOwner) !== owner.address) {
    throw new Error(`ownerOf(${agentId}) on chain is not Dreamloom's wallet, so no valid PlatformPrepare can be made`);
  }
  await turn();
  const block = await chain.getBlock({ blockTag: "latest" });
  const chainAt = { time: block.timestamp, wall: Date.now() };
  const chainNow = (): bigint => chainAt.time + BigInt(Math.floor((Date.now() - chainAt.wall) / 1000));

  say("MOOLAM ATTACK PASS: THE PLATFORM KIT, THE MCP SERVER AND DREAMLOOM (WO-254)");
  say("============================================================================");
  say();
  say("What this is: every invariant the platform kit (P) and the MCP server (M) promise, and");
  say("Dreamloom's D1 to D7, attacked from outside against the deployed services. Invariants are in");
  say("docs/security/threat-model.md (P1 to P25,");
  say("M1 to M6) and Dreamloom's design notes (D1 to D7). Each attack prints what was sent, with keys, handles and");
  say("session values shown as placeholders, and the answer's status and error word.");
  say();
  say(`date          ${startedAt.toISOString()}`);
  say(`commit        ${commitHash()} (the script is not committed yet)`);
  say(`chain         Monad mainnet, chain 143, block ${block.number.toLocaleString("en-US")} at unix ${block.timestamp}`);
  say(`verifier      ${VERIFIER}`);
  say(`dreamloom     ${DREAMLOOM}`);
  say(`web           ${WEB}, the Moolam dev server on this machine: the web app is not pushed yet, so`);
  say("              the co-sign and connect page headers are read from the dev server, not moolam.site");
  say(`platform      Dreamloom, agent ${agentId}, creator wallet ${owner.address} (ownerOf read on chain: the same)`);
  say();
  say("Spend: one co-sign prepare (3a: a C2PA signing and files frozen on the verify service's volume,");
  say("nothing pinned, no gas) and one Dreamloom weave (5a, about a cent). No transaction is sent.");
  say("Every other prepare carries 2 KB of random bytes that are not a picture, so a check that failed");
  say("open would stop at the image check (415) instead of reaching the signer, and would show here.");
  say("Requests go out one at a time, 2.2 seconds apart, with a pause between groups.");
  say();

  say("STEP 2. THE PLATFORM ROUTES");
  say("---------------------------");
  const prepareUrl = `${VERIFIER}/platform/prepare`;
  const junk = (): Buffer => randomBytes(2048);
  const bearer = { authorization: `Bearer ${platformKey}` };

  {
    const bytes = junk();
    const parts: PrepareParts = { mode: "cosign", bytes, fileName: "x.jpg", title: "attack", nonce: nonce(), issuedAt: chainNow() };
    parts.signature = await signPrepare(owner, platformId, "cosign", bytes, parts.nonce, parts.issuedAt);
    const answer = await call("verifier", prepareUrl, { method: "POST", body: prepareForm(parts) });
    judge("2a", "P7", "POST /platform/prepare with no Authorization header", "a co-sign prepare signed by the agent owner, no key", answer,
      answer.status === 401 && wordOf(answer) === "unauthorized" && onlyKeys(answer, ["error"]));
  }
  {
    const bytes = junk();
    const parts: PrepareParts = { mode: "cosign", bytes, fileName: "x.jpg", title: "attack", nonce: nonce(), issuedAt: chainNow() };
    parts.signature = await signPrepare(owner, platformId, "cosign", bytes, parts.nonce, parts.issuedAt);
    const answer = await call("verifier", prepareUrl, {
      method: "POST",
      headers: { authorization: `Bearer ${randomBytes(32).toString("hex")}` },
      body: prepareForm(parts),
    });
    judge("2b", "P7", "POST /platform/prepare with a wrong key", "Bearer and 64 random hex characters, a key never issued", answer,
      answer.status === 401 && wordOf(answer) === "unauthorized" && onlyKeys(answer, ["error"]));
  }
  {
    const bytes = junk();
    const parts: PrepareParts = { mode: "cosign", bytes, fileName: "x.jpg", title: "attack", nonce: nonce(), issuedAt: chainNow() };
    parts.signature = await signPrepare(owner, platformId, "cosign", bytes, parts.nonce, parts.issuedAt);
    const query = `?key=${platformKey}&authorization=${encodeURIComponent(`Bearer ${platformKey}`)}`;
    const answer = await call("verifier", `${prepareUrl}${query}`, { method: "POST", body: prepareForm(parts) });
    judge("2c", "P7", "POST /platform/prepare with the real key in the query string only",
      "?key=<platform key>&authorization=Bearer <platform key>, no header", answer,
      answer.status === 401 && wordOf(answer) === "unauthorized" && onlyKeys(answer, ["error"]));
  }
  {
    const bytes = junk();
    const parts: PrepareParts = { mode: "cosign", bytes, fileName: "x.jpg", title: "attack", nonce: nonce(), issuedAt: chainNow() };
    parts.signature = await signPrepare(stranger, platformId, "cosign", bytes, parts.nonce, parts.issuedAt);
    const answer = await call("verifier", prepareUrl, { method: "POST", headers: bearer, body: prepareForm(parts) });
    judge("2d", "P19", `POST /platform/prepare, PlatformPrepare signed by ${stranger.address}, not the owner of agent ${agentId}`,
      "the real key, a fresh nonce, issuedAt from chain time, a stranger's EIP-712 signature", answer,
      answer.status === 403 && wordOf(answer) === "agent-signature-refused");
  }
  {
    const bytes = junk();
    const first: PrepareParts = { mode: "cosign", bytes, fileName: "x.jpg", title: "attack", nonce: nonce(), issuedAt: chainNow() };
    first.signature = await signPrepare(owner, platformId, "cosign", bytes, first.nonce, first.issuedAt);
    const control = await call("verifier", prepareUrl, { method: "POST", headers: bearer, body: prepareForm(first) });
    say("2e  P19  control: a valid PlatformPrepare from the agent owner over 2 KB that is not a picture");
    say("      sent: the real key, a fresh nonce, issuedAt from chain time, the owner's signature");
    say(`      answer: ${control.status}, error ${wordOf(control)}: the signature and nonce were accepted, the bytes were not a picture, nothing was signed or pinned`);
    push({ n: "2e", invariant: "P19", what: "control: a valid prepare over bytes that are not a picture", found: `${control.status} ${wordOf(control)}`,
      verdict: control.status === 415 && wordOf(control) === "not-an-image" ? "PASSED" : "NOT AS EXPECTED" });

    const replay = await call("verifier", prepareUrl, { method: "POST", headers: bearer, body: prepareForm(first) });
    judge("2f", "P19", "POST /platform/prepare, the same request again: same nonce, same bytes, same signature",
      "an exact replay of 2e inside the ten minute window", replay, replay.status === 409 && wordOf(replay) === "replayed");

    const again: PrepareParts = { ...first, nonce: nonce(), issuedAt: chainNow() };
    again.signature = await signPrepare(owner, platformId, "cosign", bytes, again.nonce, again.issuedAt);
    const same = await call("verifier", prepareUrl, { method: "POST", headers: bearer, body: prepareForm(again) });
    judge("2g", "P19", "POST /platform/prepare, the same picture with a fresh nonce and a fresh owner signature",
      "2e's bytes again, a new nonce, a new valid signature, inside the window", same, same.status === 409 && wordOf(same) === "same-picture");
  }
  for (const [n, label, offset] of [
    ["2h", "eleven minutes before chain time", -660n],
    ["2i", "an hour ahead of chain time", 3600n],
  ] as const) {
    const bytes = junk();
    const parts: PrepareParts = { mode: "cosign", bytes, fileName: "x.jpg", title: "attack", nonce: nonce(), issuedAt: chainNow() + offset };
    parts.signature = await signPrepare(owner, platformId, "cosign", bytes, parts.nonce, parts.issuedAt);
    const answer = await call("verifier", prepareUrl, { method: "POST", headers: bearer, body: prepareForm(parts) });
    judge(n, "P12", `POST /platform/prepare with issuedAt ${label}`, "the real key, the owner's valid signature over that issuedAt", answer,
      answer.status === 403 && wordOf(answer) === "prepare-expired");
  }
  const someone = getAddress(`0x${randomBytes(20).toString("hex")}`);
  for (const [n, mode, field, value, label] of [
    ["2j", "platform", "creator", someone, "a platform-mode body naming another creator"],
    ["2k", "platform", "wallet", someone, "a platform-mode body naming another wallet"],
    ["2l", "cosign", "creator", owner.address, "a co-sign body naming a creator (Dreamloom's own wallet)"],
  ] as const) {
    const bytes = junk();
    const parts: PrepareParts = { mode, bytes, fileName: "x.jpg", title: "attack", nonce: nonce(), issuedAt: chainNow() };
    parts.signature = await signPrepare(owner, platformId, mode, bytes, parts.nonce, parts.issuedAt);
    parts[field] = value;
    const answer = await call("verifier", prepareUrl, { method: "POST", headers: bearer, body: prepareForm(parts) });
    judge(n, "P18", `POST /platform/prepare, ${label}`, `the real key, the owner's valid signature, ${field}=${value}`, answer,
      answer.status === 403 && wordOf(answer) === "platform-mismatch" && jsonOf(answer.body)?.field === field);
  }
  for (const [n, label, condition] of [
    ["2m", "a 257-byte condition", "A".repeat(257)],
    ["2n", "a non-ASCII condition", "Ask Dreamloom first, merci été"],
  ] as const) {
    const bytes = junk();
    const parts: PrepareParts = { mode: "platform", bytes, fileName: "x.jpg", title: "attack", nonce: nonce(), issuedAt: chainNow() };
    parts.signature = await signPrepare(owner, platformId, "platform", bytes, parts.nonce, parts.issuedAt);
    parts.training = JSON.stringify({ aiTraining: "constrained", constraintInfo: condition });
    const answer = await call("verifier", prepareUrl, { method: "POST", headers: bearer, body: prepareForm(parts) });
    judge(n, "P9", `POST /platform/prepare with ${label}`, `the real key, the owner's valid signature, training {aiTraining: constrained, constraintInfo: ${label}}`,
      answer, answer.status === 400 && /constraintInfo/.test(wordOf(answer)));
  }

  await sleep(GROUP_PAUSE_MS);
  say();
  say("Handles: a random text, a malformed handle (31 hex characters) and a well-formed unknown one");
  say("(32 fresh hex characters), on the three handle routes, with no credential and with a Privy-shaped");
  say("ES256 token signed by a key made on the spot (no real Privy token is held by this script).");
  const forged = forgedPrivyToken();
  redactions.set(forged, "<forged token>");
  const handles = [
    ["random", "not-a-handle-at-all"],
    ["malformed", randomBytes(16).toString("hex").slice(0, 31)],
    ["well-formed unknown", randomBytes(16).toString("hex")],
  ] as const;
  const unknownAnswers: Record<string, string> = {};
  const labels = ["o", "p", "q", "r", "s", "t", "u", "v", "w", "x", "y", "z", "aa", "ab", "ac", "ad", "ae", "af"];
  let label = 0;
  for (const [kind, handle] of handles) {
    for (const [cred, headers] of [
      ["no credential", {}],
      ["a forged Privy token", { authorization: `Bearer ${forged}` }],
    ] as const) {
      for (const [route, method] of [
        ["record", "GET"],
        ["sign", "POST"],
        ["status", "GET"],
      ] as const) {
        const init: RequestInit =
          method === "POST"
            ? { method, headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ signature: `0x${"11".repeat(65)}` }) }
            : { method, headers };
        const answer = await call("verifier", `${VERIFIER}/platform/${route}/${encodeURIComponent(handle)}`, init);
        // sign checks the platform key first, so without one every handle shape is 401; record and
        // status check the shape first (404) and then the Privy token (401).
        const wellFormed = kind === "well-formed unknown";
        const expected = route === "sign" || wellFormed ? [401, "unauthorized"] : [404, "not-found"];
        if (wellFormed && cred === "no credential") unknownAnswers[route] = `${answer.status} ${answer.body}`;
        const n = `2${labels[label] ?? "?"}`;
        label += 1;
        judge(n, "P4", `${method} /platform/${route}/<${kind} handle> with ${cred}`,
          `${kind} handle${method === "POST" ? ", body {signature: 0x11...11}" : ""}`, answer,
          answer.status === expected[0] && wordOf(answer) === expected[1] && onlyKeys(answer, ["error"]));
      }
    }
  }
  {
    const handle = handles[2][1];
    const signAnswer = await call("verifier", `${VERIFIER}/platform/sign/${handle}`, {
      method: "POST",
      headers: { ...bearer, "content-type": "application/json" },
      body: JSON.stringify({ signature: await owner.sign({ hash: keccak256(randomBytes(32)) }) }),
    });
    judge("2ag", "P4", "POST /platform/sign/<well-formed unknown handle> with Dreamloom's real key",
      "the real key, a well-formed signature from the agent owner over a random hash", signAnswer,
      signAnswer.status === 404 && wordOf(signAnswer) === "not-found" && onlyKeys(signAnswer, ["error"]));
    const statusAnswer = await call("verifier", `${VERIFIER}/platform/status/${handle}`, { headers: bearer });
    judge("2ah", "P4", "GET /platform/status/<well-formed unknown handle> with Dreamloom's real key", "the real key", statusAnswer,
      statusAnswer.status === 404 && wordOf(statusAnswer) === "not-found" && onlyKeys(statusAnswer, ["error"]));
  }

  await sleep(GROUP_PAUSE_MS);
  say();
  say("STEP 3. THE POSITIVE CONTROL: ONE REAL CO-SIGN PREPARE, THEN A WRONG SIGNER");
  say("--------------------------------------------------------------------------");
  let realHandle: string;
  {
    const picture = await freshPicture();
    const at = await (async () => {
      await turn();
      return (await chain.getBlock({ blockTag: "latest" })).timestamp;
    })();
    const parts: PrepareParts = { mode: "cosign", bytes: picture, fileName: "attack-pass-kit.jpg", title: "WO-254 attack pass test picture", nonce: nonce(), issuedAt: at };
    parts.signature = await signPrepare(owner, platformId, "cosign", picture, parts.nonce, parts.issuedAt);
    const answer = await call("verifier", prepareUrl, { method: "POST", headers: bearer, body: prepareForm(parts) });
    const parsed = jsonOf(answer.body) ?? {};
    const handle = typeof parsed.handle === "string" ? parsed.handle : "";
    if (handle !== "") redactions.set(handle, "<handle>");
    realHandle = handle;
    const passport = (parsed.passport ?? {}) as { exactHash?: string };
    const ok =
      answer.status === 200 && parsed.mode === "cosign" && /^[0-9a-f]{32}$/.test(handle) && /^0x[0-9a-f]{64}$/.test(String(passport.exactHash));
    say(`3a  P19  control: POST /platform/prepare, co-sign mode, a fresh ${picture.length} byte 640x480 JPEG, signed by the agent owner`);
    say("      sent: the real key, a fresh nonce, issuedAt from the latest block, the owner's EIP-712 signature, no terms");
    say(`      answer: ${answer.status}, mode ${String(parsed.mode)}, handle <handle> (${handle.length} hex characters), passport ${String(passport.exactHash)}, openBy ${String(parsed.openBy)}, cache-control ${answer.headers["cache-control"] ?? "(none)"}`);
    push({ n: "3a", invariant: "P19", what: "control: a real co-sign prepare with the owner's signature", found: `${answer.status} mode ${String(parsed.mode)}, a 128-bit handle`,
      verdict: ok ? "PASSED" : "NOT AS EXPECTED" });
  }
  {
    const wrongSigner = privateKeyToAccount(generatePrivateKey());
    const signature = await wrongSigner.sign({ hash: keccak256(randomBytes(32)) });
    const signAnswer = await call("verifier", `${VERIFIER}/platform/sign/${realHandle}`, {
      method: "POST",
      headers: { ...bearer, "content-type": "application/json" },
      body: JSON.stringify({ signature }),
    });
    const statusAnswer = await call("verifier", `${VERIFIER}/platform/status/${realHandle}`, { headers: bearer });
    const status = jsonOf(statusAnswer.body) ?? {};
    const notStored = statusAnswer.status === 200 && status.state === "awaiting-creator" && !("agentSignature" in status);
    const refused = signAnswer.status === 403 || signAnswer.status === 409;
    say(`3b  P5   POST /platform/sign/<handle> with a signature from ${wrongSigner.address}, not the owner of agent ${agentId}`);
    say("      sent: the real key, {signature: a 65 byte signature from a key made on the spot}");
    say(`      answer: ${signAnswer.status}, error ${wordOf(signAnswer)}, cache-control ${signAnswer.headers["cache-control"] ?? "(none)"}`);
    say(`      then GET /platform/status/<handle> with the key: ${statusAnswer.status}, state ${String(status.state)}, agentSignature ${"agentSignature" in status ? "PRESENT" : "absent"}`);
    say("      not covered: the signature recovery itself (403 agent-signature-refused) runs only once a person's");
    say("      verified Privy session has set the creator; this record has none, so the refusal came at the state check");
    push({ n: "3b", invariant: "P5", what: "sign with a wrong signer's signature, then status", found: `${signAnswer.status} ${wordOf(signAnswer)}; status ${String(status.state)}, no signature stored`,
      verdict: refused && notStored ? "REFUSED" : "NOT AS EXPECTED" });
  }
  for (const [n, route] of [
    ["3c", "record"],
    ["3d", "status"],
  ] as const) {
    const answer = await call("verifier", `${VERIFIER}/platform/${route}/${realHandle}`);
    const same = `${answer.status} ${answer.body}` === unknownAnswers[route];
    judge(n, "P4", `GET /platform/${route}/<the real handle> with no credential, against the unknown handle's answer in step 2`,
      "the live handle from 3a, no key, no token", answer, answer.status === 401 && same, same ? "byte for byte the unknown handle's answer" : "DIFFERS from the unknown handle's answer");
  }
  say("      the handle is left to expire: its record opens for 30 minutes of chain time, then it and its frozen files are dropped");

  await sleep(GROUP_PAUSE_MS);
  say();
  say("STEP 4. THE MCP SERVER");
  say("----------------------");
  const mcpUrl = `${VERIFIER}/mcp`;
  let mcpSent = 0;
  const mcpFetch = async (url: string | URL, init?: RequestInit): Promise<Response> => {
    await turn();
    mcpSent += 1;
    const signal = init?.signal == null ? AbortSignal.timeout(60_000) : AbortSignal.any([init.signal, AbortSignal.timeout(60_000)]);
    const response = await fetch(url, { ...init, signal });
    const text = await response.clone().text();
    answers.push({ tag: "mcp", answer: { status: response.status, headers: headersOf(response), body: text } });
    return response;
  };
  const client = new Client({ name: "attack-pass-kit", version: "1.0.0" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
  await client.connect(new StreamableHTTPClientTransport(new URL(mcpUrl), { fetch: mcpFetch }));

  type ToolAnswer = { kind: "result"; isError: boolean; text: string; structured: unknown } | { kind: "error"; text: string };
  const tool = async (name: string, args: Record<string, unknown>): Promise<{ answer: ToolAnswer; requests: number }> => {
    const before = mcpSent;
    try {
      const result = await client.callTool({ name, arguments: args });
      const content = (result.content as { type: string; text?: string }[] | undefined) ?? [];
      return {
        answer: { kind: "result", isError: result.isError === true, text: content.map((one) => one.text ?? "").join(" "), structured: result.structuredContent },
        requests: mcpSent - before,
      };
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      return { answer: { kind: "error", text: `JSON-RPC error ${String(code)}: ${error instanceof Error ? error.message : String(error)}` }, requests: mcpSent - before };
    }
  };
  const toolLine = (n: string, invariant: string, what: string, sent: string, got: { answer: ToolAnswer; requests: number }, ok: boolean): void => {
    const word = got.answer.kind === "result" ? `${got.answer.isError ? "isError" : "result"}: ${short(got.answer.text, 110)}` : short(got.answer.text, 140);
    say(`${n}  ${invariant}  ${what}`);
    say(`      sent: ${sent} (${got.requests} HTTP request${got.requests === 1 ? "" : "s"})`);
    say(`      answer: ${word}`);
    push({ n, invariant, what, found: short(word, 90), verdict: ok && got.requests > 0 ? "REFUSED" : "NOT AS EXPECTED" });
  };

  let inward = "";
  for (const name of ["127.0.0.1.nip.io", "localtest.me"]) {
    try {
      const { address } = await lookup(name);
      if (isIP(address) !== 0 && /^(127\.|10\.|169\.254\.|192\.168\.)/.test(address)) {
        inward = name;
        say(`      a public name that points inward: ${name} resolves to ${address} from this machine`);
        break;
      }
    } catch {
      // Tried the next name.
    }
  }
  if (inward === "") throw new Error("neither nip.io nor localtest.me resolved to a private address from this machine");
  const privateTargets = [
    ["4a", "https://127.0.0.1/picture.jpg"],
    ["4b", "https://169.254.169.254/latest/meta-data/"],
    ["4c", "https://[::1]/picture.jpg"],
    ["4d", "https://10.0.0.1/picture.jpg"],
    ["4e", `https://${inward}/picture.jpg`],
  ] as const;
  for (const [n, target] of privateTargets) {
    const got = await tool("check_picture", { url: target });
    toolLine(n, "M1", `check_picture on ${target}`, `tools/call check_picture {url: ${target}}`, got,
      got.answer.kind === "result" && got.answer.isError && got.answer.text === URL_UNFETCHABLE);
  }
  const malformed: [string, string, Record<string, unknown>][] = [
    ["4f", "get_passport", { passportId: "0x1234" }],
    ["4g", "get_passport", { passportId: `0x${"zz".repeat(32)}` }],
    ["4h", "get_agent", { agentId: -1 }],
    ["4i", "get_agent", { agentId: 1.5 }],
    ["4j", "get_agent", { agentId: 2 ** 60 }],
    ["4k", "list_recent_passports", { limit: 0 }],
    ["4l", "list_recent_passports", { limit: 25 }],
    ["4m", "get_ai_use_terms", { passportId: `0x${"ab".repeat(32)}`, at: -5 }],
    ["4n", "check_picture", { url: "http://example.com/picture.jpg" }],
  ];
  for (const [n, name, args] of malformed) {
    const got = await tool(name, args);
    const refused = got.answer.kind === "error" || (got.answer.isError && got.answer.structured === undefined);
    toolLine(n, "M2", `${name} with ${JSON.stringify(args)}`, `tools/call ${name} ${JSON.stringify(args)}`, got, refused);
  }
  say("      not covered from outside: that no chain or index read was made before the refusals; mcp-tools.test.ts counts that");
  say("      4e is limited too: the service answers the same sentence whether its guard refused the resolved");
  say("      address or the name did not resolve on its host, so this line cannot tell which of the two happened");

  const initialize = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "attack-pass-kit", version: "1" } },
  });
  const rpcHeaders = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  for (const [n, origin] of [
    ["4o", "https://evil.example"],
    ["4p", "https://moolam.site.evil.example"],
    ["4q", "null"],
  ] as const) {
    const answer = await call("mcp", mcpUrl, { method: "POST", headers: { ...rpcHeaders, origin }, body: initialize });
    judge(n, "M5", `POST /mcp initialize with Origin ${origin}`, `a 2025-06-18 initialize, Origin: ${origin}`, answer,
      answer.status === 403 && (jsonOf(answer.body)?.error as { code?: number } | undefined)?.code === -32000);
  }
  {
    await turn();
    const answer = await new Promise<Answer>((resolve, reject) => {
      const sent = httpsRequest(mcpUrl, {
        method: "POST",
        headers: { ...rpcHeaders, "content-length": String(MCP_BODY_LIMIT + 1) },
        timeout: 25_000,
      });
      sent.on("response", (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          const headers: Record<string, string> = {};
          for (const [name, value] of Object.entries(response.headers)) headers[name] = Array.isArray(value) ? value.join(", ") : String(value);
          resolve({ status: response.statusCode ?? 0, headers, body: Buffer.concat(chunks).toString("latin1") });
          sent.destroy();
        });
      });
      sent.on("timeout", () => sent.destroy(new Error("no answer within 25 seconds")));
      sent.on("error", reject);
      sent.flushHeaders();
    });
    answers.push({ tag: "mcp", answer });
    judge("4r", "M5", `POST /mcp declaring Content-Length ${MCP_BODY_LIMIT + 1}, one byte over the route's limit`,
      "headers only, no body sent", answer, answer.status === 413);
  }
  {
    const answer = await call("mcp", mcpUrl, { method: "POST", headers: { "content-type": "text/plain", accept: "application/json, text/event-stream" }, body: "hello" });
    judge("4s", "M5", "POST /mcp with Content-Type text/plain", "the body hello", answer, answer.status === 415);
  }
  for (const [n, method] of [
    ["4t", "GET"],
    ["4u", "DELETE"],
  ] as const) {
    const answer = await call("mcp", mcpUrl, { method, headers: { accept: "application/json, text/event-stream" } });
    judge(n, "M5", `${method} /mcp`, "no body", answer, answer.status === 405 && answer.headers.allow === "POST", `allow ${answer.headers.allow ?? "(none)"}`);
  }
  {
    const gallery = await call("dreamloom", `${DREAMLOOM}/api/gallery`);
    const pictures = ((jsonOf(gallery.body)?.pictures ?? []) as { passportId: string; imageUrl: string | null }[]).filter((one) => one.imageUrl !== null);
    const pick = pictures[0];
    if (pick === undefined) {
      say(`4v  M6   control: no Dreamloom picture with an image in GET /api/gallery (${gallery.status}, ${short(gallery.body, 100)})`);
      push({ n: "4v", invariant: "M6", what: "control: check_picture of a real Dreamloom picture", found: "no picture to check", verdict: "NOT AS EXPECTED" });
    } else {
      const got = await tool("check_picture", { url: pick.imageUrl });
      const value = (got.answer.kind === "result" ? got.answer.structured : undefined) as
        | { verdict?: string; passportId?: string; distances?: unknown; facts?: Record<string, unknown> | null; index?: { lagSeconds?: unknown; stale?: unknown; chainHeadAt?: unknown }; contentCredentials?: { present?: unknown } }
        | undefined;
      const ok =
        got.answer.kind === "result" &&
        !got.answer.isError &&
        (value?.verdict === "exact" || value?.verdict === "match") &&
        value.passportId?.toLowerCase() === pick.passportId.toLowerCase() &&
        typeof value.facts === "object" &&
        value.facts !== null &&
        typeof value.index?.lagSeconds === "number";
      say(`4v  M6   control: check_picture of a real Dreamloom picture, the first one in Dreamloom's gallery`);
      say(`      sent: GET ${DREAMLOOM}/api/gallery (${gallery.status}), then tools/call check_picture {url: ${pick.imageUrl}}`);
      say(`      answer: verdict ${String(value?.verdict)}, passportId ${String(value?.passportId)} (the gallery's ${pick.passportId === value?.passportId ? "same id" : pick.passportId})`);
      say(`      distances ${JSON.stringify(value?.distances)}, contentCredentials.present ${String(value?.contentCredentials?.present)}`);
      say(`      facts ${value?.facts === null || value?.facts === undefined ? String(value?.facts) : Object.keys(value.facts).join(", ")}`);
      say(`      index.lagSeconds ${String(value?.index?.lagSeconds)}, index.stale ${String(value?.index?.stale)}, chainHeadAt ${String(value?.index?.chainHeadAt)}`);
      push({ n: "4v", invariant: "M6", what: "control: check_picture of a real Dreamloom picture", found: `${String(value?.verdict)}, facts and lagSeconds ${String(value?.index?.lagSeconds)}`,
        verdict: ok ? "PASSED" : "NOT AS EXPECTED" });
    }
  }
  await client.close();

  await sleep(GROUP_PAUSE_MS);
  say();
  say("STEP 5. DREAMLOOM");
  say("-----------------");
  const own = { origin: DREAMLOOM, "content-type": "application/json" };
  let sessionA = "";
  let pictureA = "";
  {
    const answer = await call("A", `${DREAMLOOM}/api/weave`, {
      method: "POST",
      headers: own,
      body: JSON.stringify({ prompt: "A paper lantern drifting over a still river at dusk, soft watercolour" }),
    }, 180_000);
    const cookie = answer.headers["set-cookie"] ?? "";
    const match = /dl_session=([0-9a-f]{32})/.exec(cookie);
    sessionA = match?.[1] ?? "";
    pictureA = String(jsonOf(answer.body)?.pictureId ?? "");
    if (sessionA !== "") redactions.set(sessionA, "<session A>");
    if (pictureA !== "") redactions.set(pictureA, "<picture A>");
    const flags = ["HttpOnly", "Secure", "SameSite=Lax"].filter((flag) => cookie.toLowerCase().includes(flag.toLowerCase()));
    const ok = answer.status === 200 && sessionA !== "" && pictureA !== "" && flags.length === 3;
    say("5a  D2   control: one real weave with session A (no cookie sent), Dreamloom's own Origin");
    say("      sent: POST /api/weave {prompt: a paper lantern over a river at dusk}");
    say(`      answer: ${answer.status}, pictureId <picture A>, a new dl_session cookie <session A> with ${flags.join(", ")}`);
    push({ n: "5a", invariant: "D2", what: "control: one real weave for session A", found: `${answer.status}, cookie flags ${flags.join(" ")}`, verdict: ok ? "PASSED" : "NOT AS EXPECTED" });
  }
  {
    const answer = await call("A", `${DREAMLOOM}/api/pictures/${pictureA}`, { headers: { cookie: `dl_session=${sessionA}` } });
    const view = jsonOf(answer.body) ?? {};
    const ok = answer.status === 200 && view.state === "woven" && !("cosignUrl" in view);
    say("5b  D2   control: session A reads its own picture");
    say("      sent: GET /api/pictures/<picture A> with session A's cookie");
    say(`      answer: ${answer.status}, state ${String(view.state)}, keys ${Object.keys(view).join(", ")}`);
    push({ n: "5b", invariant: "D2", what: "control: session A reads its own picture", found: `${answer.status} state ${String(view.state)}`, verdict: ok ? "PASSED" : "NOT AS EXPECTED" });
  }
  const sessionB = randomBytes(16).toString("hex");
  redactions.set(sessionB, "<session B>");
  say("      session B: a fresh 128-bit value in the dl_session cookie, the shape Dreamloom issues, that has woven");
  say("      nothing. Dreamloom keeps no session list, only each picture's session hash, so this is any other visitor.");
  const asB = { cookie: `dl_session=${sessionB}` };
  // Each POST body is one the route would refuse right after the ownership check, so an ownership
  // check that failed open shows as a 400 here and spends nothing.
  for (const [n, method, path, body, label] of [
    ["5c", "GET", "", undefined, "GET /api/pictures/<picture A>"],
    ["5d", "GET", "/image", undefined, "GET /api/pictures/<picture A>/image"],
    ["5e", "POST", "/cosign", { terms: "not-a-preset" }, "POST /api/pictures/<picture A>/cosign {terms: not-a-preset}"],
    ["5f", "POST", "/register", { terms: "not-a-preset" }, "POST /api/pictures/<picture A>/register {terms: not-a-preset}"],
    ["5g", "POST", "/move", { address: "x".repeat(101) }, "POST /api/pictures/<picture A>/move {address: 101 characters}"],
  ] as const) {
    const answer = await call("B", `${DREAMLOOM}/api/pictures/${pictureA}${path}`, {
      method,
      headers: method === "POST" ? { ...own, ...asB } : asB,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    judge(n, "D2", `session B: ${label}`, `session B's cookie${method === "POST" ? ", Dreamloom's own Origin" : ""}`, answer,
      answer.status === 404 && wordOf(answer) === "not-found" && onlyKeys(answer, ["error"]));
  }
  {
    const answer = await call("B", `${DREAMLOOM}/api/pictures/${pictureA}`);
    judge("5h", "D2", "no cookie: GET /api/pictures/<picture A>", "no cookie at all", answer,
      answer.status === 404 && wordOf(answer) === "not-found" && onlyKeys(answer, ["error"]));
  }
  for (const [n, origin, label] of [
    ["5i", undefined, "no Origin"],
    ["5j", "https://evil.example", "a foreign Origin"],
    ["5k", `${DREAMLOOM}.evil.example`, "a lookalike Origin"],
  ] as const) {
    const answer = await call("A", `${DREAMLOOM}/api/weave`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(origin === undefined ? {} : { origin }) },
      body: JSON.stringify({ prompt: "short" }),
    });
    judge(n, "D1", `POST /api/weave with ${label}`, `Origin ${origin ?? "(none)"}, prompt "short", which a passed check would answer 400 prompt without drawing`,
      answer, answer.status === 403 && wordOf(answer) === "origin");
  }
  {
    const answer = await call("A", `${DREAMLOOM}/api/pictures/${pictureA}/cosign`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://evil.example", cookie: `dl_session=${sessionA}` },
      body: JSON.stringify({ terms: "not-a-preset" }),
    });
    judge("5l", "D2", "POST /api/pictures/<picture A>/cosign carrying session A's own cookie from a foreign Origin",
      "session A's cookie, Origin https://evil.example, {terms: not-a-preset}", answer, answer.status === 403 && wordOf(answer) === "origin");
  }
  for (const [n, title, label] of [
    ["5m", "‮gpj.exe", "a right-to-left override then gpj.exe"],
    ["5n", "t".repeat(121), "121 characters"],
  ] as const) {
    const answer = await call("A", `${DREAMLOOM}/api/pictures/${pictureA}/cosign`, {
      method: "POST",
      headers: { ...own, cookie: `dl_session=${sessionA}` },
      body: JSON.stringify({ terms: "noAi", title }),
    });
    judge(n, "D2", `POST /api/pictures/<picture A>/cosign by session A with a malformed title: ${label}`,
      "session A's cookie, Dreamloom's Origin, {terms: noAi, title: " + label + "}", answer, answer.status === 400 && wordOf(answer) === "title");
  }
  {
    let bytes = 0;
    const hits: string[] = [];
    for (const { tag, answer } of answers) {
      const text = `${Object.entries(answer.headers).map(([name, value]) => `${name}: ${value}`).join("\n")}\n${answer.body}`.toLowerCase();
      bytes += text.length;
      for (const { name, form } of secretForms) {
        if (text.includes(form)) hits.push(`${name} in a ${tag} answer`);
      }
    }
    const names = [...new Set(secretForms.map((one) => one.name))];
    say(`5o  D3   every answer of the whole run so far, headers and body, scanned for every secret in .env.local`);
    say(`      scanned: ${answers.length} answers, ${bytes.toLocaleString("en-US")} characters, for ${names.join(", ")} in ${secretForms.length} forms (with and without 0x, lower case, and the RPC address's long path parts)`);
    say(`      found: ${hits.length === 0 ? "none" : [...new Set(hits)].join("; ")}`);
    push({ n: "5o", invariant: "D3", what: "secret values in any answer of the run", found: hits.length === 0 ? "none found" : "FOUND", verdict: hits.length === 0 ? "REFUSED" : "NOT AS EXPECTED" });
  }
  {
    const fromB = answers.filter((one) => one.tag === "B");
    const leaks = fromB.filter(({ answer }) => /cosign/i.test(answer.body) || (realHandle !== "" && answer.body.includes(realHandle)));
    say("5p  D5   every answer session B (and the no-cookie caller) got, scanned for a co-sign link");
    say(`      scanned: ${fromB.length} answers for "cosign", a cosignUrl field or a handle: ${leaks.length === 0 ? "none" : `${leaks.length} carry one`}`);
    say("      not covered: session A's picture was never opened for co-sign, since 3a is the only costly call");
    say("      this pass may make, so there was no live link for B to be shown; the route's owned() check that");
    say("      guards the link is the same one 5c to 5g show refusing");
    push({ n: "5p", invariant: "D5", what: "a co-sign link in any answer to session B", found: leaks.length === 0 ? "none" : "FOUND", verdict: leaks.length === 0 ? "REFUSED" : "NOT AS EXPECTED" });
  }

  await sleep(GROUP_PAUSE_MS);
  say();
  say("STEP 6. THE WEB APP (THE DEV SERVER ON THIS MACHINE; THE WEB IS NOT PUSHED YET)");
  say("--------------------------------------------------------------------------------");
  for (const [n, path] of [
    ["6a", "/en/cosign"],
    ["6b", "/en/connect"],
  ] as const) {
    await turn();
    const response = await fetch(`${WEB}${path}`, { redirect: "manual", signal: AbortSignal.timeout(120_000) });
    const body = await response.text();
    const headers = headersOf(response);
    answers.push({ tag: "web", answer: { status: response.status, headers, body } });
    const frame = headers["x-frame-options"] ?? "(none)";
    const csp = headers["content-security-policy"] ?? "(none)";
    const referrer = headers["referrer-policy"] ?? "(none)";
    // A header sent twice arrives joined by commas. Referrer-Policy takes its last token, and a
    // browser honours X-Frame-Options only when every token agrees.
    const effectiveReferrer = referrer.split(",").map((one) => one.trim()).filter((one) => one !== "").at(-1) ?? "";
    const frameTokens = frame.split(",").map((one) => one.trim().toUpperCase());
    const ok =
      response.status === 200 &&
      frameTokens.every((one) => one === "DENY") &&
      /frame-ancestors 'none'/.test(csp) &&
      effectiveReferrer === "no-referrer";
    say(`${n}  P10  GET ${WEB}${path}`);
    say(`      answer: ${response.status}, x-frame-options ${frame}, content-security-policy ${short(csp, 80)}, referrer-policy ${referrer}`);
    say(`      report-only policy also sent: ${headers["content-security-policy-report-only"] === undefined ? "no" : "yes (site-wide, not the one enforced here)"}`);
    push({ n, invariant: "P10", what: `${path} refuses every frame and sends no Referer`, found: `${response.status} XFO ${frame}, CSP ${short(csp, 40)}, ${referrer}`,
      verdict: ok ? "REFUSED" : "NOT AS EXPECTED" });
  }
  {
    await turn();
    const response = await fetch(`${WEB}/cosign`, { redirect: "manual", signal: AbortSignal.timeout(120_000) });
    await response.arrayBuffer();
    say(`note  the address the SDK builds from a site URL with no language, ${WEB}/cosign: ${response.status}${response.headers.get("location") === null ? "" : `, to ${response.headers.get("location")}`}`);
    say("      (not judged here: whether Dreamloom's live MOOLAM_SITE_URL carries /en is a setting this pass cannot read)");
  }

  printSummary();
}

main().catch((error: unknown) => {
  console.error(redact(error instanceof Error ? `${error.name}: ${error.message}` : "unknown error"));
  process.exit(1);
});
