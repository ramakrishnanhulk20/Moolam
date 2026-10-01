import { unstable_cache } from "next/cache";
import { getAddress, type Hex } from "viem";
import { z } from "zod";
import { CACHE_TAGS, HOLD_SECONDS } from "@/lib/chain/client";
import { ZERO_ID, heldPassportRecord, passportTag, type Passport } from "@/lib/chain/registry";
import { verifierUrl } from "@/lib/verifier/client";

/** The earlier passport Moolam's own search proposes, before Chainlink has said anything. */
export interface SearchedEarlier {
  id: Hex;
  registeredAt: number;
  metadataURI: string;
}

const answerSchema = z.union([
  z.object({ status: z.literal("ok"), candidates: z.array(z.string().regex(/^0x[0-9a-fA-F]{64}$/)).max(3) }),
  z.object({ status: z.literal("not-ready") }),
]);

const SEARCH_TIMEOUT_MS = 6_000;

/** The service did not answer the search, or was not ready to: never held, never drawn. */
class SearchSilent extends Error {
  constructor() {
    super("the verify service did not answer the look-alike search");
    this.name = "SearchSilent";
  }
}

/**
 * Asks the verify service's candidates route, the same one Chainlink's nodes
 * ask, which passports registered before this one carry fingerprints within the
 * shared thresholds, oldest first. Throws SearchSilent for a service that is
 * not ready or did not answer: this line is a search, and its silence claims
 * nothing.
 */
async function readCandidates(passport: Passport): Promise<Hex[]> {
  let response: Response;
  try {
    response = await fetch(verifierUrl("/lookalikes/candidates"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        fingerprints: [{ phash: `0x${passport.phash.toString(16).padStart(16, "0")}`, blockhash: passport.blockhash256 }],
        asOf: Number(passport.registeredAt),
      }),
      signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
      cache: "no-store",
    });
  } catch {
    throw new SearchSilent();
  }
  if (!response.ok) {
    throw new SearchSilent();
  }
  const parsed = answerSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success || parsed.data.status !== "ok") {
    throw new SearchSilent();
  }
  return parsed.data.candidates.map((id) => id.toLowerCase() as Hex);
}

/**
 * The first candidate that passes the workflow's own tests, read on chain
 * here: registered strictly earlier, by another creator, and only ever for an
 * original, since an edited passport skips the look-alike step (L8, L9, L10).
 * A candidate the chain will not hand over is passed over.
 */
async function firstEarlier(passport: Passport): Promise<SearchedEarlier | null> {
  if (passport.parentId !== ZERO_ID) {
    return null;
  }
  const candidates = await readCandidates(passport);
  for (const id of candidates) {
    let other: Passport | null;
    try {
      other = (await heldPassportRecord(id)).passport;
    } catch {
      continue;
    }
    if (other === null || other.registeredAt >= passport.registeredAt) {
      continue;
    }
    if (getAddress(other.creator) === getAddress(passport.creator)) {
      continue;
    }
    return { id, registeredAt: Number(other.registeredAt), metadataURI: other.metadataURI };
  }
  return null;
}

/**
 * The same search, held for a minute under this passport's name, so a page
 * read by many people costs the service one question a minute. An answer is
 * held, found or not; a silent service is asked again on the next render.
 */
export async function heldSearchedEarlier(passport: Passport): Promise<SearchedEarlier | null> {
  const held = unstable_cache(
    async () => ({ found: await firstEarlier(passport) }),
    ["moolam-searched-earlier", passport.id.toLowerCase()],
    { revalidate: HOLD_SECONDS, tags: [CACHE_TAGS.index, passportTag(passport.id)] },
  );
  try {
    return (await held()).found;
  } catch {
    // Outside a Next request there is nowhere to hold the answer, and a search
    // asked afresh on every render would put one question to the service per
    // view. The line is only a search, so it is left out there.
    return null;
  }
}
