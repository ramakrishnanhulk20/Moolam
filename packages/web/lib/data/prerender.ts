import { PHASE_PRODUCTION_BUILD } from "next/constants";
import { heldPictureSplit, plateSheet, sheetPage } from "@/components/explore/plates";
import { DEFAULT_SEARCH } from "@/components/explore/query";
import { reason } from "@/lib/chain/client";
import {
  explorePassports,
  generatorStandings,
  heldGeneratorStandings,
  heldRegistryCounts,
} from "@/lib/data/passports";
import { activeSource } from "@/lib/data/source";

/** How many of the newest rows the build looks through for real pictures. */
const PICTURE_CAP = 60;

/** How many generators the build builds a page for. It is the same cap the agents board reads. */
const AGENT_CAP = 50;

/**
 * How long a build waits for one of the two lists before it goes without it.
 *
 * A failed read is retried before it counts as failed (`withRetries` below):
 * up to three more attempts, waiting 2, then 5, then 10 seconds between them,
 * and every attempt still carries the index's own 10 second fetch timeout. The
 * worst case before this bound is even reached is four attempts at 10 seconds
 * plus 17 seconds of waiting between them, 57 seconds, so the original 10
 * seconds is raised to clear that with room to spare.
 */
const LIST_TIMEOUT_MS = 60_000;

/**
 * The passports worth building before anybody asks for one: the real pictures,
 * newest first.
 *
 * The split between a picture and a seed test card is the title in the pinned
 * metadata, so this is the same sieve the Explore sheet reads through rather
 * than a second rule that could drift from it.
 */
export async function realPictureIds(): Promise<string[]> {
  return await bounded("with no passport list", [], async () => {
    if (activeSource() !== "envio") {
      return [];
    }
    const sheet = plateSheet("real");
    const page = await explorePassports({ filter: { pictures: "real" }, limit: PICTURE_CAP, keep: sheet.keep });
    return page.passports.map((row) => row.id);
  });
}

/** The agents the board already lists, which are every generator the index has seen sign a picture. */
export async function knownAgentIds(): Promise<string[]> {
  return await bounded("with no agent list", [], async () => {
    if (activeSource() !== "envio") {
      return [];
    }
    return (await generatorStandings(AGENT_CAP)).map((row) => row.id);
  });
}

/**
 * How long the build waits for Explore's opening view. It reads a page of the
 * index and then a pinned document for every row it walks past, where the two
 * lists above are one query each, so it is given longer before the build
 * decides to go without it.
 *
 * It carries the same retry envelope as LIST_TIMEOUT_MS above (57 seconds
 * worst case: four attempts at 10 seconds plus 17 seconds of waiting), plus
 * the extra room its three concurrent reads already had, so the original 30
 * seconds is raised to 90.
 */
const EXPLORE_TIMEOUT_MS = 90_000;

/**
 * The view Explore opens on, read before the build draws the page.
 *
 * The opening view is a page the build makes, one copy per language, and all ten
 * of them make these same three reads. Reading them once here, under a bound the
 * page renders do not have, means the scan of the index happens before the ten
 * pages rather than inside the first of them, and an index that is slow or down
 * costs those pages their built copy and never the build itself.
 *
 * True when the view was read and held, false when the build went without it.
 */
export async function holdExploreDefault(): Promise<boolean> {
  return await bounded(
    "without Explore's opening view held",
    false,
    async () => {
      if (activeSource() !== "envio") {
        return false;
      }
      await Promise.all([sheetPage(DEFAULT_SEARCH), heldRegistryCounts(), heldPictureSplit()]);
      return true;
    },
    EXPLORE_TIMEOUT_MS,
  );
}

/**
 * The roster the agents board opens on, read before the build draws the page.
 *
 * The board is a page the build makes, one copy per language, and all ten of
 * them ask the index for the same roster. Reading it once here, under a bound
 * the page renders do not have, means the query happens before the ten pages
 * rather than inside the first of them, and an index that is slow or down costs
 * those pages their built copy and never the build itself.
 *
 * True when the roster was read and held, false when the build went without it.
 */
export async function holdAgentsRoster(): Promise<boolean> {
  return await bounded("without the agents roster held", false, async () => {
    if (activeSource() !== "envio") {
      return false;
    }
    await heldGeneratorStandings(AGENT_CAP);
    return true;
  });
}

/** The two names a failure message points a builder at. Never the address itself: a working link and a wrong one read the same, so only the variable that holds it is worth printing. */
const INDEX_URL_VARIABLE = "NEXT_PUBLIC_ENVIO_GRAPHQL_URL";
const BUILD_WITHOUT_INDEX_VARIABLE = "MOOLAM_BUILD_WITHOUT_INDEX";

/** The wait before each of the three attempts a retryable failure gets beyond the first. */
const RETRY_WAITS_MS = [2_000, 5_000, 10_000];

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * True for a 429 or a plain network failure, the two conditions patience can
 * fix. A 404 means the address itself is wrong, so trying it again three more
 * times only spends the build's time to fail the same way three more times;
 * every other answered status is left to fail once rather than retried on a
 * guess.
 */
function worthRetrying(error: unknown): boolean {
  const status = reason(error).match(/answered (\d+)/);
  return status === null || status[1] === "429";
}

/**
 * Runs `read`, and on a 429 or a network failure tries again up to three more
 * times with waits of 2, 5 and 10 seconds between attempts. A 404, or any
 * other answered status, is left to fail on the first try.
 */
async function withRetries<T>(read: () => Promise<T>): Promise<T> {
  let attempt = 0;
  for (;;) {
    try {
      return await read();
    } catch (error) {
      if (attempt >= RETRY_WAITS_MS.length || !worthRetrying(error)) {
        throw error;
      }
      await wait(RETRY_WAITS_MS[attempt]);
      attempt += 1;
    }
  }
}

function isProductionBuild(): boolean {
  return process.env.NEXT_PHASE === PHASE_PRODUCTION_BUILD;
}

/**
 * One of these reads, or what the build can carry on without.
 *
 * None of them changes what the site serves, only what is ready before the first
 * visitor asks: a list decides which pages exist ahead of time and every id
 * outside it still renders on demand, and the held view is rebuilt on the
 * request when it is missing. So an index that is slow or down at build time
 * costs one cold first visit, and must never cost the build itself silently:
 * on 21 September a retired index address answered 404 on every build-time
 * read, the build passed anyway, and four pages shipped live-rendered on
 * stale data until the next deploy. A production build now throws instead,
 * after the patient retries above are used up, so a bad address fails the
 * build loudly rather than shipping a quiet one. Outside a production build
 * (the dev server, tests) the old behaviour holds: log and fall back. Setting
 * MOOLAM_BUILD_WITHOUT_INDEX=1 keeps a real outage shippable on purpose, and
 * still logs, just loudly rather than quietly.
 */
async function bounded<T>(
  missing: string,
  fallback: T,
  read: () => Promise<T>,
  allowanceMs = LIST_TIMEOUT_MS,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      withRetries(read),
      new Promise<T>((_, fail) => {
        timer = setTimeout(() => fail(new Error(`it took longer than ${allowanceMs} ms`)), allowanceMs);
      }),
    ]);
  } catch (error) {
    const detail = reason(error);

    if (isProductionBuild()) {
      if (process.env[BUILD_WITHOUT_INDEX_VARIABLE] === "1") {
        console.log(
          `moolam: ${BUILD_WITHOUT_INDEX_VARIABLE}=1 overrode a failed read, building ${missing} anyway, ${detail}. Check ${INDEX_URL_VARIABLE}.`,
        );
        return fallback;
      }
      throw new Error(
        `moolam: building ${missing} failed, ${detail}. A production build cannot ship on a failed read: check ${INDEX_URL_VARIABLE}, or set ${BUILD_WITHOUT_INDEX_VARIABLE}=1 to build without the index on purpose.`,
      );
    }

    console.log(`moolam: building ${missing}, ${detail}`);
    return fallback;
  } finally {
    clearTimeout(timer);
  }
}
