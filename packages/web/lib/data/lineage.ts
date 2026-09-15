import { unstable_cache } from "next/cache";
import type { Hex } from "viem";
import { CACHE_TAGS, HOLD_SECONDS } from "@/lib/chain/client";
import { activeSource, envioUrl } from "./source";

/**
 * How far up the edit chain a walk looks.
 *
 * The registry marks only the passport a challenge named, so whether an edit
 * sits under a disputed picture is a question about its ancestors. A nested
 * query has to name its own depth, and eight is far deeper than anything on the
 * registry today, where the longest lineage is one edit above its picture.
 */
export const LINEAGE_DEPTH = 8;

/** The index field that answers this on its own, once the hosted index redeploys with it. */
const INHERITED_FIELD = "inheritedDisputed";

/** How long the index's schema is taken at its word before it is asked again. */
const SCHEMA_HOLD_SECONDS = 3_600;

/** How many disputed passports one derivation starts from. */
const DISPUTED_CAP = 200;

/** How many rows of their edit trees it then walks. */
const FAMILY_CAP = 1_000;

/**
 * How the Disputed chip gets its rows.
 *
 * "field" is the index's own inheritedDisputed column, which needs no walk at
 * all. A list of ids is the same answer worked out here from the parent links
 * the index already stores, which is what a hosted index that has not
 * redeployed with that column yet can give.
 */
export type DisputedReach = "field" | { ids: readonly string[] };

/** One row of an edit tree, as the walk needs it. */
export interface FamilyRow {
  id: string;
  parentId: string | null;
  disputed: boolean;
}

/** A passport and its ancestors, nested the way the index returns them. */
export interface AncestorRow {
  disputed: boolean;
  parent?: AncestorRow | null;
}

/**
 * True when this passport was disputed, or when any picture it was edited from
 * was.
 *
 * On chain only the passport a challenge named carries the mark, so an edit of
 * a picture proven fake reads clean there. The index answers this itself once
 * it has redeployed with inheritedDisputed. Until then the answer is walked out
 * of the parent links it already stores, which costs one query either way.
 *
 * Throws when no index is configured or it will not answer, so a caller can
 * tell "no ancestor is disputed" from "nobody could say".
 */
export async function inheritedDisputed(id: Hex | string): Promise<boolean> {
  const key = id.toLowerCase();
  try {
    return await heldInherited(key);
  } catch (error) {
    if (noCache(error)) {
      return await readInherited(key);
    }
    throw error;
  }
}

const heldInherited = unstable_cache(async (id: string) => await readInherited(id), ["moolam-inherited-disputed"], {
  revalidate: HOLD_SECONDS,
  tags: [CACHE_TAGS.index],
});

async function readInherited(id: string): Promise<boolean> {
  return (await hasInheritedField()) ? await readInheritedField(id) : await walkAncestors(id);
}

async function readInheritedField(id: string): Promise<boolean> {
  const data = await ask<{ Passport: { inheritedDisputed: boolean }[] }>(
    `query InheritedDisputedField($id: String!) {
      Passport(where: { id: { _eq: $id } }, limit: 1) { ${INHERITED_FIELD} }
    }`,
    { id },
  );
  return data.Passport[0]?.inheritedDisputed === true;
}

async function walkAncestors(id: string): Promise<boolean> {
  const data = await ask<{ Passport: AncestorRow[] }>(
    `query InheritedDisputed($id: String!) {
      Passport(where: { id: { _eq: $id } }, limit: 1) {
        id
        disputed
        ${parentSelection(LINEAGE_DEPTH)}
      }
    }`,
    { id },
  );
  return anyDisputed(data.Passport[0]);
}

/** One nested parent block per edit the walk looks above the picture. */
function parentSelection(depth: number): string {
  return depth === 0 ? "" : `parent { id disputed ${parentSelection(depth - 1)} }`;
}

/** Whether a passport or anything above it in the nested answer carries the mark. */
export function anyDisputed(row: AncestorRow | null | undefined): boolean {
  let at = row ?? null;
  for (let step = 0; step <= LINEAGE_DEPTH && at !== null; step += 1) {
    if (at.disputed) {
      return true;
    }
    at = at.parent ?? null;
  }
  return false;
}

/**
 * Which ids the Disputed chip covers, and how the index was able to answer.
 *
 * The chip cannot walk a chain per row: that would be a query for every plate
 * on the sheet. It starts from the other end instead. The disputed passports
 * are one indexed read, their edit trees are a second read on the root each of
 * them shares with its own edits, and the walk then runs over that small set in
 * memory. With nothing disputed on the registry the second read is skipped and
 * the chip asks for an empty list, which is the honest answer.
 */
export async function disputedReach(): Promise<DisputedReach> {
  try {
    return await heldReach();
  } catch (error) {
    if (noCache(error)) {
      return await readReach();
    }
    throw error;
  }
}

const heldReach = unstable_cache(async () => await readReach(), ["moolam-disputed-reach"], {
  revalidate: HOLD_SECONDS,
  tags: [CACHE_TAGS.index],
});

async function readReach(): Promise<DisputedReach> {
  if (await hasInheritedField()) {
    return "field";
  }

  const disputed = await ask<{ Passport: { id: string; root_id: string }[] }>(
    `query DisputedPassports($cap: Int!) {
      Passport(where: { disputed: { _eq: true } }, limit: $cap) { id root_id }
    }`,
    { cap: DISPUTED_CAP },
  );

  const roots = [...new Set(disputed.Passport.map((row) => row.root_id))];
  if (roots.length === 0) {
    return { ids: [] };
  }

  const family = await ask<{ Passport: { id: string; parent_id: string | null; disputed: boolean }[] }>(
    `query DisputedFamilies($roots: [String!]!, $cap: Int!) {
      Passport(where: { root_id: { _in: $roots } }, limit: $cap) { id parent_id disputed }
    }`,
    { roots, cap: FAMILY_CAP },
  );

  return {
    ids: disputedFamily(
      family.Passport.map((row) => ({ id: row.id, parentId: row.parent_id, disputed: row.disputed })),
    ),
  };
}

/**
 * Every passport in these edit trees that is disputed or was edited from one
 * that is.
 *
 * A row whose parent is not in the set stops the climb: the rows come from the
 * roots of the disputed passports, so anything missing is outside the cap
 * rather than above them.
 */
export function disputedFamily(rows: readonly FamilyRow[]): string[] {
  const byId = new Map(rows.map((row) => [row.id, row]));

  return rows
    .filter((row) => {
      let at: FamilyRow | undefined = row;
      for (let step = 0; step <= LINEAGE_DEPTH && at !== undefined; step += 1) {
        if (at.disputed) {
          return true;
        }
        at = at.parentId === null ? undefined : byId.get(at.parentId);
      }
      return false;
    })
    .map((row) => row.id);
}

/** Whether one row is covered by the reach this render worked out. */
export function reaches(reach: DisputedReach | undefined, row: { id: string; inheritedDisputed?: boolean }): boolean {
  if (reach === undefined) {
    return false;
  }
  return reach === "field" ? row.inheritedDisputed === true : reach.ids.includes(row.id);
}

/**
 * Whether this index has the inheritedDisputed field yet, asked once an hour.
 *
 * A schema is the one thing about an index that does not change between
 * deploys, and the cost of guessing wrong is an error on every query, so it is
 * asked rather than assumed. An introspection that fails answers no, which is
 * the path that works on either schema.
 */
export async function hasInheritedField(): Promise<boolean> {
  if (activeSource() !== "envio") {
    return false;
  }
  try {
    return await heldSchema();
  } catch (error) {
    if (noCache(error)) {
      return await readSchema();
    }
    throw error;
  }
}

const heldSchema = unstable_cache(async () => await readSchema(), ["moolam-index-schema"], {
  revalidate: SCHEMA_HOLD_SECONDS,
  tags: [CACHE_TAGS.index],
});

async function readSchema(): Promise<boolean> {
  try {
    const data = await ask<{ __type: { fields: { name: string }[] } | null }>(
      `query IndexSchema { __type(name: "Passport") { fields { name } } }`,
      {},
    );
    return (data.__type?.fields ?? []).some((field) => field.name === INHERITED_FIELD);
  } catch {
    return false;
  }
}

/** One query to the index, with the endpoint's own words on any failure. */
async function ask<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const response = await fetch(envioUrl(), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(10_000),
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`the Envio endpoint answered ${response.status}`);
  }

  const body = (await response.json()) as { errors?: { message: string }[]; data?: T };
  if (body.errors !== undefined && body.errors.length > 0) {
    throw new Error(body.errors.map((entry) => entry.message).join("; "));
  }
  if (body.data === undefined) {
    throw new Error("the Envio endpoint returned no data block");
  }
  return body.data;
}

/**
 * Whether a held read failed only because there is no cache to hold it in.
 *
 * Next's cache needs a request to hang off, and a unit test has none. Anything
 * else is a real failure and is passed on rather than quietly read twice.
 */
function noCache(error: unknown): boolean {
  return (error as Error | undefined)?.message?.includes("incrementalCache") === true;
}
