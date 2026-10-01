import { getAddress, type Address, type Hex } from "viem";
import { heldAgent } from "@/lib/chain/registry";
import { heldHandover, type IndexHandover } from "@/lib/data/passports";
import {
  canonicalOrigin,
  confirmedAtFor,
  creditFor as creditRule,
  loadPlatforms,
  platformForOrigin,
  platformLabel,
  type Credit,
  type CreditPassport,
  type LabelPassport,
  type PlatformLabel,
  type PlatformList,
} from "@/lib/platforms/platforms";

/**
 * The web app's one door to Moolam's signed platform list (P16).
 *
 * The list ships inside the build, next to this app, so it is read from the
 * copied file and never over the network from the verify service. Loading it
 * checks every EIP-712 signature, which is too slow to repeat per render and
 * cannot change while the process lives, so the answer is kept for the life of
 * the server process.
 *
 * A list that fails any check is refused whole by loadPlatforms, and a refused
 * list here means no labels at all (P15): the base words on every page are
 * true without the list, so losing it can only lose a label, never add a claim.
 */
let held: Promise<PlatformList> | null = null;

const REFUSED: PlatformList = { ok: false, platforms: [], reason: "the platform list did not load" };

export function heldPlatformList(): Promise<PlatformList> {
  held ??= loadPlatforms().catch(() => REFUSED);
  return held;
}

/**
 * The label for one passport from a list already loaded, or null when there is
 * none to show. The only place a page turns a list into a label, so every
 * screen asks the same question the same way.
 */
export function labelFrom(list: PlatformList, passport: LabelPassport, now?: bigint): PlatformLabel | null {
  if (!list.ok) {
    return null;
  }
  return platformLabel(passport, list.platforms, now);
}

/** The label for one passport, read against the held list. */
export async function labelFor(passport: LabelPassport): Promise<PlatformLabel | null> {
  return labelFrom(await heldPlatformList(), passport);
}

/**
 * Who is credited with one passport, from a list already loaded: the same
 * creditFor the MCP server calls, so the site and the server never disagree
 * about who imagined a picture. A refused list credits nobody, and so does a
 * holder, an agent owner or a first handover that was not read, which leaves
 * the base words. The handover fields come from handoverFacts.
 */
export function creditFrom(list: PlatformList, passport: CreditPassport, now?: bigint): Credit | null {
  if (!list.ok) {
    return null;
  }
  return creditRule(passport, list.platforms, now);
}

/** The two handover fields the credit rule reads. */
export type HandoverFacts = Pick<CreditPassport, "firstRecipient" | "firstRecipientConfirmedAt">;

/** What the rule reads when the index could not say: nobody is credited (P35). */
export const UNKNOWN_HANDOVER: HandoverFacts = { firstRecipient: "unknown", firstRecipientConfirmedAt: null };

/**
 * The first recipient and the time they confirmed, from one index answer, by
 * the MCP server's rules (packages/verifier/src/mcp/handover.ts). The
 * confirmation is confirmedAtFor's, the one predicate both sides use: the
 * earliest entry the first recipient wrote, and nobody else's.
 *
 * "unknown" for an answer the index could not give, a recipient that is not an
 * address, a history longer than the read when the first recipient's entry was
 * not in the part read, and a confirmation dated before the handover (only a
 * holder can write, so that row is damaged).
 */
export function handoverFacts(handover: IndexHandover | "unknown"): HandoverFacts {
  if (handover === "unknown") {
    return UNKNOWN_HANDOVER;
  }
  const { firstTransferTo, firstTransferAt } = handover;
  if (firstTransferTo === null && firstTransferAt === null) {
    return { firstRecipient: null, firstRecipientConfirmedAt: null };
  }
  if (firstTransferTo === null || firstTransferAt === null) {
    return UNKNOWN_HANDOVER;
  }
  let recipient: Address;
  try {
    recipient = getAddress(firstTransferTo);
  } catch {
    return UNKNOWN_HANDOVER;
  }
  const confirmedAt = confirmedAtFor(handover.consent, recipient);
  if (confirmedAt === null && handover.consentCount > handover.consent.length) {
    return UNKNOWN_HANDOVER;
  }
  if (confirmedAt !== null && confirmedAt < firstTransferAt) {
    return UNKNOWN_HANDOVER;
  }
  return { firstRecipient: recipient, firstRecipientConfirmedAt: confirmedAt };
}

/**
 * Today's owner of a generator agent Moolam lists, through the same held agent
 * read the agent page and the facts strip make, or null for an agent the list
 * does not name and for a read that failed. Only a current entry can earn the
 * co-signed credit, so an agent named only by a retired entry is not read.
 */
export async function listedAgentOwner(list: PlatformList, agentId: bigint): Promise<string | null> {
  if (!list.ok || agentId === 0n || !list.platforms.some((entry) => entry.validTo === null && entry.agentId === agentId)) {
    return null;
  }
  try {
    return (await heldAgent(agentId.toString())).owner;
  } catch {
    return null;
  }
}

/**
 * The credit for one passport, read against the held list.
 *
 * The rule reads the holder only for a listed wallet's passport, the first
 * handover only for one the kit label covers, and the agent's owner only for
 * any other, so each is asked for only where it can change the answer: every
 * other passport on the site costs none of the three. readHolder is
 * ownerOf(passportId) as the page already holds it; readHandover is the held
 * index read, and anything it cannot answer reads "unknown".
 */
export async function creditFor(
  passport: LabelPassport & { id: Hex },
  readHolder: () => Promise<string | null>,
  readHandover: (id: Hex) => Promise<IndexHandover | "unknown"> = heldHandover,
): Promise<Credit | null> {
  const list = await heldPlatformList();
  if (!list.ok) {
    return null;
  }
  const label = labelFrom(list, passport);
  const listedCreator = label !== null;
  const [holder, agentOwnerNow, handover] = await Promise.all([
    listedCreator ? readHolder().catch(() => null) : null,
    listedCreator ? null : listedAgentOwner(list, passport.generatorAgentId),
    label?.status === "kit" ? readHandover(passport.id).catch(() => "unknown" as const) : ("unknown" as const),
  ]);
  return creditFrom(list, { ...passport, holder, agentOwnerNow, ...handoverFacts(handover) });
}

/**
 * The platform name a plate may wear, or null: the platform of any credit case.
 * A listed wallet's passport made outside the kit is said in full on its own
 * page, where there is room to say why it earns no mark.
 *
 * Held, handed, confirmed and passed on all wear the same mark, and only the
 * holder and the handover tell them apart, so a plate reads the kit label
 * itself and never asks who holds it or who it went to first.
 * Every other passport goes through the credit rule with the agent's owner
 * read now, so a co-signed plate loses its mark the moment the agent changes
 * hands, exactly as its page loses the credit.
 */
export function plateMark(list: PlatformList, passport: LabelPassport, agentOwnerNow: string | null): string | null {
  const label = labelFrom(list, passport);
  if (label !== null) {
    return label.status === "kit" ? label.name : null;
  }
  return creditFrom(list, { ...passport, holder: null, agentOwnerNow, ...UNKNOWN_HANDOVER })?.platform ?? null;
}

/** Who a site asking for an address is: its canonical origin, and the listed platform that owns it, if any. */
export interface OriginAsker {
  /** Null when the value is not an https origin in any spelling canonicalOrigin accepts. */
  origin: string | null;
  /** The listed name, or null for an unlisted site. */
  name: string | null;
}

/**
 * The connect page's question (P22): which listed platform, if any, a site
 * asking for a person's address belongs to. The value is canonicalised by the
 * same function the stored origins passed, so a look-alike spelling is its own
 * origin and names nobody, and a refused list names nobody either.
 */
export function askerFrom(list: PlatformList, value: string): OriginAsker {
  const origin = canonicalOrigin(value);
  if (origin === null) {
    return { origin: null, name: null };
  }
  const platform = list.ok ? platformForOrigin(origin, list.platforms) : null;
  return { origin, name: platform?.name ?? null };
}

/** The same answer, read against the held list. */
export async function askerAt(value: string): Promise<OriginAsker> {
  return askerFrom(await heldPlatformList(), value);
}
