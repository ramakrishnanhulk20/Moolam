import { plateSheet } from "@/components/explore/plates";
import { reason } from "@/lib/chain/client";
import { explorePassports, generatorStandings } from "@/lib/data/passports";
import { activeSource } from "@/lib/data/source";

/** How many of the newest rows the build looks through for real pictures. */
const PICTURE_CAP = 60;

/** How many generators the build builds a page for. It is the same cap the agents board reads. */
const AGENT_CAP = 50;

/** How long a build waits for one of these lists before it goes without it. */
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
  return await bounded("passport", async () => {
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
  return await bounded("agent", async () => {
    if (activeSource() !== "envio") {
      return [];
    }
    return (await generatorStandings(AGENT_CAP)).map((row) => row.id);
  });
}

/**
 * One of these lists, or nothing.
 *
 * The list only decides which pages exist before the first visitor asks for
 * one, and every id outside it still renders on demand. So an index that is
 * slow or down at build time costs one cold first visit, and must never cost
 * the build itself.
 */
async function bounded(what: string, read: () => Promise<string[]>): Promise<string[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      read(),
      new Promise<string[]>((_, fail) => {
        timer = setTimeout(() => fail(new Error(`it took longer than ${LIST_TIMEOUT_MS} ms`)), LIST_TIMEOUT_MS);
      }),
    ]);
  } catch (error) {
    console.log(`moolam: building with no ${what} list, ${reason(error)}`);
    return [];
  } finally {
    clearTimeout(timer);
  }
}
