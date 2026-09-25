import { unstable_cache } from "next/cache";
import sharp from "sharp";
import { CACHE_TAGS, METADATA_HOLD_SECONDS, addresses, reason } from "@/lib/chain/client";
import { heldConsent, plainStatement } from "@/lib/chain/consent";
import { heldPassportRecord } from "@/lib/chain/registry";
import { offeredSamples } from "@/lib/data/offeredSamples";
import { heldArt } from "@/lib/data/passports";
import type { TrySample } from "@/lib/data/samples";
import { verify } from "@/lib/verifier/client";
import {
  COPY_RECIPE,
  FINDING_ID,
  chainlinkRecheck,
  copyVerdict,
  isRead,
  type CopyReading,
  type Finding,
  type Read,
} from "./finding";

const THUMBNAIL_TIMEOUT_MS = 10_000;

/** Everything the bench draws, read on the server before the first byte goes out. */
export interface FirstScreenData {
  finding: Read<Finding>;
  copy: Read<CopyReading>;
  samples: TrySample[];
}

/**
 * The finding, the copy and the three samples.
 *
 * Every read goes through a hold the rest of the app already keeps: the record
 * and the statement for a minute, like the passport page, the samples for a
 * minute, like the verify page, and the copy for a day, because the thumbnail
 * is content addressed and the recipe is fixed, so the same file comes out
 * every time.
 */
export async function firstScreenData(): Promise<FirstScreenData> {
  const [finding, offered] = await Promise.all([readFinding(), offeredSamples()]);
  const copy: Read<CopyReading> = isRead(finding)
    ? await readCopy(finding.read)
    : { failed: "there is no passport to make a copy of" };
  return { finding, copy, samples: offered.samples };
}

async function readFinding(): Promise<Read<Finding>> {
  try {
    const { passport, attestations } = await heldPassportRecord(FINDING_ID);
    if (passport === null) {
      return { failed: "the registry holds no record under the film's passport id" };
    }

    const art = await heldArt(passport.metadataURI, passport.id);

    let statement: Finding["statement"] = null;
    let statementError: string | null = null;
    try {
      const reading = await heldConsent(passport.id);
      if (reading.stated && reading.entry !== null) {
        statement = { summary: plainStatement(reading.entry.consent), at: Number(reading.entry.at) };
      }
    } catch (error) {
      statementError = reason(error);
    }

    return {
      read: {
        id: passport.id,
        title: art.title ?? null,
        picture: art.imageUrl ?? art.thumbnailUrl ?? null,
        thumbnail: art.thumbnailUrl ?? null,
        registeredAt: Number(passport.registeredAt),
        phash: passport.phash.toString(),
        recheck: chainlinkRecheck(attestations, [addresses.receiver, addresses.sealedReceiver]),
        statement,
        statementError,
      },
    };
  } catch (error) {
    return { failed: reason(error) };
  }
}

/**
 * The copy is made from the real thumbnail and judged by the real service.
 * Anything that fails throws inside the hold, so a bad minute on the gateway or
 * the service is never kept for a day.
 */
const heldCopy = unstable_cache(
  async (thumbnail: string, id: string, phash: string) => await makeCopy(thumbnail, id, phash),
  ["moolam-lab-first-screen-copy", `trim-${COPY_RECIPE.trim}-hue-${COPY_RECIPE.hue}-q-${COPY_RECIPE.quality}`],
  { revalidate: METADATA_HOLD_SECONDS, tags: [CACHE_TAGS.metadata] },
);

async function readCopy(finding: Finding): Promise<Read<CopyReading>> {
  if (finding.thumbnail === null) {
    return { failed: "the passport's document names no picture to copy" };
  }
  try {
    return { read: await heldCopy(finding.thumbnail, finding.id, finding.phash) };
  } catch (error) {
    return { failed: reason(error) };
  }
}

async function makeCopy(thumbnail: string, id: string, phash: string): Promise<CopyReading> {
  const response = await fetch(thumbnail, { signal: AbortSignal.timeout(THUMBNAIL_TIMEOUT_MS), cache: "no-store" });
  if (!response.ok) {
    throw new Error(`the gateway answered ${response.status} for the thumbnail`);
  }
  const source = Buffer.from(await response.arrayBuffer());
  const { width = 0, height = 0 } = await sharp(source).metadata();
  if (width === 0 || height === 0) {
    throw new Error("the thumbnail has no size sharp can read");
  }

  const top = Math.round(height * COPY_RECIPE.trim);
  // sharp writes no metadata unless it is asked to, so the copy leaves here
  // stripped as well as trimmed, recoloured and re-encoded.
  const { data, info } = await sharp(source)
    .extract({ left: 0, top, width: Math.round(width * (1 - COPY_RECIPE.trim)), height: height - top })
    .modulate({ brightness: COPY_RECIPE.brightness, saturation: COPY_RECIPE.saturation, hue: COPY_RECIPE.hue })
    .resize({ width: COPY_RECIPE.width })
    .jpeg({ quality: COPY_RECIPE.quality })
    .toBuffer({ resolveWithObject: true });

  const bytes = new Uint8Array(data);
  const answer = await verify({ file: new File([bytes], "copy.jpg", { type: "image/jpeg" }) });
  const verdict = copyVerdict(answer.result, id, phash);

  return {
    image: `data:image/jpeg;base64,${Buffer.from(bytes).toString("base64")}`,
    width: info.width,
    height: info.height,
    bytes: bytes.byteLength,
    ...verdict,
    measuredAt: Date.now(),
  };
}
