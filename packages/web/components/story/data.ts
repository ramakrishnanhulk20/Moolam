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
import { getAttestations, getPassport } from "@/lib/chain/registry";
import { generatorRecord, latestPassports } from "@/lib/data/passports";
import { activeSource, envioUrl } from "@/lib/data/source";
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
  attestationCount: number | null;
  /** The provider's own words when nothing could be read, shown rather than swallowed. */
  error: string | null;
}

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

const STORY_QUERY = `query Story($limit: Int!) {
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
  let attestation: StoryAttestation | null = null;
  let passportCount: number | null = null;
  let attestationCount: number | null = null;
  let generators: Record<string, IndexGenerator> = {};
  let error: string | null = null;

  try {
    if (source === "envio") {
      const answer = await heldIndex();
      rows = answer.rows;
      passportCount = answer.passports;
      attestationCount = answer.attestations;
      generators = answer.generators;
    } else {
      rows = await heldChain();
    }
  } catch (caught) {
    error = reason(caught);
  }

  const pictures = await Promise.all(rows.map((row) => heldPicture(row.metadataURI)));

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
        entry.picture !== null && !isTestCard(entry.picture.title),
    )
    .map(({ row, picture }) => ({
      id: row.id,
      picture: picture.thumbnail,
      agentId: row.generatorId,
      registeredAt: Number(row.registeredAt),
    }));

  const chosen = chooseFocal(
    rows,
    pictures.map((picture) => picture !== null),
    pictures.map((picture) => picture?.title ?? null),
  );
  const focal =
    chosen === null ? null : focalFrom(rows[chosen.index], (pictures[chosen.index] as Picture).full, chosen.reason);

  if (process.env.NODE_ENV === "development" && chosen !== null) {
    // Which record the story opened on, so a wrong one is caught on the dev
    // server rather than in a judge's screenshot.
    console.info(
      `story focal: ${rows[chosen.index].id} "${pictures[chosen.index]?.title ?? "untitled"}" on the ${chosen.reason} rung, ${rows[chosen.index].attestations} re-checks`,
    );
  }

  // Only this passport's own re-check is ever shown. A newer one on a different
  // record is a true sentence about a record nobody is looking at, which is how
  // the story came to quote three passports at once.
  if (focal !== null) {
    attestation = await heldAttestation(focal.id);
  }

  // The trusted beat is about the generator that made this picture, so a
  // generator the index has no row for shows as no score rather than borrowing
  // another agent's standing.
  const agentId = focal === null ? DEMO_AGENT_ID : focal.agentId === null ? null : BigInt(focal.agentId);
  const agent = agentId === null ? null : await agentStanding(agentId, generators[agentId.toString()]);

  const { statement, statementError } = focal === null ? NO_STATEMENT : await focalStatement(focal.id);

  return {
    source,
    plates,
    focal,
    attestation,
    agent,
    statement,
    statementError,
    passportCount,
    attestationCount,
    error,
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
const heldIndex = unstable_cache(async () => await fromIndex(), ["moolam-story-index"], {
  revalidate: HOLD_SECONDS,
  tags: [CACHE_TAGS.index],
});

async function fromIndex(): Promise<{
  rows: IndexRow[];
  passports: number | null;
  attestations: number | null;
  generators: Record<string, IndexGenerator>;
}> {
  const response = await fetch(envioUrl(), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      query: STORY_QUERY,
      variables: { limit: FIELD_DEPTH },
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
      Passport: {
        id: Hex;
        metadataURI: string;
        registeredAt: string;
        registeredBlock: string;
        generator_id: string | null;
        creator_id: Hex;
        kind: number;
        manifestHash: Hex;
        attestationCount: number;
      }[];
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
    rows: body.data.Passport.map((row) => ({
      id: row.id,
      metadataURI: row.metadataURI,
      registeredAt: row.registeredAt,
      registeredBlock: row.registeredBlock,
      generatorId: row.generator_id,
      creator: row.creator_id,
      kind: row.kind,
      manifestHash: row.manifestHash,
      attestations: row.attestationCount,
    })),
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
      if (rung.realOnly && isTestCard(titles[index] ?? null)) {
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
 * one lands minutes apart at best, so a minute costs the story nothing.
 */
const heldAttestation = unstable_cache(async (id: string) => await focalAttestation(id as Hex), ["moolam-story-recheck"], {
  revalidate: HOLD_SECONDS,
  tags: [CACHE_TAGS.chain],
});

async function focalAttestation(id: Hex): Promise<StoryAttestation | null> {
  const written = await getAttestations(id).catch(() => []);
  const newest = written.at(-1);
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

// The key carries "titled" because the answers held under the old one have no
// title in them, and a day of those would send the chooser back to a seed card.
const heldFor = unstable_cache(async (uri: string) => await pictureFor(uri), ["moolam-story-picture-titled"], {
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

  const record = document as { image?: unknown; thumbnail?: unknown; name?: unknown; sealed?: unknown };

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
  };
}
