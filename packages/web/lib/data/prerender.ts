import { heldPictureSplit, plateSheet, sheetPage } from "@/components/explore/plates";
import { DEFAULT_SEARCH } from "@/components/explore/query";
import { reason } from "@/lib/chain/client";
import { explorePassports, generatorStandings, heldRegistryCounts } from "@/lib/data/passports";
import { activeSource } from "@/lib/data/source";

/** How many of the newest rows the build looks through for real pictures. */
const PICTURE_CAP = 60;

/** How many generators the build builds a page for. It is the same cap the agents board reads. */
const AGENT_CAP = 50;

/** How long a build waits for one of the two lists before it goes without it. */
const LIST_TIMEOUT_MS = 10_000;

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
 */
const EXPLORE_TIMEOUT_MS = 30_000;

/**
 * The view Explore opens on, read while the site is built.
 *
 * Explore is drawn on the request, because the chips and the search term live
 * in the address, so there is no page here for a build to make. What a build can
 * do is fill the hold behind the view nobody has pressed a chip on: these are
 * the three reads that view makes, and their answers land in the same data cache
 * the running site reads from. Everything stays held for a minute exactly as
 * before, and a hold that has gone stale is handed over as it stands while it
 * refreshes behind the reader. So this decides one thing only: whether the first
 * visitor after a deploy waits for a scan of the index and a gateway read for
 * every row it walks past.
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
 * One of these reads, or what the build can carry on without.
 *
 * None of them changes what the site serves, only what is ready before the first
 * visitor asks: a list decides which pages exist ahead of time and every id
 * outside it still renders on demand, and the held view is rebuilt on the
 * request when it is missing. So an index that is slow or down at build time
 * costs one cold first visit, and must never cost the build itself.
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
      read(),
      new Promise<T>((_, fail) => {
        timer = setTimeout(() => fail(new Error(`it took longer than ${allowanceMs} ms`)), allowanceMs);
      }),
    ]);
  } catch (error) {
    console.log(`moolam: building ${missing}, ${reason(error)}`);
    return fallback;
  } finally {
    clearTimeout(timer);
  }
}
