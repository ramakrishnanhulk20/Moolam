import { unstable_cache } from "next/cache";
import type { Hex } from "viem";
import { isTestCard } from "@/components/explore/sort";
import { plateUnread } from "@/components/explore/unread";
import { CACHE_TAGS, HOLD_SECONDS } from "@/lib/chain/client";
import { isChainlinkReceiver } from "@/lib/chain/receivers";
import { anyDisputed, LINEAGE_DEPTH, type AncestorRow } from "@/lib/data/lineage";
import { askIndex, heldArt, NO_MANIFEST } from "@/lib/data/passports";
import type { PlateMarks } from "./Marks";

/** How many pictures a row of the board carries under the agent's name. */
export const STRIP_PLACES = 5;

/**
 * How many of each agent's newest passports are read to find them. The same
 * dozen the lab bench measured: enough to get past a run of test images, and
 * every document read is held for a day, so the agent page reads none twice.
 */
export const STRIP_SCAN = 12;

/** As many agents as the board lists, so every row the roster draws has its strip. */
const STRIP_AGENTS = 50;

/** One picture on the strip: enough to draw the tile as Explore would, and nothing else. */
export interface StripTile extends PlateMarks {
  id: Hex;
  title: string | null;
  thumbnailUrl: string | null;
}

/** What one row of the board draws under the agent's name. */
export interface AgentStrip {
  /** Its newest real pictures, newest first, at most STRIP_PLACES of them. */
  tiles: StripTile[];
  /**
   * True only when every passport this agent has signed was read, none of them
   * can be drawn, and every one that holds a picture is a test image. A record
   * whose document never loads holds no picture to count; a sealed one is a real
   * picture kept out of sight, so it keeps this false. A window that stopped
   * short proves nothing about the rows it did not reach, so it never says this.
   */
  onlyTest: boolean;
}

/** One passport under a generator, exactly as the index sends it. */
interface StripRow extends AncestorRow {
  id: Hex;
  metadataURI: string;
  manifestHash: string;
  disputed: boolean;
  attestationCount: number;
  attestations: { receiver: string }[];
}

interface GeneratorStrip {
  id: string;
  passportCount: number;
  passports: StripRow[];
}

/** One nested parent per step up the edit chain, so an edit of a disputed picture lights its D as on Explore. */
function parentSelection(depth: number): string {
  return depth === 0 ? "" : `parent { disputed ${parentSelection(depth - 1)} }`;
}

/**
 * Every agent's newest passports in one question to the index.
 *
 * The passports hang off each generator row, so the whole board is one query
 * however many agents it lists, rather than one per row. The same order and
 * the same cap as the roster, so the two lists name the same agents. The
 * ancestor walk is asked for inside the same query instead of reading the
 * inherited mark, which works on the index with or without that column.
 */
export const STRIP_QUERY = `query AgentStrips($agents: Int!, $scan: Int!) {
  Generator(order_by: [{ passportCount: desc }, { trustScore: desc }], limit: $agents) {
    id
    passportCount
    passports(order_by: [{ registeredAt: desc }, { id: desc }], limit: $scan) {
      id
      metadataURI
      manifestHash
      disputed
      attestationCount
      attestations(limit: 5) { receiver }
      ${parentSelection(LINEAGE_DEPTH)}
    }
  }
}`;

async function stripRows(): Promise<GeneratorStrip[]> {
  const data = await askIndex<{ Generator: GeneratorStrip[] }>(STRIP_QUERY, {
    agents: STRIP_AGENTS,
    scan: STRIP_SCAN,
  });
  return data.Generator;
}

/**
 * The same answer held for a minute, like the roster beside it, so the ten
 * languages the build makes and every visitor inside that minute share one
 * read. Everything in it is a string, a number or a flag, so it can be held.
 * The newest registration is part of the name, so a new passport is on the
 * strips at once (components/agents/fresh.ts).
 */
function heldStripRows(newest: string): Promise<GeneratorStrip[]> {
  const held = unstable_cache(stripRows, ["moolam-agent-strips", String(STRIP_AGENTS), String(STRIP_SCAN), newest], {
    revalidate: HOLD_SECONDS,
    tags: [CACHE_TAGS.index],
  });
  return held();
}

/**
 * The strip for every agent on the board, by agent id.
 *
 * The index says which passports; the pinned documents say which of them are
 * real pictures, by the same rule Explore sorts with. Those documents are held
 * for a day, so after the first visitor this costs the gateway nothing.
 */
export async function boardStrips(newest = ""): Promise<Record<string, AgentStrip>> {
  const generators = await heldStripRows(newest);
  const strips = await Promise.all(generators.map(async (generator) => [generator.id, await stripOf(generator)] as const));
  return Object.fromEntries(strips);
}

/** One passport with its picture, judged real or test. */
interface ReadTile extends StripTile {
  test: boolean;
}

async function stripOf(generator: GeneratorStrip): Promise<AgentStrip> {
  const read = await Promise.all(
    generator.passports.map(async (row): Promise<ReadTile> => {
      const art = row.metadataURI === "" ? null : await heldArt(row.metadataURI, row.id);
      const title = art?.title ?? null;
      return {
        id: row.id,
        title,
        thumbnailUrl: art?.thumbnailUrl ?? null,
        manifest: row.manifestHash.toLowerCase() !== NO_MANIFEST,
        rechecked: row.attestationCount > 0,
        chainlink: row.attestations.some((one) => isChainlinkReceiver(one.receiver)),
        disputed: anyDisputed(row),
        sealed: art?.sealed === true,
        test: isTestCard(title, row.id, plateUnread(row.metadataURI, art)),
      };
    }),
  );

  const complete = generator.passports.length < STRIP_SCAN || generator.passports.length >= generator.passportCount;
  return pickStrip(read, complete);
}

/**
 * The tiles a row draws, out of the passports read for it, newest first.
 *
 * Only a picture that can be drawn takes a place. A sealed one is real with
 * nothing to look at, and a record that was not read, or was read and names
 * no picture, would be a tile holding only the seal; each of them is one press
 * away on Explore. `complete` says whether the read reached the agent's oldest
 * passport.
 */
export function pickStrip(read: (StripTile & { test: boolean })[], complete: boolean): AgentStrip {
  const tiles = read
    .filter((tile) => !tile.test && tile.sealed !== true && tile.thumbnailUrl !== null)
    .slice(0, STRIP_PLACES)
    .map((tile) => ({
      id: tile.id,
      title: tile.title,
      thumbnailUrl: tile.thumbnailUrl,
      manifest: tile.manifest,
      rechecked: tile.rechecked,
      chainlink: tile.chainlink,
      disputed: tile.disputed,
      sealed: tile.sealed,
    }));

  return {
    tiles,
    onlyTest:
      tiles.length === 0 &&
      complete &&
      read.some((tile) => tile.test) &&
      read.every((tile) => tile.test || (tile.thumbnailUrl === null && tile.sealed !== true)),
  };
}
