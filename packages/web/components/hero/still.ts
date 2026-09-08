import type { AbiEvent, Hex } from "viem";
import { DEPLOY_BLOCK, addresses, chain, gatewayUrl, registryAbi } from "@/lib/chain/client";
import { getPassport } from "@/lib/chain/registry";
import { latestPassports } from "@/lib/data/passports";
import degrade from "@/public/hero/degrade.json";

/** The still the hero shows, with the live record it belongs to. */
export interface HeroStill {
  passportId: Hex;
  imageUrl: string;
  creator: Hex;
  agentId: string;
  registeredAt: number;
  /** True when this is the passport the degrade numbers were measured on. */
  measured: boolean;
}

/** What the pinned sequence needs, all of it read off degrade.json. */
export interface DegradeStep {
  transform: string;
  confidence: number;
  phashDistance: number | null;
  blockhashDistance: number | null;
  variant: string | null;
  bytes: number;
  frame: string | null;
}

const METADATA_TIMEOUT_MS = 8_000;
const DATA_JSON_PREFIX = "data:application/json,";

const registeredEvent = (registryAbi as AbiEvent[]).find(
  (item) => item.type === "event" && item.name === "PassportRegistered",
) as AbiEvent;

/**
 * The still, read live.
 *
 * The passport the verifier measurements belong to is tried first, because the
 * confidence figures beside the image have to describe the image on screen. A
 * redeploy retires that record, so the newest passport carrying an image is the
 * fallback, and the flag says which of the two answered.
 *
 * Returns null when the registry cannot be read or holds nothing with a picture.
 */
export async function heroStill(): Promise<HeroStill | null> {
  const measured = await fromMeasuredPassport();
  if (measured !== null) {
    return measured;
  }
  return fromNewestPassport();
}

async function fromMeasuredPassport(): Promise<HeroStill | null> {
  let record;
  try {
    record = await getPassport(degrade.passportId as Hex);
  } catch {
    return null;
  }
  if (record === null) {
    return null;
  }

  const image = await imageFromMetadata(record.metadataURI);
  if (image === null) {
    return null;
  }

  return {
    passportId: record.id,
    imageUrl: image,
    creator: record.creator,
    agentId: record.generatorAgentId.toString(),
    registeredAt: Number(record.registeredAt),
    measured: true,
  };
}

async function fromNewestPassport(): Promise<HeroStill | null> {
  let rows;
  try {
    rows = (await latestPassports(8)).passports;
  } catch {
    return null;
  }

  for (const row of rows) {
    const record = await getPassport(row.id).catch(() => null);
    if (record === null) {
      continue;
    }
    const image = await imageFromMetadata(record.metadataURI);
    if (image !== null) {
      return {
        passportId: record.id,
        imageUrl: image,
        creator: record.creator,
        agentId: record.generatorAgentId.toString(),
        registeredAt: Number(record.registeredAt),
        measured: false,
      };
    }
  }
  return null;
}

/**
 * Follows a passport's metadata to the picture itself.
 *
 * Both shapes the registry holds are handled: a plain data: URI written inline
 * by the proof script, and an ipfs:// document read through the gateway. A
 * document without an image field gives null, so the caller moves on to the next
 * passport rather than rendering a broken frame.
 */
async function imageFromMetadata(uri: string): Promise<string | null> {
  let document: unknown;

  if (uri.startsWith(DATA_JSON_PREFIX)) {
    try {
      document = JSON.parse(decodeURIComponent(uri.slice(DATA_JSON_PREFIX.length)));
    } catch {
      return null;
    }
  } else {
    try {
      const response = await fetch(gatewayUrl(uri), {
        signal: AbortSignal.timeout(METADATA_TIMEOUT_MS),
        // Content addressed, so the answer can never change under this URL.
        next: { revalidate: 3600 },
      });
      if (!response.ok) {
        return null;
      }
      document = await response.json();
    } catch {
      return null;
    }
  }

  const image = (document as { image?: unknown }).image;
  return typeof image === "string" && image.length > 0 ? gatewayUrl(image) : null;
}

/**
 * How many passports the registry holds, counted from its own events.
 *
 * Returns null when the endpoint refuses the range rather than a zero, because
 * "none registered" and "could not count" are two different answers and the
 * poster row says so.
 */
export async function passportCount(): Promise<number | null> {
  try {
    const logs = await chain.getLogs({
      address: addresses.registry,
      event: registeredEvent,
      fromBlock: DEPLOY_BLOCK,
      toBlock: await chain.getBlockNumber(),
    });
    return logs.length;
  } catch {
    return null;
  }
}

/**
 * The six steps the hero plays, in the order degrade.json lists them.
 *
 * Every value comes out of that file, which was written by posting the real
 * transforms to the running verifier. Nothing here is computed in the browser.
 */
export function degradeSteps(): DegradeStep[] {
  const frames = degrade.frames as Record<string, { file: string; bytes: number }>;

  return degrade.shown.map((name) => {
    const step = degrade.steps.find((entry) => entry.transform === name);
    if (step === undefined) {
      throw new Error(`degrade.json lists ${name} as shown but holds no measurement for it`);
    }
    return {
      transform: step.transform,
      confidence: step.confidence,
      phashDistance: step.phashDistance,
      blockhashDistance: step.blockhashDistance,
      variant: step.variant,
      bytes: step.bytes,
      frame: frames[name]?.file ?? null,
    };
  });
}

export const measurement = {
  passportId: degrade.passportId as Hex,
  imageCid: degrade.imageCid,
  measuredAt: degrade.measuredAt,
  registry: degrade.registry as Hex,
  exactConfidence: degrade.original.confidence,
  /**
   * The file the figures describe, by content id, so the pinned sequence shows
   * that picture even on the day the still above it falls back to another
   * passport.
   */
  imageUrl: gatewayUrl(`ipfs://${degrade.imageCid}`),
};
