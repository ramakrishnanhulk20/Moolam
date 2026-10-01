import { unstable_cache } from "next/cache";
import type { Hex } from "viem";
import { isTestCard } from "@/components/explore/sort";
import {
  CACHE_TAGS,
  DEMO_AGENT_ID,
  HOLD_SECONDS,
  METADATA_HOLD_SECONDS,
  gatewayUrl,
  reason,
} from "@/lib/chain/client";
import type { Consent, Statement } from "@/lib/chain/consent";
import { heldConsent, plainStatement } from "@/lib/chain/consent";
import { isChainlinkReceiver } from "@/lib/chain/receivers";
import { getAttestations, getPassport } from "@/lib/chain/registry";
import { heldReportDelivery } from "@/lib/chain/reports";
import { heldNetworkCheckCount, markSchema } from "@/lib/data/marks";
import { generatorRecord, latestPassports } from "@/lib/data/passports";
import type { PickedPlate } from "@/lib/data/samples";
import { SHOWCASE } from "@/lib/data/showcase";
import { UNKNOWN_HANDOVER, creditFrom, heldPlatformList, listedAgentOwner } from "@/lib/data/platform-label";
import { activeSource, envioUrl } from "@/lib/data/source";
import type { PlatformList } from "@/lib/platforms/platforms";
import { statementsOf } from "@/components/passport/art";
import { heldIndexedVerdictRows, transactionFor } from "@/components/passport/indexed";
import degrade from "@/public/hero/degrade.json";

const METADATA_TIMEOUT_MS = 8_000;
const INDEX_TIMEOUT_MS = 10_000;

/**
 * How many recent passports the field is read from.
 *
 * The field draws the real pictures among them and nothing else, so a run of
 * seed writes at the top of the index costs the first screen plates rather than
 * filling it with test cards.
 */
const FIELD_DEPTH = 24;

/** One drifting plate: a real registered image and the record it belongs to. */
export interface StoryPlate {
  id: Hex;
  picture: string;
  agentId: string | null;
  registeredAt: number;
}

/** The passport the camera flies to, and every figure the captions quote about it. */
export interface StoryFocal {
  id: Hex;
  picture: string;
  creator: Hex;
  /** Null when no agent generated this one, and then the made beat says exactly that. */
  agentId: string | null;
  registeredAt: number;
  block: string;
  kind: number;
  /** True when the record carries a C2PA manifest hash rather than a zero word. */
  manifest: boolean;
  attestations: number;
  /** Which rung of the chooser this record came in on, so a caption can stay true. */
  why: FocalReason;
  /** True when this is the passport the verifier measured the degrade ladder on. */
  measured: boolean;
  /** The name pinned with the picture, or null when the document gave none. */
  title?: string | null;
  /** True when this is the head chef's pinned picture rather than the chooser's. */
  pinned?: boolean;
  /** Who the imagined beat credits, by the site's one credit rule. */
  credit?: StoryCredit;
  /** True when the document carries the sworn line Moolam pins, word for word. */
  sworn?: boolean;
}

/**
 * Who the imagined beat credits, by the story-v2 script's cases.
 *
 * "studio" is a picture an agent drew in Moolam's own studio; "cosigned" one a
 * listed platform's agent drew and the person signed with their own key, which
 * the credit rule names them for; "platform" one a listed platform's agent drew
 * where no person is named yet, so the beat names nobody; "photo" a picture no
 * agent touched.
 */
export type StoryCredit =
  | { case: "studio" }
  | { case: "cosigned"; platform: string }
  | { case: "platform"; platform: string }
  | { case: "photo" };

/**
 * The checked beat's verdict, and which form the beat may honestly play.
 *
 * "network" is a verdict Chainlink's network delivered, the only one that turns
 * the mark on. "test" is one the forwarder on one machine delivered: the
 * simulator. "plain" is a verdict whose delivery could not be told, and the
 * beat then says what it did without saying how it ran.
 */
export interface StoryCheck {
  form: "network" | "test" | "plain";
  matched: boolean;
  distance: number;
  at: number;
}

/** One print of the look-alike beat: a real passport the index's record names. */
export interface StoryLookalikePrint {
  id: Hex;
  picture: string;
  title: string | null;
  registeredAt: number;
}

/** The newest look-alike record Chainlink's network wrote, with both pictures. */
export interface StoryLookalike {
  earlier: StoryLookalikePrint;
  later: StoryLookalikePrint;
  bits: number;
  at: number;
}

/** The sign-it-yourself beat's figures and its print: the one picked co-signed picture. */
export interface StoryYourself {
  platform: string;
  /** Passports drawn by the listed platforms' agents, from the index's generator rows. */
  count: number;
  platforms: number;
  /** The picked passport the beat is told on (YOURSELF_PICK). */
  print: { id: Hex; picture: string; title: string; creator: Hex };
}

/** An independent re-check written back on chain, always this passport's own. */
export interface StoryAttestation {
  passportId: Hex;
  matched: boolean;
  distance: number;
  receiver: Hex;
  at: number;
}

/**
 * What the holder of the story's own passport has said about AI use of the
 * picture, as the register answered it.
 *
 * Nothing here is worked out by the story: the four uses and the moment come
 * off MoolamConsent, and the summary is the same function the passport page and
 * the verify answer reduce a statement with, so a beat cannot say one thing
 * while the card a judge opens next says another.
 */
export interface StoryStatement {
  /** One of the five plain summaries: open, closed, ask, mixed, none. */
  summary: Statement;
  consent: Consent;
  /** When it was written, in whole seconds. */
  at: number;
  writer: Hex;
  /** The holder's own conditions, empty unless a use is constrained. */
  constraintInfo: string;
}

export interface StoryAgent {
  id: string;
  /** Re-checks that matched, counted by the index. */
  rechecks: number;
  /**
   * The index's trust score out of 100, the same number the Agents page and the
   * agent's own page rank on. Null only when the index has no row for the agent.
   */
  score: number | null;
  passports: number | null;
}

export interface StoryData {
  source: "envio" | "chain";
  plates: StoryPlate[];
  focal: StoryFocal | null;
  attestation: StoryAttestation | null;
  agent: StoryAgent | null;
  /** The statement in force on the focal passport, or null when nobody has written one. */
  statement: StoryStatement | null;
  /** The register's own words when it could not be read at all, which is not the same as silence. */
  statementError: string | null;
  passportCount: number | null;
  /**
   * Chainlink's network checks on Monad, the one count every surface quotes
   * (lib/data/marks). Null when the index does not serve it, and the close
   * then draws no number rather than a wrong one.
   */
  attestationCount: number | null;
  /** The provider's own words when nothing could be read, shown rather than swallowed. */
  error: string | null;
  /** The focal passport's newest Chainlink verdict and the form the checked beat plays it in. */
  check?: StoryCheck | null;
  /** Null until the index holds a network look-alike record with two pictures. */
  lookalike?: StoryLookalike | null;
  /** Null until a listed platform has a co-signed picture in the field's read. */
  yourself?: StoryYourself | null;
  /**
   * The showcase picks as this read found them, the picture and the title each
   * document carries, null where unread, so the film's own panel offers the
   * same three the first screen does, by the one rule (lib/data/samples).
   */
  picked?: PickedPlate[];
}

/** One picture the film may be told on, by its passport and the title its document carries. */
export interface FocalPick {
  id: Hex;
  title: string;
}

/**
 * The pictures the film is told on, in order: the head chef's pick (DECISIONS,
 * 1 October) and then two more original studio pictures, each with a Chainlink
 * verdict, nothing a home page should not show and never a famous character.
 * Each is fetched by id in the film's own index query, so it is there however
 * many passports have come since, and has to carry the title it was picked
 * under and pass every rule the chooser holds the automatic pick to. Only when
 * none of them can be read or passes does the chooser pick as it always has.
 */
export const FOCAL_PICKS: readonly FocalPick[] = [
  { id: "0xcdb25d3755452efa3b746f168cf9cefd3a1b693ab2b81d260a2d64f13d771638", title: "Monsoon Fishing Nets Drying" },
  { id: "0x0c45b008db6a6b74b203e63e7659fc86c60c2598d762e0280c4ae12fc57e0e2e", title: "Marina Beach Kite Sellers at Dusk" },
  { id: "0x5b3856dc4765c629e82f65ff920f13543f7c1ef818b52252d55b488387fe65b1", title: "Black Basalt Lighthouse at Night" },
];

/**
 * The sign-it-yourself beat's one print: Ram's own picture, drawn on Dreamloom
 * and co-signed by him (DECISIONS, 1 October). The beat is told on this
 * passport or not at all: when it cannot be read or fails the beat's rule, the
 * beat is left out rather than drawn on whatever else is newest.
 */
export const YOURSELF_PICK: Hex = "0xc7f3f3f00252519e5bef4f59c48285e2bbefe4c6ecf8625b9d8f6bc9e23256c4";

/** Every passport the story query fetches by id, beside the newest rows. */
const PICKED_IDS = [...FOCAL_PICKS.map((pick) => pick.id), YOURSELF_PICK].map((id) => id.toLowerCase());

/** The counts the index keeps for one generating agent, as the story query asks for them. */
export interface IndexGenerator {
  passportCount: number;
  matchedCount: number;
  /** 0 to 100, the index's own trust score, the number every page shows. */
  trustScore: number;
}

export interface IndexRow {
  id: Hex;
  metadataURI: string;
  registeredAt: string;
  registeredBlock: string;
  generatorId: string | null;
  creator: Hex;
  kind: number;
  manifestHash: Hex;
  /** How many independent re-checks this passport already carries. */
  attestations: number;
}

const STORY_QUERY = `query Story($limit: Int!, $picked: [String!]!) {
  picked: Passport(where: { id: { _in: $picked } }) {
    id
    metadataURI
    registeredAt
    registeredBlock
    generator_id
    creator_id
    kind
    manifestHash
    attestationCount
  }
  Passport(order_by: { registeredAt: desc }, limit: $limit) {
    id
    metadataURI
    registeredAt
    registeredBlock
    generator_id
    creator_id
    kind
    manifestHash
    attestationCount
  }
  GlobalStats {
    passports
    attestations
  }
  Generator {
    id
    passportCount
    matchedCount
    trustScore
  }
}`;

/**
 * Everything the landing story shows, read live.
 *
 * One trip to the index for the newest passports and the two counts, then the
 * metadata documents those passports point at, then this passport's own
 * re-checks. The generator's standing comes from the same index row.
 *
 * This is the whole read, every time. `heldStory` is what the page calls: the
 * same work, held for a minute.
 */
export async function storyData(): Promise<StoryData> {
  const source = activeSource();

  let rows: IndexRow[] = [];
  let picked: IndexRow[] = [];
  let attestation: StoryAttestation | null = null;
  let passportCount: number | null = null;
  let generators: Record<string, IndexGenerator> = {};
  let error: string | null = null;

  try {
    if (source === "envio") {
      const answer = await heldIndex();
      rows = answer.rows;
      picked = answer.picked ?? [];
      passportCount = answer.passports;
      generators = answer.generators;
    } else {
      rows = await heldChain();
    }
  } catch (caught) {
    error = reason(caught);
  }

  // The rows the picks are found among: the field's own, and each picked
  // passport's row when it has fallen out of the newest few. They never join the field.
  const seen = new Set(rows.map((row) => row.id.toLowerCase()));
  const candidates = [...rows, ...picked.filter((row) => !seen.has(row.id.toLowerCase()))];
  const pictures = await Promise.all(candidates.map((row) => heldPicture(row.metadataURI)));

  // The first screen is the one shot nobody scrolls past, and a card reading
  // "Moolam seed 4" on it says the registry is a test rig. The sieve is the
  // title in the pinned metadata, the same one Explore and the build's page
  // list read, so the field and the grid can never disagree about what a
  // picture is. Nothing takes a dropped plate's place: a short field is a
  // shorter field.
  const plates: StoryPlate[] = rows
    .map((row, index) => ({ row, picture: pictures[index] }))
    .filter(
      (entry): entry is { row: IndexRow; picture: Picture } =>
        entry.picture !== null && !isTestCard(entry.picture.title, entry.row.id),
    )
    .map(({ row, picture }) => ({
      id: row.id,
      picture: picture.thumbnail,
      agentId: row.generatorId,
      registeredAt: Number(row.registeredAt),
    }));

  // The showcase picks are among the rows this read already fetched by id, so
  // the film's panel can offer them by title without a read of its own.
  const showcase: PickedPlate[] = SHOWCASE.map((pick) => {
    const at = candidates.findIndex((row) => row.id.toLowerCase() === pick.id.toLowerCase());
    const picture = at === -1 ? null : pictures[at];
    return { id: pick.id, picture: picture?.thumbnail ?? null, title: picture?.title ?? null };
  });

  const hasPicture = pictures.map((picture) => picture !== null);
  const titles = pictures.map((picture) => picture?.title ?? null);
  const pinnedAt = pinnedFocal(candidates, hasPicture, titles, FOCAL_PICKS);
  // The automatic choice reads the field's own rows, exactly as it always has.
  const chosen =
    pinnedAt !== null
      ? { index: pinnedAt, reason: "full" as const }
      : chooseFocal(rows, hasPicture.slice(0, rows.length), titles.slice(0, rows.length));
  const chosenPicture = chosen === null ? null : pictures[chosen.index];
  const list = await heldPlatformList();
  const focal: StoryFocal | null =
    chosen === null || chosenPicture === null || chosenPicture === undefined
      ? null
      : {
          ...focalFrom(candidates[chosen.index], chosenPicture.full, chosen.reason),
          title: chosenPicture.title,
          pinned: pinnedAt !== null,
          sworn: chosenPicture.sworn,
          credit: await creditOf(candidates[chosen.index], list),
        };

  if (process.env.NODE_ENV === "development" && chosen !== null) {
    // Which record the story opened on, so a wrong one is caught on the dev
    // server rather than in a judge's screenshot.
    console.info(
      `story focal: ${candidates[chosen.index].id} "${titles[chosen.index] ?? "untitled"}" ${pinnedAt !== null ? "pinned" : `on the ${chosen.reason} rung`}, ${candidates[chosen.index].attestations} checks`,
    );
  }

  // Only this passport's own check is ever shown. A newer one on a different
  // record is a true sentence about a record nobody is looking at, which is how
  // the story came to quote three passports at once.
  if (focal !== null) {
    attestation = await heldAttestation(focal.id);
  }

  // The agent's score is about the generator that made this picture, so a
  // generator the index has no row for shows as no score rather than borrowing
  // another agent's standing.
  const agentId = focal === null ? DEMO_AGENT_ID : focal.agentId === null ? null : BigInt(focal.agentId);
  const [agent, statementRead, check, lookalike, yourself, attestationCount] = await Promise.all([
    agentId === null ? null : agentStanding(agentId, generators[agentId.toString()]),
    focal === null ? NO_STATEMENT : focalStatement(focal.id),
    attestation === null ? null : focalCheck(attestation),
    newestLookalike(),
    yourselfFrom(candidates, pictures, list, generators),
    // The close quotes Chainlink's network checks, not every attestation ever
    // written: the shared count, so it says what the mark on every passport says.
    source === "envio" ? heldNetworkCheckCount() : null,
  ]);

  return {
    source,
    plates,
    focal,
    attestation,
    agent,
    statement: statementRead.statement,
    statementError: statementRead.statementError,
    passportCount,
    attestationCount,
    error,
    check,
    lookalike,
    yourself,
    picked: showcase,
  };
}

/**
 * The first pick, in order, that is among the rows and passes, or null. A pick
 * is its passport id carrying the title it was picked under, and it has to
 * clear every rule the chooser's top rung holds a picture to: a real picture a
 * reader can look at, an agent drew it, Content Credentials travelled with it,
 * and a Chainlink verdict was written on it. Pure, and tested in
 * test/story-rollin.test.ts.
 */
export function pinnedFocal(
  rows: readonly IndexRow[],
  hasPicture: readonly boolean[],
  titles: readonly (string | null)[],
  picks: readonly FocalPick[],
): number | null {
  for (const pick of picks) {
    const at = rows.findIndex(
      (row, index) =>
        row.id.toLowerCase() === pick.id.toLowerCase() &&
        titles[index] === pick.title &&
        hasPicture[index] === true &&
        fits(row, "full") &&
        !isTestCard(titles[index] ?? null, row.id),
    );
    if (at !== -1) {
      return at;
    }
  }
  return null;
}

/**
 * Who the imagined beat credits, by the site's one credit rule.
 *
 * Only an agent a listed platform owns can make a picture anything other than
 * the studio's, so only then is the agent's owner read, which is what the
 * co-signed credit stands on. No holder and no handover are read: those only
 * name a person in the kit cases, and the kit cases are worded for push day,
 * so the film names nobody there.
 */
export async function creditOf(row: IndexRow, list: PlatformList): Promise<StoryCredit> {
  if (row.kind !== 0 || row.generatorId === null) {
    return { case: "photo" };
  }
  const agentId = BigInt(row.generatorId);
  const entry = list.ok ? list.platforms.find((one) => one.agentId === agentId) : undefined;
  if (entry === undefined) {
    return { case: "studio" };
  }
  const agentOwnerNow = await listedAgentOwner(list, agentId);
  const credit = creditFrom(list, {
    creator: row.creator,
    kind: row.kind,
    generatorAgentId: agentId,
    manifestHash: row.manifestHash,
    registeredAt: BigInt(row.registeredAt),
    holder: null,
    agentOwnerNow,
    ...UNKNOWN_HANDOVER,
  });
  return credit?.case === "cosigned"
    ? { case: "cosigned", platform: credit.platform }
    : { case: "platform", platform: entry.name };
}

/**
 * Which form the checked beat may play this verdict in.
 *
 * The index's own network flag decides where it serves one; otherwise the
 * forwarder that carried the report does, as the passport page's mark reads
 * it. A verdict whose delivery could not be told plays in the plain form, which
 * says what was done and claims neither.
 */
async function focalCheck(attestation: StoryAttestation): Promise<StoryCheck> {
  const base = { matched: attestation.matched, distance: attestation.distance, at: attestation.at };
  const rows = await heldIndexedVerdictRows(attestation.passportId).catch(() => null);
  if (rows === null) {
    return { ...base, form: "plain" };
  }
  const written = { receiver: attestation.receiver, at: BigInt(attestation.at), distance: attestation.distance };
  const row = rows.find(
    (one) =>
      one.receiver.toLowerCase() === written.receiver.toLowerCase() &&
      one.at === written.at &&
      one.distance === written.distance,
  );
  if (row?.network === true) {
    return { ...base, form: "network" };
  }
  const txHash = transactionFor(rows, written);
  if (txHash === undefined) {
    return { ...base, form: "plain" };
  }
  const delivery = await heldReportDelivery(txHash).catch(() => "unknown" as const);
  return { ...base, form: delivery === "network" ? "network" : delivery === "simulation" ? "test" : "plain" };
}

const ZERO_ID = /^0x0{64}$/;

const LOOKALIKE_QUERY = `query StoryLookalike {
  Lookalike(where: { network: { _eq: true }, valid: { _eq: true } }, order_by: [{ executedAt: desc }], limit: 4) {
    earlierId
    phashDistance
    executedAt
    passport { id registeredAt metadataURI }
    earlier { id registeredAt metadataURI }
  }
}`;

interface LookalikeLine {
  id: Hex;
  registeredAt: string | number;
  metadataURI: string;
}

interface LookalikeRow {
  earlierId: string;
  phashDistance: number;
  executedAt: string | number;
  passport: LookalikeLine | null;
  earlier: LookalikeLine | null;
}

/** The newest few network records, held for a minute. Asked only of an index that serves them. */
const heldLookalikeRows = unstable_cache(
  async (): Promise<LookalikeRow[]> => {
    const response = await fetch(envioUrl(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: LOOKALIKE_QUERY }),
      signal: AbortSignal.timeout(INDEX_TIMEOUT_MS),
      cache: "no-store",
    });
    if (!response.ok) {
      throw new Error(`the Envio endpoint answered ${response.status}`);
    }
    const body = (await response.json()) as { errors?: unknown[]; data?: { Lookalike?: LookalikeRow[] } };
    if (body.errors !== undefined || body.data?.Lookalike === undefined) {
      throw new Error("the index did not answer the look-alike query");
    }
    return body.data.Lookalike;
  },
  ["moolam-story-lookalike"],
  { revalidate: HOLD_SECONDS, tags: [CACHE_TAGS.index] },
);

/**
 * The newest look-alike record Chainlink's network wrote and the index found
 * valid, with both passports' pictures, or null.
 *
 * Until the push-day index serves the rows there is nothing to ask, and the
 * beat is left out; a record whose either picture cannot be shown is passed
 * over, because the beat is two prints side by side.
 */
async function newestLookalike(): Promise<StoryLookalike | null> {
  if (activeSource() !== "envio" || !(await markSchema()).lookalikes) {
    return null;
  }
  let records: LookalikeRow[];
  try {
    records = await heldLookalikeRows();
  } catch {
    return null;
  }
  for (const record of records) {
    if (ZERO_ID.test(record.earlierId) || record.passport === null || record.earlier === null) {
      continue;
    }
    const [later, earlier] = await Promise.all([
      heldPicture(record.passport.metadataURI),
      heldPicture(record.earlier.metadataURI),
    ]);
    if (later === null || earlier === null) {
      continue;
    }
    return {
      later: {
        id: record.passport.id,
        picture: later.thumbnail,
        title: later.title,
        registeredAt: Number(record.passport.registeredAt),
      },
      earlier: {
        id: record.earlier.id,
        picture: earlier.thumbnail,
        title: earlier.title,
        registeredAt: Number(record.earlier.registeredAt),
      },
      bits: record.phashDistance,
      at: Number(record.executedAt),
    };
  }
  return null;
}

/**
 * The sign-it-yourself beat, from what the film has already read.
 *
 * The figures are the index's own generator counts for the listed platforms'
 * agents, and the print is the one picked passport, YOURSELF_PICK. It has to be
 * a real picture with a title, drawn by a listed platform's agent, and one the
 * credit rule calls co-signed: signed by the person. Otherwise the beat is left
 * out; it is never drawn on another picture.
 */
async function yourselfFrom(
  rows: readonly IndexRow[],
  pictures: readonly (Picture | null)[],
  list: PlatformList,
  generators: Record<string, IndexGenerator>,
): Promise<StoryYourself | null> {
  if (!list.ok) {
    return null;
  }
  const current = list.platforms.filter((entry) => entry.validTo === null);
  const counted = current
    .map((entry) => ({ entry, count: generators[entry.agentId.toString()]?.passportCount ?? 0 }))
    .filter((one) => one.count > 0);
  if (counted.length === 0) {
    return null;
  }

  const at = rows.findIndex((row) => row.id.toLowerCase() === YOURSELF_PICK.toLowerCase());
  const row = rows[at];
  const picture = at === -1 ? null : (pictures[at] ?? null);
  if (row === undefined || picture === null || picture.title === null || isTestCard(picture.title, row.id)) {
    return null;
  }
  if (row.kind !== 0 || !current.some((one) => one.agentId.toString() === row.generatorId)) {
    return null;
  }
  const credit = await creditOf(row, list);
  if (credit.case !== "cosigned") {
    return null;
  }
  return {
    platform: credit.platform,
    count: counted.reduce((sum, one) => sum + one.count, 0),
    platforms: counted.length,
    print: { id: row.id, picture: picture.full, title: picture.title, creator: row.creator },
  };
}

const NO_STATEMENT = { statement: null, statementError: null };

/**
 * The statement in force on the story's own passport, through the same hold the
 * passport page reads it with.
 *
 * Silence and a register that would not answer are kept apart on purpose. A
 * holder who has said nothing is a true answer the story is allowed to act on;
 * a read that failed is this minute's bad luck, and a beat built on it would be
 * a sentence nobody put on chain.
 */
async function focalStatement(id: Hex): Promise<{ statement: StoryStatement | null; statementError: string | null }> {
  try {
    const reading = await heldConsent(id);
    if (!reading.stated || reading.entry === null) {
      return NO_STATEMENT;
    }
    const { consent, writer, constraintInfo } = reading.entry;
    return {
      statement: {
        summary: plainStatement(consent),
        consent,
        at: Number(reading.entry.at),
        writer,
        constraintInfo,
      },
      statementError: null,
    };
  } catch (caught) {
    return { statement: null, statementError: reason(caught) };
  }
}

/** The last read that came back whole, so a bad minute upstream costs nobody the story. */
let lastGood: StoryData | null = null;

/**
 * The story the home page draws.
 *
 * Every upstream read inside it is held on its own rather than the finished
 * story being held as one lump: Next runs a held read nested inside another one
 * for real every time, so a story held whole would pay all twenty six calls on
 * every miss. Held one by one, the miss on the index query costs the index
 * query and nothing else.
 *
 * A read that came back empty or with the provider's error on it hands back the
 * last whole one instead. The registry did not lose eight passports because an
 * endpoint had a bad second, and a visitor should not be shown that it did.
 */
export async function heldStory(): Promise<StoryData> {
  const data = await storyData();

  if (data.error === null && data.plates.length > 0) {
    lastGood = data;
    return data;
  }

  return lastGood ?? data;
}

/**
 * The one index query behind the whole story, held for a minute.
 *
 * Everything it carries is already a string or a number: the two block figures
 * arrive as text from GraphQL and stay that way until a caption reads them,
 * which is what lets the answer be stored at all.
 */
const heldIndex = unstable_cache(async () => await fromIndex(), ["moolam-story-index-picks"], {
  revalidate: HOLD_SECONDS,
  tags: [CACHE_TAGS.index],
});

interface IndexAnswer {
  rows: IndexRow[];
  /** The picked passports' own rows, read in the same query; any the index has none of are missing. */
  picked: IndexRow[];
  passports: number | null;
  attestations: number | null;
  generators: Record<string, IndexGenerator>;
}

async function fromIndex(): Promise<IndexAnswer> {
  const response = await fetch(envioUrl(), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      query: STORY_QUERY,
      variables: { limit: FIELD_DEPTH, picked: PICKED_IDS },
    }),
    signal: AbortSignal.timeout(INDEX_TIMEOUT_MS),
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`the Envio endpoint answered ${response.status}`);
  }

  const body = (await response.json()) as {
    errors?: { message: string }[];
    data?: {
      Passport: IndexPassport[];
      picked?: IndexPassport[];
      GlobalStats: { passports: number; attestations: number }[];
      Generator: ({ id: string } & IndexGenerator)[];
    };
  };

  if (body.errors !== undefined && body.errors.length > 0) {
    throw new Error(body.errors.map((entry) => entry.message).join("; "));
  }
  if (body.data === undefined) {
    throw new Error("the Envio endpoint returned no data block");
  }

  const stats = body.data.GlobalStats[0];

  return {
    rows: body.data.Passport.map(toRow),
    picked: (body.data.picked ?? []).map(toRow),
    passports: stats?.passports ?? null,
    attestations: stats?.attestations ?? null,
    generators: Object.fromEntries(
      body.data.Generator.map(({ id, passportCount, matchedCount, trustScore }) => [
        id,
        { passportCount, matchedCount, trustScore },
      ]),
    ),
  };
}

/** One passport as the story query asks for it. */
interface IndexPassport {
  id: Hex;
  metadataURI: string;
  registeredAt: string;
  registeredBlock: string;
  generator_id: string | null;
  creator_id: Hex;
  kind: number;
  manifestHash: Hex;
  attestationCount: number;
}

function toRow(row: IndexPassport): IndexRow {
  return {
    id: row.id,
    metadataURI: row.metadataURI,
    registeredAt: row.registeredAt,
    registeredBlock: row.registeredBlock,
    generatorId: row.generator_id,
    creator: row.creator_id,
    kind: row.kind,
    manifestHash: row.manifestHash,
    attestations: row.attestationCount,
  };
}

/**
 * The same rows straight from the registry's own events, for a day with no index.
 *
 * The chooser needs the kind, the manifest hash and the number of re-checks on
 * every row, so this path reads the record and its attestation list for each of
 * the eight, which the index would have answered in one trip.
 */
/** The same rows on a day with no index, held for the same minute. */
const heldChain = unstable_cache(async () => await fromChain(), ["moolam-story-chain"], {
  revalidate: HOLD_SECONDS,
  tags: [CACHE_TAGS.chain],
});

async function fromChain(): Promise<IndexRow[]> {
  const rows = (await latestPassports(8)).passports;
  const records = await Promise.all(rows.map((row) => getPassport(row.id).catch(() => null)));
  const written = await Promise.all(rows.map((row) => getAttestations(row.id).catch(() => [])));

  return rows.flatMap((row, index) => {
    const record = records[index];
    if (record === null) {
      return [];
    }
    return [
      {
        id: row.id,
        metadataURI: record.metadataURI,
        registeredAt: row.registeredAt.toString(),
        registeredBlock: row.blockNumber.toString(),
        generatorId: row.agentId === 0n ? null : row.agentId.toString(),
        creator: row.creator,
        kind: record.kind,
        manifestHash: record.manifestHash,
        attestations: written[index].length,
      },
    ];
  });
}

/**
 * Which rung of the chooser the story's passport came in on.
 *
 * `full` is the story as written: an agent made it, a C2PA manifest travelled
 * with it, and somebody re-checked it independently. `manifest` drops the
 * re-check, and the verified caption then says so instead of quoting figures
 * that belong to another record. `any` drops the agent too, and the made beat
 * is rewritten by the record rather than kept and contradicted.
 */
export type FocalReason = "full" | "manifest" | "any";

const ZERO_WORD = /^0x0*$/;

/** A manifest hash of nothing but zeroes means no C2PA manifest was sealed in. */
export function carriesManifest(hash: string): boolean {
  return !ZERO_WORD.test(hash);
}

function fits(row: IndexRow, reason: FocalReason): boolean {
  if (reason === "any") {
    return true;
  }
  if (row.kind !== 0 || row.generatorId === null || !carriesManifest(row.manifestHash)) {
    return false;
  }
  return reason === "manifest" || row.attestations > 0;
}

/**
 * The rungs the chooser walks down, best first.
 *
 * Every rung is walked twice: once for pictures a reader can look at, then once
 * with the seed test cards let back in. Only the second pass of a rung can hand
 * the story a card that says "Moolam seed 4" across it, and by then no real
 * picture on that rung exists to show instead.
 */
const LADDER: { reason: FocalReason; realOnly: boolean }[] = [
  { reason: "full", realOnly: true },
  { reason: "full", realOnly: false },
  { reason: "manifest", realOnly: true },
  { reason: "manifest", realOnly: false },
  { reason: "any", realOnly: true },
  { reason: "any", realOnly: false },
];

/**
 * The one passport the whole story is told on.
 *
 * The captions name an agent, a manifest and a re-check, so the record they are
 * told over has to carry all three or the story contradicts the page a judge
 * opens next. On top of that the picture should be one a reader can look at:
 * the top rung takes the newest real picture with all three, using the same
 * test-card rule the Explore page sorts and filters on, so the story and the
 * grid never disagree about what counts as a picture. Below that comes the
 * newest record with all three whatever its title, then the newest an agent
 * made and sealed with the re-check line told truthfully as missing, then the
 * newest picture of any kind with the agent line gone. Those two lower rungs
 * ask for a real picture first as well, so a week of seed writes at the top of
 * the index cannot put a test card on the home page while a real one is still
 * in reach. A record with no picture is never chosen: the forgery attempts the
 * prove-it run writes are exactly that, and a story about an image cannot be
 * told on one.
 *
 * `titles` are the names pinned with those pictures, in the same order as the
 * rows. A caller with no titles to hand simply lands on the rung below each
 * real-picture pass, which is the order this chose before titles existed.
 *
 * Pure, and tested in test/story-focal.test.ts against a fixture index.
 */
export function chooseFocal(
  rows: readonly IndexRow[],
  hasPicture: readonly boolean[],
  titles: readonly (string | null)[] = [],
): { index: number; reason: FocalReason } | null {
  for (const rung of LADDER) {
    let best = -1;
    for (let index = 0; index < rows.length; index += 1) {
      if (hasPicture[index] !== true || !fits(rows[index], rung.reason)) {
        continue;
      }
      if (rung.realOnly && isTestCard(titles[index] ?? null, rows[index].id)) {
        continue;
      }
      if (best === -1 || Number(rows[index].registeredAt) > Number(rows[best].registeredAt)) {
        best = index;
      }
    }
    if (best !== -1) {
      return { index: best, reason: rung.reason };
    }
  }

  return null;
}

/**
 * One index row becomes the record every caption reads from.
 *
 * Nothing in the story may reach past this function for a figure: the agent id,
 * the block, the date and the id itself all leave the same row, which is what
 * keeps the captions and the passport page a judge opens next in agreement.
 */
export function focalFrom(row: IndexRow, picture: string, reason: FocalReason): StoryFocal {
  return {
    id: row.id,
    picture,
    creator: row.creator,
    agentId: row.kind === 0 ? row.generatorId : null,
    registeredAt: Number(row.registeredAt),
    block: row.registeredBlock,
    kind: row.kind,
    manifest: carriesManifest(row.manifestHash),
    attestations: row.attestations,
    why: reason,
    measured: row.id.toLowerCase() === degrade.passportId.toLowerCase(),
  };
}

/**
 * This passport's own re-check, held for a minute. Two chain reads, and a new
 * one lands minutes apart at best, so a minute costs the story nothing. The
 * story calls it a Chainlink CRE workflow's, so a row from a writer the app
 * cannot name is passed over rather than given that name.
 */
const heldAttestation = unstable_cache(async (id: string) => await focalAttestation(id as Hex), ["moolam-story-recheck"], {
  revalidate: HOLD_SECONDS,
  tags: [CACHE_TAGS.chain],
});

async function focalAttestation(id: Hex): Promise<StoryAttestation | null> {
  const written = await getAttestations(id).catch(() => []);
  const newest = written.filter((row) => isChainlinkReceiver(row.receiver)).at(-1);
  if (newest === undefined) {
    return null;
  }
  return {
    passportId: id,
    matched: newest.matched,
    distance: newest.distance,
    receiver: newest.receiver,
    at: Number(newest.at),
  };
}

/**
 * The agent's standing, from the index, which is the one place these counts are
 * added up. The Agents page and the agent's own page read the same row, so the
 * score on the story is the score a judge sees when they click through.
 *
 * The ERC-8004 reputation registry is deliberately not read here: its feedback
 * is a claim somebody signed, it is shown on the agent's page under its own
 * label, and quoting it beside a calculated score gave two numbers for one
 * agent. An agent the index has no row for shows as no score.
 */
export async function agentStanding(agentId: bigint, row?: IndexGenerator): Promise<StoryAgent | null> {
  let standing = row;

  if (standing === undefined) {
    try {
      standing = (await generatorRecord(agentId)) ?? undefined;
    } catch {
      return null;
    }
  }

  if (standing === undefined) {
    return null;
  }

  return {
    id: agentId.toString(),
    score: standing.trustScore,
    rechecks: standing.matchedCount,
    passports: standing.passportCount,
  };
}

interface Picture {
  /** The registered image itself, for the plate the camera stops at. */
  full: string;
  /** The 512 pixel copy the metadata carries, for the plates in the field. */
  thumbnail: string;
  /** The name pinned with the picture, which is the only thing that tells a real one from a seed card. */
  title: string | null;
  /** True when the document carries Moolam's sworn line, word for word. */
  sworn: boolean;
}

/**
 * Follows a passport's metadata document to its picture.
 *
 * A document with no image is a record of a fingerprint with nothing to show,
 * which is what the forgery attempts written by the prove-it run look like, so
 * it gives null and the field simply has one plate fewer. A gateway that will
 * not answer throws instead, so the two are told apart by what holds them.
 */
/** Thrown when the gateway itself would not answer, which is a bad minute rather than a fact. */
class GatewayQuiet extends Error {
  constructor(uri: string) {
    super(`the gateway would not answer for ${uri}`);
    this.name = "GatewayQuiet";
  }
}

// The key carries "sworn" because the answers held under the old ones have no
// sworn line in them, and a day of those would leave the signed beat without it.
const heldFor = unstable_cache(async (uri: string) => await pictureFor(uri), ["moolam-story-picture-sworn"], {
  revalidate: METADATA_HOLD_SECONDS,
  tags: [CACHE_TAGS.metadata],
});

/**
 * The picture behind one metadata address, held for a day.
 *
 * Twenty four of these ran on every single visit before this. The document is
 * content addressed, so neither answer can change under the same id: a picture
 * stays that picture, and a record with no picture never grows one. Only a
 * gateway that would not answer is left out of the cache, because that is the
 * one thing here that is temporary.
 */
async function heldPicture(uri: string): Promise<Picture | null> {
  try {
    return await heldFor(uri);
  } catch {
    return null;
  }
}

async function pictureFor(uri: string): Promise<Picture | null> {
  let document: unknown;

  if (uri.startsWith("data:")) {
    return null;
  }

  try {
    const response = await fetch(gatewayUrl(uri), {
      signal: AbortSignal.timeout(METADATA_TIMEOUT_MS),
      // Content addressed: the answer can never change under this id.
      next: { revalidate: 3600 },
    });
    if (!response.ok) {
      throw new GatewayQuiet(uri);
    }
    document = await response.json();
  } catch {
    throw new GatewayQuiet(uri);
  }

  const record = document as {
    image?: unknown;
    thumbnail?: unknown;
    name?: unknown;
    sealed?: unknown;
    sworn?: unknown;
  };

  // A sealed passport is left out of the film on purpose. The film is a reel of
  // registered pictures, and this one has no picture to show: its own page,
  // Explore and the verify answer all draw it as the sealed record it is, which
  // is where it reads as designed rather than as a gap in a row of stills.
  if (record.sealed === true) {
    return null;
  }

  const image = typeof record.image === "string" && record.image.startsWith("ipfs://") ? record.image : null;
  const thumbnail = typeof record.thumbnail === "string" && record.thumbnail.startsWith("ipfs://") ? record.thumbnail : null;

  if (image === null && thumbnail === null) {
    return null;
  }

  return {
    full: gatewayUrl(image ?? (thumbnail as string)),
    thumbnail: gatewayUrl(thumbnail ?? (image as string)),
    title: typeof record.name === "string" ? record.name : null,
    sworn: statementsOf(record).sworn,
  };
}
