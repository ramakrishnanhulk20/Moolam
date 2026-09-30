// This folder is copied byte for byte into packages/web/lib/platforms by
// scripts/platforms-sync.ts, and the web app's platforms-copy test fails on any
// difference. Edit it here only, and import nothing but viem and zod, so the
// same file compiles in both packages.

import { getAddress, recoverTypedDataAddress, type Address, type Hex } from "viem";
import { z } from "zod";
import bundledList from "./platforms.json" with { type: "json" };

/** The EIP-712 domain both onboarding signatures are made in. Chain 143 is Monad mainnet. */
export const ONBOARDING_DOMAIN = { name: "Moolam platform", version: "1", chainId: 143 } as const;

/** Field order is load bearing: it produces the type string every signer hashes. */
export const ONBOARDING_TYPES = {
  PlatformOnboarding: [
    { name: "name", type: "string" },
    { name: "agentId", type: "uint256" },
    { name: "agentOwner", type: "address" },
    { name: "creatorWallet", type: "address" },
    { name: "keyHash", type: "bytes32" },
    { name: "origins", type: "string[]" },
    { name: "validFrom", type: "uint64" },
  ],
} as const;

/** Matches Kind.Generated in IMoolamRegistry.sol. Written here because this file may import nothing of Moolam's. */
export const KIND_GENERATED = 0;

/** Code points, not bytes. Long enough for a company name, short enough to sit on a badge. */
export const MAX_NAME_LENGTH = 48;

/** Far above any real list. It exists so a damaged file cannot make every page verify without end. */
export const MAX_PLATFORMS = 500;

/** A production site, a staging site and room for a rename. More is a sign the entry is doing two platforms' work. */
export const MAX_ORIGINS = 4;

const MAX_UINT256 = (1n << 256n) - 1n;
const ZERO_HASH = `0x${"0".repeat(64)}`;

// Letters, marks, digits, punctuation, symbols and the plain space. Everything
// in Unicode's control, format, private use, unassigned and separator classes
// falls outside it, which is what shuts out zero width joiners and direction
// overrides without a list of them. It does not catch look-alike letters from
// two scripts; the badge always shows the wallet and agent id for that reason.
const PRINTABLE_NAME = /^[\p{L}\p{M}\p{N}\p{P}\p{S} ]+$/u;

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "not an address");
const bytes32 = z.string().regex(/^0x[0-9a-f]{64}$/, "not 0x and 64 lowercase hex");
const signature = z.string().regex(/^0x[0-9a-f]{130}$/, "not a 65 byte signature in lowercase hex");
const unixSeconds = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);

/** One entry exactly as platforms.json stores it. */
export const platformRecordSchema = z
  .object({
    name: z.string().min(1).max(MAX_NAME_LENGTH * 2),
    agentId: z.string().regex(/^[1-9][0-9]{0,77}$/, "not a decimal agent id above zero"),
    ownerAtOnboarding: address,
    creatorWallet: address,
    keyHash: bytes32,
    origins: z.array(z.string()).min(1).max(MAX_ORIGINS),
    validFrom: unixSeconds,
    validTo: unixSeconds.optional(),
    acceptedAt: unixSeconds,
    ownerSignature: signature,
    creatorSignature: signature,
  })
  .strict();

export const platformListSchema = z.array(platformRecordSchema).max(MAX_PLATFORMS);

export type PlatformRecord = z.infer<typeof platformRecordSchema>;

/** One entry after loading: signatures checked, addresses checksummed, numbers as bigint. */
export interface Platform {
  name: string;
  agentId: bigint;
  ownerAtOnboarding: Address;
  creatorWallet: Address;
  keyHash: Hex;
  /** Canonical https origins, as canonicalOrigin returns them. */
  origins: readonly string[];
  validFrom: bigint;
  /** Exclusive. Null while the entry is the platform's current one. */
  validTo: bigint | null;
  acceptedAt: bigint;
}

export type PlatformList =
  | { ok: true; platforms: Platform[] }
  | { ok: false; platforms: []; reason: string };

/** The fields both parties sign. agentOwner is the owner recorded at onboarding. */
export interface OnboardingMessage {
  name: string;
  agentId: bigint;
  agentOwner: Address;
  creatorWallet: Address;
  keyHash: Hex;
  origins: readonly string[];
  validFrom: bigint;
}

/** The typed data to hand to signTypedData, or to recover a signature against. */
export function onboardingTypedData(message: OnboardingMessage) {
  return {
    domain: ONBOARDING_DOMAIN,
    types: ONBOARDING_TYPES,
    primaryType: "PlatformOnboarding" as const,
    message,
  };
}

/**
 * The one form a platform name is stored and signed in: NFKC, trimmed, and every
 * run of white space as one plain space. The loader refuses a stored name that
 * is not already in this form rather than repairing it, because the signatures
 * cover the stored bytes.
 */
export function cleanName(raw: string): string {
  return raw.normalize("NFKC").trim().replace(/\s+/gu, " ");
}

/** The key two names collide on: the cleaned name, case folded by an upper then lower pass so "ß" meets "SS". */
export function nameKey(name: string): string {
  return cleanName(cleanName(name).toUpperCase().toLowerCase());
}

/** Why a name cannot be listed, or null when it can. */
export function nameProblem(name: string): string | null {
  if (name !== cleanName(name)) return "name is not in its cleaned form";
  const length = [...name].length;
  if (length === 0) return "name is empty";
  if (length > MAX_NAME_LENGTH) return `name is longer than ${MAX_NAME_LENGTH} characters`;
  if (!PRINTABLE_NAME.test(name)) return "name holds a character that is not printable";
  return null;
}

/**
 * The one parser for a platform's web origin, used for the stored list and for
 * every value a caller asks about, so the two sides are always compared in the
 * same form. Returns the WHATWG origin (lowercase host, default port dropped)
 * of an https URL that carries nothing beyond scheme, host and port, or null.
 *
 * Covers: anything URL cannot parse, any scheme but https, a user name or
 * password, a path other than "/", a query, a fragment. Does not cover a
 * look-alike host (a punycode or a trailing dot spelling stays a different
 * origin, which only means it never matches) or who controls the host.
 */
export function canonicalOrigin(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (url.username !== "" || url.password !== "") return null;
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") return null;
  return url.origin;
}

/**
 * Why an entry's origins cannot be stored, or null. Only the canonical spelling
 * is accepted and never repaired, because the signatures cover the stored strings.
 */
export function originsProblem(origins: readonly string[]): string | null {
  if (origins.length === 0) return "origins is empty";
  if (origins.length > MAX_ORIGINS) return `more than ${MAX_ORIGINS} origins`;
  for (const [index, origin] of origins.entries()) {
    if (canonicalOrigin(origin) !== origin) return `origin ${index} is not an https origin in its canonical form`;
  }
  if (new Set(origins).size !== origins.length) return "an origin appears twice";
  return null;
}

/** The message a stored entry's two signatures must cover, rebuilt from its fields. */
export function recordMessage(record: PlatformRecord): OnboardingMessage {
  return {
    name: record.name,
    agentId: BigInt(record.agentId),
    agentOwner: getAddress(record.ownerAtOnboarding),
    creatorWallet: getAddress(record.creatorWallet),
    keyHash: record.keyHash as Hex,
    origins: record.origins,
    validFrom: BigInt(record.validFrom),
  };
}

/** True only when the signature recovers to the expected address. Any recovery error is a no. */
export async function signedBy(message: OnboardingMessage, sig: Hex, expected: Address): Promise<boolean> {
  try {
    const signer = await recoverTypedDataAddress({ ...onboardingTypedData(message), signature: sig });
    return getAddress(signer) === getAddress(expected);
  } catch {
    return false;
  }
}

/** Why one entry cannot stand on its own, or null when both signatures and every bound hold. */
export async function recordProblem(record: PlatformRecord): Promise<string | null> {
  const problem = nameProblem(record.name) ?? originsProblem(record.origins);
  if (problem !== null) return problem;
  if (BigInt(record.agentId) > MAX_UINT256) return "agent id is larger than a uint256";
  if (record.validTo !== undefined && record.validTo <= record.validFrom) return "validTo is not after validFrom";
  const message = recordMessage(record);
  if (!(await signedBy(message, record.ownerSignature as Hex, message.agentOwner))) {
    return "owner signature does not recover to ownerAtOnboarding";
  }
  if (!(await signedBy(message, record.creatorSignature as Hex, message.creatorWallet))) {
    return "creator signature does not recover to creatorWallet";
  }
  return null;
}

function toPlatform(record: PlatformRecord): Platform {
  return {
    name: record.name,
    agentId: BigInt(record.agentId),
    ownerAtOnboarding: getAddress(record.ownerAtOnboarding),
    creatorWallet: getAddress(record.creatorWallet),
    keyHash: record.keyHash as Hex,
    origins: [...record.origins],
    validFrom: BigInt(record.validFrom),
    validTo: record.validTo === undefined ? null : BigInt(record.validTo),
    acceptedAt: BigInt(record.acceptedAt),
  };
}

function overlaps(a: Platform, b: Platform): boolean {
  const aEnds = a.validTo ?? MAX_UINT256;
  const bEnds = b.validTo ?? MAX_UINT256;
  return a.validFrom < bEnds && b.validFrom < aEnds;
}

/**
 * Why the entries cannot stand together, or null. A name belongs to one agent,
 * so a second platform cannot take a listed name in another spelling. Entries
 * that share a name are one platform's rotations: same name, same agent, no two
 * windows overlapping. An agent and a creator wallet each belong to one name,
 * which together make at most one entry answer for any passport. A key hash
 * appears once, because the key is what identifies the platform to the service.
 * An origin belongs to one name too, so the connect page can only ever name one
 * platform for a site; a platform's own rotations may keep their origins. The
 * origins are compared as stored, which is safe because each entry holds only
 * canonicalOrigin's output.
 */
function listProblem(platforms: Platform[]): string | null {
  for (let i = 0; i < platforms.length; i++) {
    const a = platforms[i]!;
    for (let j = i + 1; j < platforms.length; j++) {
      const b = platforms[j]!;
      const where = `entries ${i} and ${j}`;
      const sameName = nameKey(a.name) === nameKey(b.name);
      if (sameName && a.name !== b.name) return `${where}: the same name in two spellings`;
      if (sameName && a.agentId !== b.agentId) return `${where}: one name for two agents`;
      if (!sameName && a.agentId === b.agentId) return `${where}: one agent under two names`;
      if (!sameName && a.creatorWallet === b.creatorWallet) return `${where}: one creator wallet under two names`;
      if (!sameName && a.origins.some((origin) => b.origins.includes(origin))) return `${where}: one origin under two names`;
      if (sameName && overlaps(a, b)) return `${where}: two windows of one platform overlap`;
      if (a.keyHash === b.keyHash) return `${where}: one key hash twice`;
    }
  }
  return null;
}

/**
 * Loads and checks a platform list. With no argument it reads the list shipped
 * in this folder. Every entry's two EIP-712 signatures are recovered offline
 * against the addresses it names, every address goes through getAddress, and
 * the list's names, agents, wallets and windows are checked together.
 *
 * Fails closed: if any entry or any pair fails, the whole list is refused and
 * the result carries no platforms and one reason. Makes no network call.
 */
export async function loadPlatforms(document: unknown = bundledList): Promise<PlatformList> {
  const refuse = (reason: string): PlatformList => ({ ok: false, platforms: [], reason });
  const parsed = platformListSchema.safeParse(document);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return refuse(`list does not match the schema at ${issue?.path.join(".") || "the top"}: ${issue?.message ?? "invalid"}`);
  }
  for (const [index, record] of parsed.data.entries()) {
    const problem = await recordProblem(record);
    if (problem !== null) return refuse(`entry ${index}: ${problem}`);
  }
  const platforms = parsed.data.map(toPlatform);
  const problem = listProblem(platforms);
  if (problem !== null) return refuse(problem);
  return { ok: true, platforms };
}

/**
 * The listed platform a web origin belongs to, for the connect page to name the
 * requester and to pick the one origin it may post an address to (P22, P10).
 * The value goes through canonicalOrigin, the same parser the stored origins
 * passed, and is then compared by exact string equality. Only current entries
 * (validTo null) answer, since a retired entry's site no longer speaks for the
 * platform. A value that does not parse or is not https gives null, and so does
 * an origin claimed by two current entries, since the page could not say which
 * platform is asking.
 */
export function platformForOrigin(origin: string, platforms: readonly Platform[]): Platform | null {
  const wanted = canonicalOrigin(origin);
  if (wanted === null) return null;
  const matches = platforms.filter((entry) => entry.validTo === null && entry.origins.includes(wanted));
  return matches.length === 1 ? matches[0]! : null;
}

/** The passport fields the label reads, as the registry's getPassport returns them. */
export interface LabelPassport {
  creator: string;
  kind: number;
  generatorAgentId: bigint;
  manifestHash: string;
  registeredAt: bigint;
}

export type PlatformLabel =
  | { status: "kit"; name: string; platform: Platform }
  | { status: "outsideKit"; name: string; platform: Platform };

/**
 * The one predicate that issues a platform's label (P16). "kit" only when the
 * creator is a listed wallet, the passport is Generated by that entry's agent,
 * it carries a manifest, and registeredAt falls inside [validFrom, validTo) and
 * is not after now. A listed wallet whose passport fails any of those reads
 * "outsideKit" with the listed name, never the label. An unlisted creator, or a
 * creator that is not an address, gives null.
 *
 * The co-sign page must also compare ownerOf(agentId) read now with the entry's
 * ownerAtOnboarding before showing the badge; that read is agentOwnerUnchanged's
 * job, not this function's, so this stays a pure check with no chain call.
 *
 * @param now unix seconds; defaults to the machine clock.
 */
export function platformLabel(
  passport: LabelPassport,
  entries: readonly Platform[],
  now: bigint = BigInt(Math.floor(Date.now() / 1000)),
): PlatformLabel | null {
  let creator: Address;
  try {
    creator = getAddress(passport.creator);
  } catch {
    return null;
  }
  const listed = entries.filter((entry) => getAddress(entry.creatorWallet) === creator);
  const first = listed[0];
  if (first === undefined) return null;

  const match = listed.find(
    (entry) => generatedByAgent(passport, entry.agentId) && registeredInWindow(passport.registeredAt, entry, now),
  );
  if (match !== undefined) return { status: "kit", name: match.name, platform: match };
  return { status: "outsideKit", name: first.name, platform: first };
}

/** Generated, by this agent, with a manifest: the passport terms the label and the co-sign credit share. */
function generatedByAgent(passport: LabelPassport, agentId: bigint): boolean {
  const manifestHash = passport.manifestHash.toLowerCase();
  const hasManifest = /^0x[0-9a-f]{64}$/.test(manifestHash) && manifestHash !== ZERO_HASH;
  return passport.kind === KIND_GENERATED && passport.generatorAgentId === agentId && hasManifest;
}

/** Inside [validFrom, validTo) and not after now, since a registration time from the future is not one the chain gave. */
function registeredInWindow(registeredAt: bigint, entry: Platform, now: bigint): boolean {
  return registeredAt >= entry.validFrom && (entry.validTo === null || registeredAt < entry.validTo) && registeredAt <= now;
}

/** What creditFor reads: the label's passport fields, today's holder and today's owner of the generator agent. */
export interface CreditPassport extends LabelPassport {
  /** ownerOf(passportId) read now, or null when it could not be read. */
  holder: string | null;
  /** ownerOf(generatorAgentId) on the ERC-8004 registry read now, or null when it was not or could not be read. */
  agentOwnerNow: string | null;
}

export interface Credit {
  case: "unclaimed" | "claimed" | "cosigned";
  /** The listed platform's name: where the picture was drawn, never its maker. */
  platform: string;
  /** The person who imagined the picture, or null while the platform still holds it. */
  imaginedBy: Address | null;
}

/**
 * The one rule for who is credited with a picture drawn on a listed platform, so
 * the site and the MCP server say the same thing: the person who imagined it,
 * never the platform.
 *
 * "unclaimed" and "claimed" rest on platformLabel's "kit": the platform's wallet
 * registered it, and the credit follows the holder. While the holder is the
 * creator the platform still holds it and nobody is named; once it has handed the
 * passport on, the holder is named, and that credit rests on the handover alone.
 *
 * "cosigned" is a creator platformLabel does not know, a Generated passport with
 * a manifest by a current entry's agent, registered inside that entry's window,
 * whose agent is still owned by the owner that signed at onboarding (the co-sign
 * page's own rule). The creator's own key approved the picture, so the creator is
 * named.
 *
 * Null for everything else: "outsideKit", an unlisted agent, an agent owner that
 * changed or was not read, and a holder that was not read in the kit cases,
 * because credit is never guessed. Every address pair is compared after
 * getAddress on both sides.
 *
 * @param now unix seconds; defaults to the machine clock.
 */
export function creditFor(
  input: CreditPassport,
  entries: readonly Platform[],
  now: bigint = BigInt(Math.floor(Date.now() / 1000)),
): Credit | null {
  const label = platformLabel(input, entries, now);
  if (label !== null) {
    if (label.status !== "kit" || input.holder === null) return null;
    let holder: Address;
    try {
      holder = getAddress(input.holder);
    } catch {
      return null;
    }
    // platformLabel only says "kit" for a creator that getAddress accepted.
    return holder === getAddress(input.creator)
      ? { case: "unclaimed", platform: label.name, imaginedBy: null }
      : { case: "claimed", platform: label.name, imaginedBy: holder };
  }

  if (input.agentOwnerNow === null) return null;
  let creator: Address;
  let agentOwner: Address;
  try {
    creator = getAddress(input.creator);
    agentOwner = getAddress(input.agentOwnerNow);
  } catch {
    return null;
  }
  const matches = entries.filter(
    (entry) =>
      entry.validTo === null &&
      generatedByAgent(input, entry.agentId) &&
      registeredInWindow(input.registeredAt, entry, now) &&
      getAddress(entry.ownerAtOnboarding) === agentOwner,
  );
  // The list rule allows one current entry per agent; two would leave the platform's name in doubt.
  if (matches.length !== 1) return null;
  return { case: "cosigned", platform: matches[0]!.name, imaginedBy: creator };
}

/** Reads ownerOf(agentId) from the ERC-8004 identity registry. Supplied by the caller that owns a chain client. */
export type ReadAgentOwner = (agentId: bigint) => Promise<string>;

/**
 * The co-sign page's extra condition: the agent's owner read now is still the
 * owner that signed at onboarding. Any read error, or a value that is not an
 * address, is false.
 */
export async function agentOwnerUnchanged(platform: Platform, readOwner: ReadAgentOwner): Promise<boolean> {
  try {
    return getAddress(await readOwner(platform.agentId)) === getAddress(platform.ownerAtOnboarding);
  } catch {
    return false;
  }
}
