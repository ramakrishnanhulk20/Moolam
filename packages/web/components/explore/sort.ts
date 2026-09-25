import type { PassportStatement } from "@/lib/data/passports";

/** One plate in the grid: a passport, the picture its metadata pointed at, and its three marks. */
export interface ExplorePlate {
  id: string;
  kind: number;
  /** Seconds since the epoch, as the chain recorded them. */
  registeredAt: number;
  title: string | null;
  thumbnailUrl: string | null;
  manifest: boolean;
  rechecked: boolean;
  /** True when the re-check on this passport came through the Chainlink receiver. */
  chainlink: boolean;
  /**
   * True when a dispute was upheld on this passport or on any picture it was
   * edited from. An edit of a picture proven fake reads clean on chain, and a
   * sheet that showed it clean would be the easiest way to launder one.
   */
  disputed: boolean;
  agentId: string | null;
  /**
   * What the holder has said about AI use, or null where nobody has spoken for
   * this picture. Silence is carried as null and drawn as nothing at all.
   */
  consent: PassportStatement | null;
  /**
   * True when the picture was registered without being published. Such a plate
   * has no thumbnail and never will: it is drawn as the record it is rather
   * than as a picture the gateway would not serve.
   */
  sealed?: boolean;
  /** The 256 bit block hash a sealed plate is drawn from, read from the pinned document. */
  blockhash?: string;
}

/**
 * The titles the scripts in packages/agents write when they put a test picture
 * on the registry: `Moolam seed 4` from scripts/seed.ts, `Moolam prove-it
 * 2026-09-09T...` from scripts/prove.ts, and `Moolam Privy proof, the edit`
 * from scripts/prove-privy.ts.
 */
const TEST_TITLE = /^moolam (seed|prove-it|privy proof)\b/i;

/**
 * Pictures the maintainer registered while trying the studio, named by id rather than by
 * title because their titles read like real work: "Iphone 18 pro max" and "Old
 * but strong". Their passports stay where they are and still open; they only
 * sort and count with the test cards. Ids are kept lower case.
 */
const TEST_IDS: ReadonlySet<string> = new Set([
  "0x864c33c6806185d4dc7acd65f465fc4c3cb6b8faaa157c32880cbef9dd93fc09",
  "0x980549624f85e4ef47043383c5a746cbdd1d82797b5b5583e1f5aeb3841d010c",
]);

/**
 * Whether a plate is one of the test cards those scripts wrote, or one of the
 * uploads named above.
 *
 * The title is what separates the scripts' cards. The agent id does not: the
 * seed script signs every card it writes with the demo generator, so "has a
 * generator" would call every seed card a real picture. A plate whose metadata
 * would not load has no title to judge, and those sort with the test cards
 * rather than above pictures a reader can actually see.
 *
 * The id is optional so a caller holding only a title still gets the title
 * rule; every caller that has the id should pass it, or the chips, the counts
 * and the order stop agreeing.
 */
export function isTestCard(title: string | null, id?: string | null): boolean {
  if (id !== undefined && id !== null && TEST_IDS.has(id.toLowerCase())) {
    return true;
  }
  const clean = (title ?? "").trim();
  return clean === "" || TEST_TITLE.test(clean);
}

/**
 * Newest first, with the real pictures ahead of the seed test cards.
 *
 * Nothing is dropped: a judge sees the same rows the index returned, in an
 * order the page states in one line above the grid. Ties inside a second fall
 * back to the id so the same set always lands in the same order.
 */
export function sortPlates<T extends { id: string; registeredAt: number; title: string | null }>(plates: T[]): T[] {
  return [...plates].sort((left, right) => {
    const rank = Number(isTestCard(left.title, left.id)) - Number(isTestCard(right.title, right.id));
    if (rank !== 0) {
      return rank;
    }
    if (left.registeredAt !== right.registeredAt) {
      return right.registeredAt - left.registeredAt;
    }
    return left.id < right.id ? 1 : left.id > right.id ? -1 : 0;
  });
}

/** Drops the plates already on screen, so a slow "load more" click cannot show one twice. */
export function mergePlates<T extends { id: string; registeredAt: number; title: string | null }>(
  held: T[],
  arriving: T[],
): T[] {
  const seen = new Set(held.map((plate) => plate.id));
  return sortPlates([...held, ...arriving.filter((plate) => !seen.has(plate.id))]);
}
