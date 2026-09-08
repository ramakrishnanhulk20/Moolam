import type { Hex } from "viem";
import { DEMO_AGENT_ID, reason } from "@/lib/chain/client";
import { getAttestations, getPassport } from "@/lib/chain/registry";
import { getReputation, getReputationClients } from "@/lib/chain/reputation";
import { latestPassports } from "@/lib/data/passports";
import { activeSource, envioUrl } from "@/lib/data/source";
import degrade from "@/public/hero/degrade.json";

/**
 * The account's own Pinata gateway. The shared gateway.pinata.cloud takes
 * longer than half a minute to answer for these content ids, which is a blank
 * plate on the first screen, so the story reads through the gateway that
 * pinned them.
 */
const GATEWAY = "https://lavender-personal-grasshopper-978.mypinata.cloud/ipfs/";

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
  agentId: string;
  registeredAt: number;
  block: string;
  /** True when this is the passport the verifier measured the degrade ladder on. */
  measured: boolean;
}

/** An independent re-check written back on chain. */
export interface StoryAttestation {
  passportId: Hex;
  matched: boolean;
  distance: number;
  receiver: Hex;
  at: number;
  /** False when the newest re-check on the registry belongs to another passport. */
  onFocal: boolean;
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

interface IndexRow {
  id: Hex;
  metadataURI: string;
  registeredAt: string;
  registeredBlock: string;
  generatorId: string | null;
  creator: Hex;
}

const STORY_QUERY = `query Story($limit: Int!) {
  Passport(order_by: { registeredAt: desc }, limit: $limit) {
    id
    metadataURI
    registeredAt
    registeredBlock
    generator_id
    creator_id
  }
  Attestation(order_by: { at: desc }, limit: 1) {
    passport_id
    matched
    distance
    at
    receiver
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
 * One trip to the index for the newest passports, the newest re-check and the
 * two counts, then the metadata documents those passports point at, then the
 * agent's standing from the ERC-8004 reputation registry. Nothing here is
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
      attestation = answer.attestation;
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

  const focal = await focalPassport(rows, pictures);

  if (focal !== null) {
    const own = await focalAttestation(focal.id);
    if (own !== null) {
      attestation = own;
    } else if (attestation !== null) {
      attestation = { ...attestation, onFocal: attestation.passportId.toLowerCase() === focal.id.toLowerCase() };
    }
  }

  const agentId = focal === null ? DEMO_AGENT_ID : BigInt(focal.agentId);
  let agent = await agentStanding(agentId, agentCounts[agentId.toString()] ?? null);

  // A generator nobody has rated yet has nothing to show for the beat about
  // trust, so the agent that does have feedback is shown instead. The card
  // always names the id it is showing, so neither answer can read as the other.
  if ((agent === null || agent.verifications === 0) && agentId !== DEMO_AGENT_ID) {
    const demo = await agentStanding(DEMO_AGENT_ID, agentCounts[DEMO_AGENT_ID.toString()] ?? null);
    if (demo !== null && demo.verifications > 0) {
      agent = demo;
    }
  }

  return { source, plates, focal, attestation, agent, passportCount, attestationCount, error };
}

async function fromIndex(): Promise<{
  rows: IndexRow[];
  attestation: StoryAttestation | null;
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
      }[];
      Attestation: { passport_id: Hex; matched: boolean; distance: number; at: string; receiver: Hex }[];
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

  const newest = body.data.Attestation[0];
  const stats = body.data.GlobalStats[0];

  return {
    rows: body.data.Passport.map((row) => ({
      id: row.id,
      metadataURI: row.metadataURI,
      registeredAt: row.registeredAt,
      registeredBlock: row.registeredBlock,
      generatorId: row.generator_id,
      creator: row.creator_id,
    })),
    attestation:
      newest === undefined
        ? null
        : {
            passportId: newest.passport_id,
            matched: newest.matched,
            distance: newest.distance,
            receiver: newest.receiver,
            at: Number(newest.at),
            // Set once the story's own passport is known, below.
            onFocal: false,
          },
    passports: stats?.passports ?? null,
    attestations: stats?.attestations ?? null,
    agentCounts: Object.fromEntries(body.data.Generator.map((row) => [row.id, row.passportCount])),
  };
}

/** The same rows straight from the registry's own events, for a day with no index. */
async function fromChain(): Promise<IndexRow[]> {
  const rows = (await latestPassports(8)).passports;
  const records = await Promise.all(rows.map((row) => getPassport(row.id).catch(() => null)));

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
      },
    ];
  });
}

/**
 * The passport the story follows: the newest one that carries a real picture.
 *
 * Records without an image exist on purpose, the forgery attempts the prove-it
 * run writes are exactly that, and a story about an image cannot be told on
 * one. The flag says whether this is also the file the verifier measured the
 * degrade figures on, which the caption uses to say where those figures came
 * from.
 */
async function focalPassport(rows: IndexRow[], pictures: (Picture | null)[]): Promise<StoryFocal | null> {
  for (let index = 0; index < rows.length; index += 1) {
    const picture = pictures[index];
    if (picture === null) {
      continue;
    }
    const row = rows[index];
    return {
      id: row.id,
      picture: picture.full,
      creator: row.creator,
      agentId: row.generatorId ?? DEMO_AGENT_ID.toString(),
      registeredAt: Number(row.registeredAt),
      block: row.registeredBlock,
      measured: row.id.toLowerCase() === degrade.passportId.toLowerCase(),
    };
  }

  return null;
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
    onFocal: true,
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
    const response = await fetch(url(uri), {
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
    full: url(image ?? (thumbnail as string)),
    thumbnail: url(thumbnail ?? (image as string)),
  };
}

function url(uri: string): string {
  return uri.startsWith("ipfs://") ? `${GATEWAY}${uri.slice("ipfs://".length)}` : uri;
}
