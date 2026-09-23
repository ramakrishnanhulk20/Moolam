import { execFileSync } from "node:child_process";
import { createPrivateKey, generateKeyPairSync, sign } from "node:crypto";
import sharp from "sharp";
import { createPublicClient, http, type Hex } from "viem";
import { sealedMetadataSchema } from "@moolam/verifier/src/sealed.js";
import { MONAD_MAINNET, loadDeployment } from "../src/chain/addresses.js";

/**
 * The third attack pass, the live half: the sealed-picture feature attacked from outside, against
 * the hosted verify service, IPFS and the live site, on the one sealed passport on Monad mainnet.
 *
 * Nothing here sends a transaction or spends anything. The chain is only read, and every HTTP
 * request is made once: the hosted index and the live site share a small request budget, so there
 * is no loop and no retry. Nothing read from .env is printed; the gateway and the Privy app id are
 * used and never shown.
 *
 * Its holder may already have unsealed it, which is their right and the feature working. The
 * checks then ask a narrower question: was it published before this run, by the wallet the chain
 * says holds it, and does the live page show only the addresses that record names?
 *
 * The route half, with the real signer and a recording pin client, is
 * packages/verifier/test/attacks-sealed.test.ts.
 */

const VERIFIER = "https://verifier-production-d76f.up.railway.app";
const SITE = "https://moolam.vercel.app";

/** The first sealed passport on mainnet, registered from the live studio (proofs/sealed-passports.txt). */
const SEALED_ID = "0x980549624f85e4ef47043383c5a746cbdd1d82797b5b5583e1f5aeb3841d010c" as Hex;

const REQUEST_TIMEOUT_MS = 20_000;

/** The slice of the registry this reads, the same struct the verify service's unseal route reads. */
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

const ownerOfAbi = [
  {
    type: "function",
    name: "ownerOf",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "", type: "address" }],
  },
] as const;

/** What GET /unseal/<id> answers once a holder has published the picture. */
interface UnsealAnswer {
  image?: { cid?: string };
  thumbnail?: { cid?: string };
  manifest?: { cid?: string };
  record?: { cid?: string };
  unsealedBy?: string;
  unsealedAt?: string;
}

interface Line {
  n: string;
  what: string;
  found: string;
  notCovered: string;
  verdict: "REFUSED" | "PASS" | "LANDED AS EXPECTED" | "LANDED, NOT EXPECTED" | "FAILED";
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

/** The claims a Privy access token for this app carries, so only the signature is wrong. */
function claims(audience: string): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  return { iss: "privy.io", aud: audience, sub: "did:privy:attack-pass-3", iat: now, exp: now + 3600 };
}

/** An ES256 token signed by a key made on the spot, which Privy's key set has never seen. */
function strangersToken(audience: string): string {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const head = base64url(JSON.stringify({ alg: "ES256", typ: "JWT", kid: "attack-pass-3" }));
  const body = base64url(JSON.stringify(claims(audience)));
  const signature = sign("sha256", Buffer.from(`${head}.${body}`), {
    key: createPrivateKey(privateKey.export({ format: "pem", type: "pkcs8" })),
    dsaEncoding: "ieee-p1363",
  });
  return `${head}.${body}.${base64url(signature)}`;
}

/** The "alg": "none" downgrade: a token that claims to need no signature at all. */
function unsignedToken(audience: string): string {
  return `${base64url(JSON.stringify({ alg: "none", typ: "JWT" }))}.${base64url(JSON.stringify(claims(audience)))}.`;
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

/** Every string inside a JSON value, with the path that reaches it. */
function strings(value: unknown, at = ""): { path: string; text: string }[] {
  if (typeof value === "string") return [{ path: at, text: value }];
  if (Array.isArray(value)) return value.flatMap((item, index) => strings(item, `${at}[${index}]`));
  if (typeof value === "object" && value !== null) {
    return Object.entries(value).flatMap(([key, item]) => strings(item, at.length === 0 ? key : `${at}.${key}`));
  }
  return [];
}

function cidOf(uri: string): string {
  return uri.replace(/^ipfs:\/\//, "").split("/")[0] ?? "";
}

async function main(): Promise<void> {
  const startedAt = new Date();
  const audience = required("PRIVY_APP_ID");
  const gateway = required("PINATA_GATEWAY_URL").replace(/\/?$/, "/");
  const { registry } = loadDeployment();
  const client = createPublicClient({ transport: http(MONAD_MAINNET.rpc) });

  const block = await client.getBlockNumber({ cacheTime: 0 });
  const passport = await client.readContract({
    address: registry,
    abi: getPassportAbi,
    functionName: "getPassport",
    args: [SEALED_ID],
    blockNumber: block,
  });
  const holder = await client.readContract({
    address: registry,
    abi: ownerOfAbi,
    functionName: "ownerOf",
    args: [BigInt(SEALED_ID)],
    blockNumber: block,
  });

  say("Moolam attack pass 3, the live half: the sealed passport, attacked from outside.");
  say("Reads and HTTP only. No transaction is sent and nothing is spent.");
  say();
  say(`date        ${startedAt.toISOString()}`);
  say(`commit      ${commitHash()}`);
  say(`chain       Monad mainnet, chain 143, read at block ${block.toLocaleString("en-US")}`);
  say(`registry    ${registry}`);
  say(`passport    ${SEALED_ID}`);
  say(`creator     ${passport.creator}, registered at unix ${passport.registeredAt}`);
  say(`holder      ${holder} (ownerOf at the block above)`);
  say(`metadata    ${passport.metadataURI}`);
  say(`verifier    ${VERIFIER}`);
  say(`site        ${SITE}`);
  say();

  // The picture in these bodies is a flat grey square this script draws. The service must refuse
  // before it reads a byte of it, so what it shows does not matter.
  const decoy = await sharp({ create: { width: 64, height: 64, channels: 3, background: "#808080" } })
    .jpeg()
    .toBuffer();
  const unsealBody = (): FormData => {
    const form = new FormData();
    form.set("passportId", SEALED_ID);
    form.set("file", new Blob([new Uint8Array(decoy)], { type: "image/jpeg" }), "sealed.jpg");
    return form;
  };

  const tokens: [string, string, string | undefined][] = [
    ["5a", "no token", undefined],
    ["5b", "a malformed bearer", "Bearer not.a.jwt"],
    ["5c", "an ES256 token signed by a key made on the spot, right issuer and audience", `Bearer ${strangersToken(audience)}`],
    ["5d", "an alg none token, right issuer and audience", `Bearer ${unsignedToken(audience)}`],
  ];
  for (const [n, label, authorization] of tokens) {
    const answer = await call(`${VERIFIER}/unseal`, {
      method: "POST",
      body: unsealBody(),
      headers: authorization === undefined ? {} : { authorization },
    });
    const refused = answer.status === 401 && answer.cache === "no-store";
    say(`${n}  POST /unseal for the sealed passport with ${label}`);
    say(`      ${answer.status}, cache-control ${answer.cache}, ${short(answer.body)}`);
    lines.push({
      n,
      what: `POST /unseal with ${label}`,
      found: `${answer.status} ${short(answer.body, 40)}, ${answer.cache}`,
      notCovered: n === "5c" || n === "5d" ? "a token Privy itself issued to another user, which the route test 3a covers" : "a valid token, which the route tests cover",
      verdict: refused ? "REFUSED" : "LANDED, NOT EXPECTED",
    });
  }

  // Two honest outcomes. Still sealed is a 404. Published by its holder before this run started is
  // a 200 whose record predates the run and names the wallet the chain says holds the passport:
  // either way, nothing the four attempts above sent was published.
  const still = await call(`${VERIFIER}/unseal/${SEALED_ID}`);
  let published: UnsealAnswer | undefined;
  let stateFound: string;
  let stateOk = false;
  if (still.status === 404 && still.body.includes("not-unsealed")) {
    stateFound = "404 not-unsealed, the passport is still sealed";
    stateOk = still.cache === "no-store";
  } else if (still.status === 200) {
    published = JSON.parse(still.body) as UnsealAnswer;
    const at = published.unsealedAt === undefined ? Number.NaN : Date.parse(published.unsealedAt);
    const before = at < startedAt.getTime();
    const byHolder = published.unsealedBy?.toLowerCase() === holder.toLowerCase();
    stateFound = `200, unsealed at ${published.unsealedAt ?? "(no time)"} by ${published.unsealedBy ?? "(nobody)"}, ${before ? "before this run started" : "NOT before this run started"}, ${byHolder ? "the chain's holder" : "NOT the chain's holder"}`;
    stateOk = still.cache === "no-store" && before && byHolder;
  } else {
    stateFound = `${still.status} ${short(still.body, 60)}`;
  }
  say("5e  GET /unseal/<id> after the four attempts");
  say(`      ${still.status}, cache-control ${still.cache}`);
  say(`      ${stateFound}`);
  if (published !== undefined) {
    say(
      `      published addresses: image ${published.image?.cid ?? "-"}, thumbnail ${published.thumbnail?.cid ?? "-"}, manifest ${published.manifest?.cid ?? "-"}, record ${published.record?.cid ?? "-"}`,
    );
  }
  lines.push({
    n: "5e",
    what: "GET /unseal/<id>, nothing was published by 5a to 5d",
    found: `${stateFound}, ${still.cache}`,
    notCovered: "Pinata's own listing, which this answer is read from",
    verdict: stateOk ? "PASS" : "FAILED",
  });

  const prepareForm = new FormData();
  prepareForm.set("title", "attack pass 3");
  prepareForm.set("kind", "human");
  prepareForm.set("sealed", "true");
  prepareForm.set("file", new Blob([new Uint8Array(decoy)], { type: "image/jpeg" }), "decoy.jpg");
  const prepared = await call(`${VERIFIER}/prepare`, { method: "POST", body: prepareForm });
  say("5f  POST /prepare with sealed=true and no token");
  say(`      ${prepared.status}, cache-control ${prepared.cache}, ${short(prepared.body)}`);
  lines.push({
    n: "5f",
    what: "POST /prepare with sealed=true and no token",
    found: `${prepared.status} ${short(prepared.body, 40)}, ${prepared.cache}`,
    notCovered: "a signed-in sealed prepare, which would pin and is proved by the route tests 1a to 1e",
    verdict: prepared.status === 401 && prepared.cache === "no-store" ? "REFUSED" : "LANDED, NOT EXPECTED",
  });

  const recheck = await call(`${VERIFIER}/recheck/request`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ passportId: SEALED_ID }),
  });
  say("5g  POST /recheck/request for the sealed passport");
  say(`      ${recheck.status}, cache-control ${recheck.cache}, ${short(recheck.body)}`);
  if (published !== undefined && recheck.status === 409) {
    // The refusal the order asked for, and a finding next to it: the queue reads only the sealed
    // flag in the metadata document, which is written once and never changes.
    say("      finding: this passport was unsealed by its holder before the run, so its picture is public,");
    say("      and the queue still refuses it as sealed. Its answer tells the caller to publish first.");
  }
  lines.push({
    n: "5g",
    what: "POST /recheck/request for the sealed passport",
    found: `${recheck.status} ${short(recheck.body, 16)}, ${recheck.cache}${published === undefined ? "" : ", though the holder has unsealed it (see the finding above)"}`,
    notCovered: "the runner's own refusal, for the case where the gateway read times out and the request is queued",
    verdict: recheck.status === 409 && recheck.body.includes('"sealed"') ? "REFUSED" : "LANDED, NOT EXPECTED",
  });

  const metadataCid = cidOf(passport.metadataURI);
  let schemaOk = false;
  let found = "";
  try {
    const document = await call(`${gateway}${metadataCid}`, { headers: { accept: "application/json" } });
    const parsed: unknown = JSON.parse(document.body);
    const checked = sealedMetadataSchema.safeParse(parsed);
    const keys = Object.keys(parsed as Record<string, unknown>);
    const links = strings(parsed).filter(({ text }) => /(https?|ipfs):\/\//i.test(text));
    const commitment = (parsed as { commitment?: { value?: string } }).commitment?.value;
    schemaOk = document.status === 200 && checked.success && links.length === 0 && commitment === SEALED_ID;
    say("5h  the live sealed document on IPFS, through the gateway named in .env");
    say(`      ${document.status}, strict schema ${checked.success ? "accepts it" : `refuses it: ${checked.error.issues.map((issue) => issue.path.join(".")).join(", ")}`}`);
    say(`      keys ${keys.join(", ")}`);
    say(`      string values scanned ${strings(parsed).length}, http, https or ipfs links ${links.length === 0 ? "none" : links.map((link) => link.path).join(", ")}`);
    say(`      commitment ${commitment === SEALED_ID ? "equals the passport id" : `is ${String(commitment)}, not the passport id`}`);
    found = `schema ${checked.success ? "accepts" : "refuses"}, ${keys.length} keys, ${links.length} links, commitment ${commitment === SEALED_ID ? "matches" : "differs"}`;
  } catch (error) {
    found = `could not read or parse it: ${error instanceof Error ? error.message : String(error)}`;
    say(`5h  the live sealed document on IPFS: ${found}`);
  }
  lines.push({
    n: "5h",
    what: "the live sealed document, validated with the verify service's own strict schema",
    found,
    notCovered: "copies of the document on other gateways, which are the same bytes by content address",
    verdict: schemaOk ? "PASS" : "FAILED",
  });

  const page = await call(`${SITE}/en/passport/${SEALED_ID}`, { headers: { accept: "text/html" } });
  const gatewayHost = new URL(gateway).host;
  const addresses = [
    ...page.body.matchAll(/(?:ipfs:\/\/|\/ipfs\/)([A-Za-z0-9]{20,})/g),
  ].map((match) => match[1] as string);
  const onGateway = page.body.split(gatewayHost).length - 1;
  // The only addresses this page may carry: the sealed document, and once the holder has unsealed
  // it, the four the unseal record names. Anything else is a picture the page found some other way.
  const named = new Map<string, string>([[metadataCid, "the sealed document"]]);
  if (published !== undefined) {
    for (const [role, cid] of [
      ["the unsealed picture", published.image?.cid],
      ["its thumbnail", published.thumbnail?.cid],
      ["its manifest", published.manifest?.cid],
      ["the unseal record", published.record?.cid],
    ] as const) {
      if (cid !== undefined) named.set(cid, role);
    }
  }
  const distinct = [...new Set(addresses)];
  const foreign = distinct.filter((cid) => !named.has(cid));
  const imageTags = [...page.body.matchAll(/<img[^>]+src="([^"]+)"/g)].map((match) => match[1] as string);
  const ipfsImages = imageTags.filter((src) => src.includes("/ipfs/") || src.includes(gatewayHost));
  const strayImages = ipfsImages.filter((src) => published === undefined || ![...named.keys()].some((cid) => src.includes(cid)));
  const pageOk = page.status === 200 && foreign.length === 0 && strayImages.length === 0;
  say(`5i  GET ${SITE}/en/passport/<id>`);
  say(`      ${page.status}, ${page.body.length.toLocaleString("en-US")} characters of HTML`);
  for (const cid of distinct) {
    say(`      IPFS address ${cid}: ${named.get(cid) ?? "NOT named by the chain or the unseal record"}`);
  }
  say(`      mentions of the gateway host from .env ${onGateway}, <img> tags ${imageTags.length}, of which on IPFS ${ipfsImages.length}, of which not from the unseal record ${strayImages.length}`);
  lines.push({
    n: "5i",
    what: "the live passport page for the sealed passport",
    found: `${page.status}, ${foreign.length} IPFS address the chain and the unseal record do not name, ${strayImages.length} stray IPFS image${published === undefined ? "" : ", and the picture the holder published is shown"}`,
    notCovered: "what the browser fetches after hydration, which only the rendered HTML and payload are checked for here",
    verdict: pageOk ? "PASS" : "FAILED",
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
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
