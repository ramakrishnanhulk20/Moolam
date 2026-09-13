import type { Hex } from "viem";
import { DEMO_AGENT_ID, gatewayUrl, reason } from "@/lib/chain/client";
import { getAttestations, getPassport } from "@/lib/chain/registry";
import { getReputation, getReputationClients } from "@/lib/chain/reputation";
import { latestPassports } from "@/lib/data/passports";
import { activeSource, envioUrl } from "@/lib/data/source";
import degrade from "@/public/hero/degrade.json";

const METADATA_TIMEOUT_MS = 8_000;
const INDEX_TIMEOUT_MS = 10_000;

/** How many recent passports the field is textured from. */
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

export interface StoryAgent {
  id: string;
  /** Feedback entries on the ERC-8004 reputation registry, tags moolam/verification. */
  verifications: number;
  score: number | null;
  passports: number | null;
}

export interface StoryData {
  source: "envio" | "chain";
  plates: StoryPlate[];
  focal: StoryFocal | null;
  attestation: StoryAttestation | null;
  agent: StoryAgent | null;
  passportCount: number | null;
  attestationCount: number | null;
  /** The provider's own words when nothing could be read, shown rather than swallowed. */
  error: string | null;
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
  }
}`;

/**
 * Everything the landing story shows, read live.
 *
 * One trip to the index for the newest passports and the two counts, then the
 * metadata documents those passports point at, then this passport's own
 * re-checks and its generator's standing on the ERC-8004 reputation registry. Nothing here is
 * cached in the app: the page that calls it is dynamic, and the only cache is
 * the browser-visible one on the content addressed metadata, which cannot
 * change under its own id.
 */
export async function storyData(): Promise<StoryData> {
  const source = activeSource();

  let rows: IndexRow[] = [];
  let attestation: StoryAttestation | null = null;
  let passportCount: number | null = null;
  let attestationCount: number | null = null;
  let agentCounts: Record<string, number> = {};
  let error: string | null = null;

  try {
    if (source === "envio") {
      const answer = await fromIndex();
      rows = answer.rows;
      passportCount = answer.passports;
      attestationCount = answer.attestations;
      agentCounts = answer.agentCounts;
    } else {
      rows = await fromChain();
    }
  } catch (caught) {
    error = reason(caught);
  }

  const pictures = await Promise.all(rows.map((row) => pictureFor(row.metadataURI)));

  const plates: StoryPlate[] = rows
    .map((row, index) => ({ row, picture: pictures[index] }))
    .filter((entry): entry is { row: IndexRow; picture: Picture } => entry.picture !== null)
    .map(({ row, picture }) => ({
      id: row.id,
      picture: picture.thumbnail,
      agentId: row.generatorId,
      registeredAt: Number(row.registeredAt),
    }));

  const chosen = chooseFocal(
    rows,
    pictures.map((picture) => picture !== null),
  );
  const focal =
    chosen === null ? null : focalFrom(rows[chosen.index], (pictures[chosen.index] as Picture).full, chosen.reason);

  // Only this passport's own re-check is ever shown. A newer one on a different
  // record is a true sentence about a record nobody is looking at, which is how
  // the story came to quote three passports at once.
  if (focal !== null) {
    attestation = await focalAttestation(focal.id);
  }

  // The trusted beat is about the generator that made this picture, so a
  // generator nobody has rated shows as no score rather than borrowing another
  // agent's standing.
  const agentId = focal === null ? DEMO_AGENT_ID : focal.agentId === null ? null : BigInt(focal.agentId);
  const agent = agentId === null ? null : await agentStanding(agentId, agentCounts[agentId.toString()] ?? null);

  return { source, plates, focal, attestation, agent, passportCount, attestationCount, error };
}

async function fromIndex(): Promise<{
  rows: IndexRow[];
  passports: number | null;
  attestations: number | null;
  agentCounts: Record<string, number>;
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
      Generator: { id: string; passportCount: number }[];
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
    agentCounts: Object.fromEntries(body.data.Generator.map((row) => [row.id, row.passportCount])),
  };
}

/**
 * The same rows straight from the registry's own events, for a day with no index.
 *
 * The chooser needs the kind, the manifest hash and the number of re-checks on
 * every row, so this path reads the record and its attestation list for each of
 * the eight, which the index would have answered in one trip.
 */
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
 * The one passport the whole story is told on.
 *
 * The captions name an agent, a manifest and a re-check, so the record they are
 * told over has to carry all three or the story contradicts the page a judge
 * opens next. The newest record that carries everything wins; failing that the
 * newest an agent made and sealed, with the re-check line told truthfully as
 * missing; failing that the newest picture of any kind, with the agent line
 * gone. A record with no picture is never chosen: the forgery attempts the
 * prove-it run writes are exactly that, and a story about an image cannot be
 * told on one.
 *
 * Pure, and tested in test/story-focal.test.ts against a fixture index.
 */
export function chooseFocal(
  rows: readonly IndexRow[],
  hasPicture: readonly boolean[],
): { index: number; reason: FocalReason } | null {
  for (const reason of ["full", "manifest", "any"] as const) {
    let best = -1;
    for (let index = 0; index < rows.length; index += 1) {
      if (hasPicture[index] !== true || !fits(rows[index], reason)) {
        continue;
      }
      if (best === -1 || Number(rows[index].registeredAt) > Number(rows[best].registeredAt)) {
        best = index;
      }
    }
    if (best !== -1) {
      return { index: best, reason };
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
 * The agent's standing, from the canonical ERC-8004 reputation registry.
 *
 * An agent nobody has rated returns a zero summary, and that is shown as no
 * score rather than as a score of zero.
 */
async function agentStanding(agentId: bigint, passports: number | null): Promise<StoryAgent | null> {
  try {
    const clients = await getReputationClients(agentId);
    const summary = await getReputation(agentId, clients);
    return {
      id: agentId.toString(),
      verifications: Number(summary.count),
      score: summary.count === 0n ? null : Number(summary.value) / 10 ** summary.decimals,
      passports,
    };
  } catch {
    return null;
  }
}

interface Picture {
  /** The registered image itself, for the plate the camera stops at. */
  full: string;
  /** The 512 pixel copy the metadata carries, for the plates in the field. */
  thumbnail: string;
}

/**
 * Follows a passport's metadata document to its picture.
 *
 * A document with no image is a record of a fingerprint with nothing to show,
 * which is what the forgery attempts written by the prove-it run look like, so
 * it gives null and the field simply has one plate fewer.
 */
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
      return null;
    }
    document = await response.json();
  } catch {
    return null;
  }

  const record = document as { image?: unknown; thumbnail?: unknown };
  const image = typeof record.image === "string" && record.image.startsWith("ipfs://") ? record.image : null;
  const thumbnail = typeof record.thumbnail === "string" && record.thumbnail.startsWith("ipfs://") ? record.thumbnail : null;

  if (image === null && thumbnail === null) {
    return null;
  }

  return {
    full: gatewayUrl(image ?? (thumbnail as string)),
    thumbnail: gatewayUrl(thumbnail ?? (image as string)),
  };
}
