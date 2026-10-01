import type { FastifyInstance } from "fastify";
import { getAddress, type Address } from "viem";
import { TRAINING_STANDARD, trainingSchema } from "../consent.js";
import { answerFromChain, type ConsentAnswer } from "../consentRead.js";
import { type DisputeAnswer, INHERITED_DISPUTE_MAX_DEPTH } from "../disputeRead.js";
import { creditFor, platformLabel, type Credit, type PlatformList } from "../platforms/platforms.js";
import { recheckFor, type RecheckAnswer } from "../recheck.js";
import type { Hex, IndexState } from "../types.js";
import type { DocumentReader } from "../unseal.js";
import type { CardAnswer, CardReader } from "./agentCard.js";
import { isZeroAddress, type McpChain } from "./chain.js";
import type { HandoverReader } from "./handover.js";
import {
  defaultMarkReaders,
  disputeForMark,
  markAnswer,
  pictureForMark,
  type MarkAnswer,
  type MarkIndexReader,
  type UnsealedReader,
} from "./markFacts.js";
import type { RecentReader } from "./recent.js";

/** Everything the tools and resources read through. Each reader is already behind its memory. */
export interface McpDeps {
  app: FastifyInstance;
  chain: McpChain;
  readDocument: DocumentReader;
  readCard: CardReader;
  recent: RecentReader;
  handover: HandoverReader;
  platforms: PlatformList;
  /**
   * The trust mark's two readers. Left out, get_passport uses defaultMarkReaders(): the index this
   * host reads, and nothing at all under a test runner.
   */
  mark?: { index: MarkIndexReader; unsealed: UnsealedReader };
}

/**
 * Either the answer, or why there is none. `reason` is always one of the fixed sentences below and
 * never carries an address, a host's words or a value a caller sent (M3, M4).
 */
export type Outcome<T> = { ok: true; value: T } | { ok: false; reason: string };

export const CHAIN_UNAVAILABLE = "unavailable: the chain could not be read just now, so nothing is said about this passport";
export const AGENT_UNAVAILABLE = "unavailable: the identity registry could not be read just now";
export const TERMS_UNAVAILABLE = "unavailable: the AI-use register could not be read just now, which is not the same as nothing stated";
export const INDEX_BEHIND = "unavailable: the passport index is behind the chain, so it cannot say what is missing";
export const INDEX_UNAVAILABLE = "unavailable: the passport index could not be read just now";
export const NOT_INDEXED_YET = "unavailable: this passport is on chain but the index has not caught up with it yet";

/** Titles and addresses written by a registrant, cut to a length a model's context can afford (M4). */
const TITLE_MAX = 200;
const URI_MAX = 300;

const KIND_WORDS = ["generated", "captured", "edited"] as const;

function cut(value: string, max: number): string {
  return [...value].slice(0, max).join("");
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function kindWord(kind: number): (typeof KIND_WORDS)[number] | "unknown" {
  return KIND_WORDS[kind] ?? "unknown";
}

/** A metadata document's title, or null when it has none that is text. */
function titleOf(document: unknown): string | null {
  const name = (document as { name?: unknown } | null)?.name;
  return typeof name === "string" && name.length > 0 ? cut(name, TITLE_MAX) : null;
}

async function documentOf(deps: McpDeps, uri: string): Promise<{ read: true; document: unknown } | { read: false }> {
  try {
    return { read: true, document: await deps.readDocument(uri) };
  } catch {
    return { read: false };
  }
}

async function holderOf(deps: McpDeps, id: Hex): Promise<Address | null> {
  try {
    return await deps.chain.holder(id);
  } catch {
    return null;
  }
}

/**
 * ownerOf(agentId) now, only for an agent a current list entry names, since creditFor reads it for
 * nothing else and an unlisted agent's owner would be a read spent on a caller's choice. Null when
 * not listed, not minted or not readable, which creditFor treats as no credit.
 */
async function listedAgentOwner(deps: McpDeps, agentId: bigint): Promise<Address | null> {
  const listed = deps.platforms.ok && deps.platforms.platforms.some((entry) => entry.validTo === null && entry.agentId === agentId);
  if (!listed) return null;
  try {
    return (await deps.chain.agent(agentId))?.owner ?? null;
  } catch {
    return null;
  }
}

const HANDOVER_UNKNOWN = { firstRecipient: "unknown", confirmedAt: null } as const;

/**
 * The first handover and its confirmation from the index, the one source for both (P35), asked
 * only for a passport platformLabel calls "kit", since creditFor reads them for nothing else and
 * the index's query budget is shared. An index the service reads as behind, or one that cannot
 * answer, gives "unknown", which creditFor turns into no credit.
 */
async function kitHandover(
  deps: McpDeps,
  id: Hex,
  isKit: boolean,
): Promise<{ firstRecipient: Address | null | "unknown"; confirmedAt: bigint | null }> {
  if (!isKit || deps.app.verifier.indexState().stale) return HANDOVER_UNKNOWN;
  try {
    return await deps.handover(id);
  } catch {
    return HANDOVER_UNKNOWN;
  }
}

export interface PassportAnswer {
  found: true;
  passportId: Hex;
  creator: Address;
  holder: Address | null;
  holderRead: "chain" | "unavailable";
  holderIsCreator: boolean | null;
  agentId: string | null;
  kind: string;
  parentId: Hex | null;
  registeredAt: number;
  disputedFlag: boolean;
  dispute: DisputeAnswer;
  metadataURI: string;
  title: string | null;
  titleRead: "gateway" | "unavailable";
  platform: { status: "kit" | "outsideKit"; name: string; creatorWallet: Address; agentId: string } | null;
  platformList: "loaded" | "unavailable";
  credit: Credit | null;
  /** The trust mark the site shows, from the same function (mark.ts, held byte for byte with the site's). */
  mark: MarkAnswer;
  readAt: number;
}

export type Missing = { found: false; passportId: Hex };

/**
 * One passport, read from the chain first (getPassport), then its holder, its dispute through the
 * verify service's own reader and memory, and its metadata document's title through the configured
 * gateway. The platform label comes from platformLabel over the chain's own fields (P16), and the
 * credit for who imagined the picture from creditFor over the same fields, the holder and a listed
 * agent's owner read now, and, for a kit passport, the first handover and its confirmation read
 * from the index. Holder and creator are two fields and are never merged (P23).
 */
export async function passportFacts(deps: McpDeps, id: Hex): Promise<Outcome<PassportAnswer | Missing>> {
  let record: Awaited<ReturnType<McpChain["passport"]>>;
  try {
    record = await deps.chain.passport(id);
  } catch {
    return { ok: false, reason: CHAIN_UNAVAILABLE };
  }
  if (record === undefined) {
    return { ok: true, value: { found: false, passportId: id } };
  }
  const fields = {
    creator: record.creator,
    kind: record.kind,
    generatorAgentId: record.generatorAgentId,
    manifestHash: record.manifestHash,
    registeredAt: record.registeredAt,
  };
  const label = deps.platforms.ok ? platformLabel(fields, deps.platforms.platforms) : null;
  const markReaders = deps.mark ?? defaultMarkReaders();
  const [holder, dispute, document, agentOwnerNow, handover, markIndex] = await Promise.all([
    holderOf(deps, id),
    deps.app.verifier.dispute.answerFor(id),
    documentOf(deps, record.metadataURI),
    listedAgentOwner(deps, record.generatorAgentId),
    kitHandover(deps, id, label?.status === "kit"),
    markReaders.index(id),
  ]);
  const mark = markAnswer({
    dispute: disputeForMark(record.disputed, dispute),
    index: markIndex,
    picture: await pictureForMark(id, record.metadataURI, document, markReaders.unsealed),
  });
  const credit = deps.platforms.ok
    ? creditFor(
        {
          ...fields,
          holder,
          agentOwnerNow,
          firstRecipient: handover.firstRecipient,
          firstRecipientConfirmedAt: handover.confirmedAt,
        },
        deps.platforms.platforms,
      )
    : null;
  return {
    ok: true,
    value: {
      found: true,
      passportId: id,
      creator: record.creator,
      holder,
      holderRead: holder === null ? "unavailable" : "chain",
      holderIsCreator: holder === null ? null : holder === record.creator,
      agentId: record.generatorAgentId === 0n ? null : record.generatorAgentId.toString(),
      kind: kindWord(record.kind),
      parentId: record.parentId,
      registeredAt: Number(record.registeredAt),
      disputedFlag: record.disputed,
      dispute,
      metadataURI: cut(record.metadataURI, URI_MAX),
      title: document.read ? titleOf(document.document) : null,
      titleRead: document.read ? "gateway" : "unavailable",
      platform:
        label === null
          ? null
          : {
              status: label.status,
              name: label.name,
              creatorWallet: label.platform.creatorWallet,
              agentId: label.platform.agentId.toString(),
            },
      platformList: deps.platforms.ok ? "loaded" : "unavailable",
      credit,
      mark,
      readAt: nowSeconds(),
    },
  };
}

type UseWord = "unspecified" | "allowed" | "notAllowed" | "constrained";

interface FourUses {
  aiTraining: UseWord;
  aiGenerativeTraining: UseWord;
  aiInference: UseWord;
  dataMining: UseWord;
  constraintInfo: string | null;
}

export type GenerationTerms = ({ source: "metadata" } & FourUses) | { source: "none" } | { source: "unavailable" };

/**
 * What the metadata document said about AI use when the passport was made, checked by the same
 * rule the service writes it with. A document that says nothing is "none"; one that cannot be read
 * or does not pass the rule is "unavailable", never a guess.
 */
function termsAtGeneration(document: { read: true; document: unknown } | { read: false }): GenerationTerms {
  if (!document.read) {
    return { source: "unavailable" };
  }
  const training = (document.document as { training?: unknown } | null)?.training;
  if (training === undefined) {
    return { source: "none" };
  }
  if (typeof training !== "object" || training === null || (training as { standard?: unknown }).standard !== TRAINING_STANDARD) {
    return { source: "unavailable" };
  }
  const { standard: _standard, ...fields } = training as Record<string, unknown>;
  const parsed = trainingSchema.safeParse(fields);
  if (!parsed.success) {
    return { source: "unavailable" };
  }
  const stated = parsed.data ?? {};
  return {
    source: "metadata",
    aiTraining: stated.aiTraining ?? "unspecified",
    aiGenerativeTraining: stated.aiGenerativeTraining ?? "unspecified",
    aiInference: stated.aiInference ?? "unspecified",
    dataMining: stated.dataMining ?? "unspecified",
    constraintInfo: stated.constraintInfo ?? null,
  };
}

export interface TermsAnswer {
  found: true;
  passportId: Hex;
  askedAt: number | null;
  stated: boolean;
  standard: string | null;
  aiTraining: UseWord | null;
  aiGenerativeTraining: UseWord | null;
  aiInference: UseWord | null;
  dataMining: UseWord | null;
  constraintInfo: string | null;
  writer: Address | null;
  writtenAt: number | null;
  holder: Address | null;
  writerIsHolder: boolean | null;
  statedAtGeneration: GenerationTerms;
  sameAsGeneration: boolean | null;
  readAt: number;
}

/**
 * The AI-use statement in force for a passport, now or at `at`, from MoolamConsent on chain. The
 * chain statement is the one that stands; what the metadata said at generation is shown beside it
 * and a difference is reported, never resolved (P24). The writer of the statement in force is
 * named, and so is today's holder, as two facts (P23). "Not stated" is said only after the chain
 * answered (M3).
 */
export async function termsFacts(deps: McpDeps, id: Hex, at?: number): Promise<Outcome<TermsAnswer | Missing>> {
  let record: Awaited<ReturnType<McpChain["passport"]>>;
  try {
    record = await deps.chain.passport(id);
  } catch {
    return { ok: false, reason: CHAIN_UNAVAILABLE };
  }
  if (record === undefined) {
    return { ok: true, value: { found: false, passportId: id } };
  }
  let consent: ConsentAnswer;
  try {
    consent =
      at === undefined
        ? await deps.app.verifier.consent.answerFor(id)
        : answerFromChain(await deps.chain.consentAt(id, BigInt(at)), nowSeconds());
  } catch {
    consent = { source: "unavailable" };
  }
  if (consent.source === "unavailable") {
    return { ok: false, reason: TERMS_UNAVAILABLE };
  }
  const [holder, document] = await Promise.all([holderOf(deps, id), documentOf(deps, record.metadataURI)]);
  const generation = termsAtGeneration(document);
  const stated = consent.stated;
  const writer = stated ? getAddress(consent.writer) : null;
  const chainUses: FourUses | null = stated
    ? {
        aiTraining: consent.aiTraining,
        aiGenerativeTraining: consent.aiGenerativeTraining,
        aiInference: consent.aiInference,
        dataMining: consent.dataMining,
        constraintInfo: consent.constraintInfo ?? null,
      }
    : null;
  let sameAsGeneration: boolean | null = null;
  if (chainUses !== null && generation.source === "metadata") {
    sameAsGeneration =
      chainUses.aiTraining === generation.aiTraining &&
      chainUses.aiGenerativeTraining === generation.aiGenerativeTraining &&
      chainUses.aiInference === generation.aiInference &&
      chainUses.dataMining === generation.dataMining &&
      chainUses.constraintInfo === generation.constraintInfo;
  }
  return {
    ok: true,
    value: {
      found: true,
      passportId: id,
      askedAt: at ?? null,
      stated,
      standard: stated ? consent.standard : null,
      aiTraining: chainUses?.aiTraining ?? null,
      aiGenerativeTraining: chainUses?.aiGenerativeTraining ?? null,
      aiInference: chainUses?.aiInference ?? null,
      dataMining: chainUses?.dataMining ?? null,
      constraintInfo: chainUses?.constraintInfo ?? null,
      writer,
      writtenAt: stated ? consent.at : null,
      holder,
      writerIsHolder: writer === null || holder === null ? null : writer === holder,
      statedAtGeneration: generation,
      sameAsGeneration,
      readAt: consent.readAt,
    },
  };
}

export interface HistoryAnswer {
  found: true;
  passportId: Hex;
  lineage: { id: Hex; creator: Address; registeredAt: number; dispute: DisputeAnswer }[];
  lineageComplete: boolean;
  rechecks: RecheckAnswer;
  index: IndexState;
}

/**
 * A passport's lineage, itself first and then each picture it was edited from, at most
 * INHERITED_DISPUTE_MAX_DEPTH above it; its re-check results from the index; and the dispute on each
 * picture in the lineage through the verify service's own dispute reader and memory. The passport
 * is read on chain first, so "not found" rests on the chain's word; an index that is behind, or
 * that does not hold a passport the chain does, is "unavailable" (M3). `lineageComplete` is false
 * when the walk stopped at the cap, at a loop, or at a parent the index does not hold.
 */
export async function historyFacts(deps: McpDeps, id: Hex): Promise<Outcome<HistoryAnswer | Missing>> {
  let record: Awaited<ReturnType<McpChain["passport"]>>;
  try {
    record = await deps.chain.passport(id);
  } catch {
    return { ok: false, reason: CHAIN_UNAVAILABLE };
  }
  if (record === undefined) {
    return { ok: true, value: { found: false, passportId: id } };
  }
  const copy = deps.app.verifier.snapshot();
  const index = copy.state();
  if (index.stale) {
    return { ok: false, reason: INDEX_BEHIND };
  }
  const self = copy.lookupExact(id);
  if (self === undefined) {
    return { ok: false, reason: NOT_INDEXED_YET };
  }
  const walk = [self];
  const seen = new Set<string>([self.id.toLowerCase()]);
  let complete = true;
  let parentId = self.parentId;
  while (parentId !== null) {
    const key = parentId.toLowerCase();
    if (walk.length > INHERITED_DISPUTE_MAX_DEPTH || seen.has(key)) {
      complete = false;
      break;
    }
    const parent = copy.lookupExact(parentId);
    if (parent === undefined) {
      complete = false;
      break;
    }
    seen.add(key);
    walk.push(parent);
    parentId = parent.parentId;
  }
  const disputes = await Promise.all(walk.map(async (entry) => await deps.app.verifier.dispute.answerFor(entry.id)));
  return {
    ok: true,
    value: {
      found: true,
      passportId: id,
      lineage: walk.map((entry, position) => ({
        id: entry.id.toLowerCase() as Hex,
        creator: getAddress(entry.creator),
        registeredAt: entry.registeredAt,
        dispute: disputes[position] as DisputeAnswer,
      })),
      lineageComplete: complete,
      rechecks: recheckFor(self),
      index,
    },
  };
}

export interface AgentAnswer {
  found: true;
  agentId: string;
  owner: Address;
  wallet: Address | null;
  walletRead: "chain" | "unset" | "unavailable";
  cardAddressKind: "data" | "ipfs" | "https" | "other" | "none";
  card: CardAnswer;
  listedPlatform: { name: string; creatorWallet: Address; ownerUnchanged: boolean } | null;
  readAt: number;
}

export type MissingAgent = { found: false; agentId: string };

function addressKind(uri: string): AgentAnswer["cardAddressKind"] {
  if (uri.length === 0) return "none";
  if (uri.startsWith("data:")) return "data";
  if (uri.startsWith("ipfs://")) return "ipfs";
  if (uri.startsWith("https://")) return "https";
  return "other";
}

/**
 * An ERC-8004 agent: its owner and wallet from the identity registry, and its card only through
 * the card reader's rules. The Moolam-listed platform name, when the agent is listed, is a separate
 * fact from the card's self-declared name (P14, P16), with whether today's owner is still the one
 * that signed at onboarding.
 */
export async function agentFacts(deps: McpDeps, agentId: number): Promise<Outcome<AgentAnswer | MissingAgent>> {
  const id = BigInt(agentId);
  let agent: Awaited<ReturnType<McpChain["agent"]>>;
  try {
    agent = await deps.chain.agent(id);
  } catch {
    return { ok: false, reason: AGENT_UNAVAILABLE };
  }
  if (agent === undefined) {
    return { ok: true, value: { found: false, agentId: id.toString() } };
  }
  const card = await deps.readCard(agent.uri);
  const listing = deps.platforms.ok
    ? deps.platforms.platforms.find((platform) => platform.agentId === id && platform.validTo === null)
    : undefined;
  return {
    ok: true,
    value: {
      found: true,
      agentId: id.toString(),
      owner: agent.owner,
      wallet: agent.wallet === null || isZeroAddress(agent.wallet) ? null : agent.wallet,
      walletRead: agent.wallet === null ? "unavailable" : isZeroAddress(agent.wallet) ? "unset" : "chain",
      cardAddressKind: addressKind(agent.uri),
      card,
      listedPlatform:
        listing === undefined
          ? null
          : {
              name: listing.name,
              creatorWallet: listing.creatorWallet,
              ownerUnchanged: listing.ownerAtOnboarding === agent.owner,
            },
      readAt: nowSeconds(),
    },
  };
}

export interface RecentAnswer {
  passports: { id: Hex; creator: Address; parentId: Hex | null; registeredAt: number; metadataURI: string }[];
  index: IndexState;
}

/**
 * The newest passports from the index, newest first. An index the verify service reads as behind,
 * or one that does not answer, is "unavailable" and never an empty list (M3).
 */
export async function recentFacts(deps: McpDeps, limit: number): Promise<Outcome<RecentAnswer>> {
  const index = deps.app.verifier.indexState();
  if (index.stale) {
    return { ok: false, reason: INDEX_BEHIND };
  }
  let rows: Awaited<ReturnType<RecentReader>>;
  try {
    rows = await deps.recent();
  } catch {
    return { ok: false, reason: INDEX_UNAVAILABLE };
  }
  return {
    ok: true,
    value: {
      passports: rows.slice(0, limit).map((row) => ({
        id: row.id,
        creator: getAddress(row.creator),
        parentId: row.parentId,
        registeredAt: row.registeredAt,
        metadataURI: cut(row.metadataURI, URI_MAX),
      })),
      index,
    },
  };
}
