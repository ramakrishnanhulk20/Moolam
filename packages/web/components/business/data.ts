import { readFile } from "node:fs/promises";
import path from "node:path";
import { codeToTokens } from "shiki";
import type { Hex } from "viem";
import { reason } from "@/lib/chain/client";
import { heldPassportRecord } from "@/lib/chain/registry";
import { heldArt, heldGeneratorRecord, heldRegistryCounts } from "@/lib/data/passports";
import { heldPlatformList, labelFrom, listedAgentOwner, plateMark } from "@/lib/data/platform-label";
import { pictureSources } from "@/lib/images";
import { MCP_CODE, STEP_CODE } from "./code";
import { DEMO_PASSPORT, DREAMLOOM_URL } from "./content";

/** One count the page prints, or null when its read failed and nothing is printed. */
export interface LiveFigures {
  /** Dreamloom as Moolam's signed list names it, matched by its live address. */
  platform: { name: string; agentId: string } | null;
  platforms: number | null;
  platformPassports: number | null;
  totalPassports: number | null;
  stated: number | null;
  errors: string[];
}

/** The attack pass's own last line, parsed from the transcript rather than typed into the page. */
export interface AttackTally {
  attacks: number;
  refused: number;
  controls: number;
  findings: number;
}

/** A code token with both themes' colours, the way the docs paint theirs. */
export interface CodeToken {
  content: string;
  style: Record<string, string>;
}

export type CodeLines = CodeToken[][];

export interface Snippets {
  steps: CodeLines[];
  mcp: CodeLines;
}

/** The demo's real picture: where the pinned file can be read, and the title it was registered under. */
export interface DemoPicture {
  id: Hex;
  title: string | null;
  sources: string[];
}

export interface BusinessData {
  live: LiveFigures;
  tally: AttackTally | null;
  snippets: Snippets;
  /** Null when any read behind it failed or the passport no longer qualifies; the demo then draws its plain plate. */
  picture: DemoPicture | null;
}

/**
 * The live figures, each through a read the site already holds for a minute:
 * the registry counts Explore prints, the generator row the agent page prints,
 * and the signed platform list the passport pages label with. Each read fails
 * on its own.
 */
export async function liveFigures(): Promise<LiveFigures> {
  const errors: string[] = [];
  const list = await heldPlatformList();
  const current = list.ok ? list.platforms.filter((entry) => entry.validTo === null) : [];
  const found = current.find((entry) => entry.origins.includes(DREAMLOOM_URL)) ?? null;
  if (!list.ok) {
    errors.push(list.reason);
  }

  const [counts, generator] = await Promise.allSettled([
    heldRegistryCounts(),
    found === null ? Promise.resolve(null) : heldGeneratorRecord(found.agentId),
  ]);
  if (counts.status === "rejected") {
    errors.push(reason(counts.reason));
  }
  if (generator.status === "rejected") {
    errors.push(reason(generator.reason));
  }

  return {
    platform: found === null ? null : { name: found.name, agentId: found.agentId.toString() },
    platforms: list.ok ? current.length : null,
    platformPassports: generator.status === "fulfilled" && generator.value !== null ? generator.value.passportCount : null,
    totalPassports: counts.status === "fulfilled" ? counts.value.total : null,
    stated: counts.status === "fulfilled" ? counts.value.stated : null,
    errors,
  };
}

const TALLY = /^attacks (\d+): (\d+) REFUSED, (\d+) PASSED \(positive controls\), (\d+) NOT AS EXPECTED$/m;

/** Reads the tally line of the platform kit's attack pass, or null when the line is missing. */
export function parseTally(transcript: string): AttackTally | null {
  const match = TALLY.exec(transcript);
  if (match === null) {
    return null;
  }
  const [attacks, refused, controls, findings] = match.slice(1).map(Number);
  return { attacks, refused, controls, findings };
}

/**
 * The two places the transcript can sit: under the directory the app runs
 * from when that is the repo root, and two levels up when it is this package.
 * Written out rather than found by a walk so the server's file tracing can see
 * the paths, and nothing here throws when neither exists: the docs' own finder
 * does, which would take the whole page down with a missing file.
 */
const TRANSCRIPT = [
  path.join(process.cwd(), "proofs", "attacks", "pass-kit.txt"),
  path.join(process.cwd(), "..", "..", "proofs", "attacks", "pass-kit.txt"),
];

export async function attackTally(): Promise<AttackTally | null> {
  for (const file of TRANSCRIPT) {
    try {
      return parseTally(await readFile(file, "utf8"));
    } catch {
      // The next place is tried, and a page with neither says it could not read the pass.
    }
  }
  return null;
}

async function highlight(code: string, lang: "ts" | "bash"): Promise<CodeLines> {
  const { tokens } = await codeToTokens(code, {
    lang,
    themes: { light: "github-light", dark: "github-dark" },
    defaultColor: false,
  });
  return tokens.map((line) =>
    line.map((token) => ({
      content: token.content,
      style: Object.fromEntries(Object.entries(token.htmlStyle ?? {}).map(([key, value]) => [key, String(value)])),
    })),
  );
}

/** The code is coloured on the server with the docs' own two themes, so nothing ships a highlighter. */
export async function snippets(): Promise<Snippets> {
  const [steps, mcp] = await Promise.all([
    Promise.all(STEP_CODE.map((code) => highlight(code, "ts"))),
    highlight(MCP_CODE, "bash"),
  ]);
  return { steps, mcp };
}

/**
 * The demo passport's picture, by the same rule every passport page draws its
 * picture with: the chain's record held for a minute, the pinned document held
 * by its content address, and the gateway list the site reads pictures from.
 *
 * It is shown only while the passport wears Dreamloom's mark by the rule
 * Explore and the agent page mark Dreamloom's pictures with (plateMark: the
 * kit label, or the credit a co-signed picture earns), only while it was
 * signed by Dreamloom's own agent, and only while nobody has a dispute open on it. A sealed record, a missing
 * document or any failed read gives null, never a picture that may not load.
 */
export async function demoPicture(): Promise<DemoPicture | null> {
  try {
    const list = await heldPlatformList();
    const dreamloom = list.ok
      ? list.platforms.find((entry) => entry.validTo === null && entry.origins.includes(DREAMLOOM_URL))
      : undefined;
    if (dreamloom === undefined) {
      return null;
    }
    const { passport } = await heldPassportRecord(DEMO_PASSPORT);
    if (passport === null || passport.disputed) {
      return null;
    }
    // The agent's owner is read only for a passport the list does not label
    // by its creator, the co-signed case, exactly as Explore's plates read it.
    const agentOwnerNow =
      labelFrom(list, passport) === null ? await listedAgentOwner(list, passport.generatorAgentId) : null;
    if (plateMark(list, passport, agentOwnerNow) !== dreamloom.name || passport.generatorAgentId !== dreamloom.agentId) {
      return null;
    }
    const art = await heldArt(passport.metadataURI, passport.id);
    const url = art.imageUrl ?? art.thumbnailUrl;
    if (art.missing || art.sealed === true || url === undefined) {
      return null;
    }
    // A title typed as a sentence keeps its full stop, which would sit doubled
    // in the alt text the title is set into.
    const title = (art.title ?? "").trim().replace(/[.\s]+$/, "");
    return { id: passport.id, title: title === "" ? null : title, sources: pictureSources(url) };
  } catch {
    return null;
  }
}

export async function businessData(): Promise<BusinessData> {
  const [live, tally, code, picture] = await Promise.all([liveFigures(), attackTally(), snippets(), demoPicture()]);
  return { live, tally, snippets: code, picture };
}
