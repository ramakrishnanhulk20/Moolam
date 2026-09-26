import { unstable_cache } from "next/cache";
import sharp from "sharp";
import { CACHE_TAGS, HOLD_SECONDS, reason } from "@/lib/chain/client";
import { chainlinkReceivers } from "@/lib/chain/receivers";
import { heldConsent, plainStatement } from "@/lib/chain/consent";
import { heldPassportRecord } from "@/lib/chain/registry";
import { offeredSamples } from "@/lib/data/offeredSamples";
import { askIndex, heldArt } from "@/lib/data/passports";
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
  type LooseFinding,
  type Read,
} from "./finding";

const THUMBNAIL_TIMEOUT_MS = 10_000;

/** How long the build waits for the first screen's reads before it goes without the copy. */
const HOLD_TIMEOUT_MS = 60_000;

/** Everything the first screen draws, read on the server before the first byte goes out. */
export interface FirstScreenData {
  finding: Read<Finding>;
  copy: Read<CopyReading>;
  samples: TrySample[];
  /** Only when the registry record could not be read: what is left to show without it. */
  loose: LooseFinding | null;
}

/**
 * The finding, the copy and the three samples.
 *
 * The chain's facts go through holds the rest of the app already keeps: the
 * record and the statement for a minute, like the passport page, the samples
 * for a minute, like the verify page, and the pinned document for a day. The
 * home page is rebuilt from them a minute at a time, so a visitor never waits
 * on any of them.
 *
 * The copy is different. It is made once, when the site is built, and kept
 * until the next build. If that hold is ever found empty after launch, the
 * next background rebuild makes it again, once: see heldCopy.
 */
export async function firstScreenData(): Promise<FirstScreenData> {
  const [record, said, offered] = await Promise.all([readRecord(), readStatement(), offeredSamples()]);

  if (!isRead(record)) {
    return {
      finding: record,
      copy: { failed: "the registry record could not be read, so there is no fingerprint to hold the copy to" },
      samples: offered.samples,
      loose: await readLoose(said.statement),
    };
  }

  const finding: Finding = { ...record.read, ...said };
  return { finding: { read: finding }, copy: await readCopy(finding), samples: offered.samples, loose: null };
}

/**
 * The first screen's reads, made before the build draws the ten home pages.
 *
 * This is where the copy is meant to be made: the server trims the registered
 * thumbnail, hands it to the verify service, and keeps the answer until the
 * next build. Every page the build then draws, and every rebuild after launch,
 * reads that answer from the hold. A build that could not make the copy still
 * ships, loudly: the first screen then shows the chain's own facts and no copy,
 * which is the one failure a visitor can never be shown a made up number for,
 * until a rebuild after launch makes it.
 *
 * True when the copy was made and held, false when the build went without it.
 */
export async function holdFirstScreen(): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const data = await Promise.race([
      firstScreenData(),
      new Promise<never>((_, fail) => {
        timer = setTimeout(() => fail(new Error(`it took longer than ${HOLD_TIMEOUT_MS} ms`)), HOLD_TIMEOUT_MS);
      }),
    ]);
    if (!isRead(data.copy)) {
      console.log(`moolam: building the home page without the first screen's copy, ${data.copy.failed}`);
      return false;
    }
    return true;
  } catch (error) {
    console.log(`moolam: building the home page without the first screen's copy, ${reason(error)}`);
    return false;
  } finally {
    clearTimeout(timer);
  }
}

type Said = Pick<Finding, "statement" | "statementError">;

async function readStatement(): Promise<Said> {
  try {
    const reading = await heldConsent(FINDING_ID);
    if (!reading.stated || reading.entry === null) {
      return { statement: null, statementError: null };
    }
    return {
      statement: { summary: plainStatement(reading.entry.consent), at: Number(reading.entry.at) },
      statementError: null,
    };
  } catch (error) {
    return { statement: null, statementError: reason(error) };
  }
}

async function readRecord(): Promise<Read<Omit<Finding, keyof Said>>> {
  try {
    const { passport, attestations } = await heldPassportRecord(FINDING_ID);
    if (passport === null) {
      return { failed: "the registry holds no record under the film's passport id" };
    }

    const art = await heldArt(passport.metadataURI, passport.id);

    return {
      read: {
        id: passport.id,
        title: art.title ?? null,
        picture: art.imageUrl ?? art.thumbnailUrl ?? null,
        thumbnail: art.thumbnailUrl ?? null,
        registeredAt: Number(passport.registeredAt),
        phash: passport.phash.toString(),
        recheck: chainlinkRecheck(attestations, chainlinkReceivers()),
      },
    };
  } catch (error) {
    return { failed: reason(error) };
  }
}

const FINDING_ROW = `query FindingRow($ids: [String!]!) {
  Passport(where: { id: { _in: $ids } }) {
    metadataURI
  }
}`;

/** Where the index says the passport's document is pinned, held for a minute like every other index read. */
const heldDocumentAddress = unstable_cache(
  async (id: string) => {
    const data = await askIndex<{ Passport: { metadataURI: string }[] }>(FINDING_ROW, { ids: [id] });
    return data.Passport[0]?.metadataURI ?? null;
  },
  ["moolam-first-screen-document"],
  { revalidate: HOLD_SECONDS, tags: [CACHE_TAGS.index] },
);

/**
 * The picture and its name without the registry, for the minute the registry
 * would not answer. The index keeps its own copy of where the document is
 * pinned, and the document itself is held for a day, so an outage on the chain
 * endpoint still leaves the first screen its picture.
 */
async function readLoose(statement: Finding["statement"]): Promise<LooseFinding | null> {
  let title: string | null = null;
  let thumbnail: string | null = null;
  try {
    const address = await heldDocumentAddress(FINDING_ID.toLowerCase());
    if (address !== null) {
      const art = await heldArt(address, FINDING_ID);
      title = art.title ?? null;
      thumbnail = art.thumbnailUrl ?? null;
    }
  } catch {
    // Nothing to add: the picture simply is not shown.
  }
  return title === null && thumbnail === null && statement === null
    ? null
    : { id: FINDING_ID, title, thumbnail, statement };
}

/**
 * Whether this process may make the copy and ask the verify service about it.
 *
 * On the server, whenever the hold is empty: while the site is built, and in a
 * rebuild of the home page after launch. A hold kept only by the build is not
 * promised to survive into the running site (the host's data cache can start
 * empty), and refusing there cost the live first screen its copy and its
 * verdict a minute after every deploy.
 *
 * This is safe for a visitor because of where the one caller runs. The home
 * page is prerendered and revalidates on a minute, so a rebuild happens in the
 * background after the stale page has already been sent: nobody waits on the
 * gateway, sharp or the verify service. The page is the only thing that
 * imports this file (a test holds that), so no route handler a visitor calls
 * can reach it. The hold never expires, so the copy is made once per empty
 * hold and read after that. A failed making is not kept, and the page shows
 * the chain's own facts without the copy until a later rebuild succeeds.
 */
function mayMakeCopy(): boolean {
  return typeof window === "undefined";
}

class CopyNotMadeHere extends Error {
  constructor() {
    super("the copy is only made on the server");
    this.name = "CopyNotMadeHere";
  }
}

/**
 * The ten languages are built, and rebuilt, side by side and each one asks for
 * the same copy before the first has been kept, so the process shares one
 * making of it rather than handing the verify service ten identical files.
 */
const making = new Map<string, Promise<CopyReading>>();

function shared(thumbnail: string, id: string, phash: string): Promise<CopyReading> {
  const key = `${thumbnail}|${id}|${phash}`;
  const running = making.get(key);
  if (running !== undefined) {
    return running;
  }
  const started = makeCopy(thumbnail, id, phash);
  making.set(key, started);
  started.catch(() => making.delete(key));
  return started;
}

/**
 * The copy, kept from one build to the next.
 *
 * It never expires on its own: the thumbnail is content addressed and the
 * recipe is in the name, so the same file comes out every time, and the only
 * thing that would change the verify service's answer is a new build of it.
 * Anything that fails throws inside the hold, so a bad minute on the gateway or
 * the service is never kept. Once kept, it is only ever read.
 */
const heldCopy = unstable_cache(
  async (thumbnail: string, id: string, phash: string) => {
    if (!mayMakeCopy()) {
      throw new CopyNotMadeHere();
    }
    return await shared(thumbnail, id, phash);
  },
  ["moolam-first-screen-copy", `trim-${COPY_RECIPE.trim}-hue-${COPY_RECIPE.hue}-q-${COPY_RECIPE.quality}`],
  { revalidate: false },
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
