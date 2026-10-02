import type { StoryData } from "@/components/story/data";
import { beatTable, type BeatName } from "@/components/story/beats";

/**
 * Whether the film may tell the beat about the holder's terms for AI.
 *
 * Silence, a register that would not answer and a statement that speaks about
 * none of the four uses are three different things, and none of them is a
 * reason to invent a beat. In every one of them the film plays without the
 * terms beat and the asked beat that follows it. The reasons are named so a
 * test can tell the four apart; the home page says nothing about any of them.
 */
export type StatedBlock = "noPassport" | "readFailed" | "silence" | "nothingStated";

export function statedBlock(data: StoryData): StatedBlock | null {
  if (data.focal === null) {
    return "noPassport";
  }
  if (data.statementError !== null) {
    return "readFailed";
  }
  if (data.statement === null) {
    return "silence";
  }
  if (data.statement.summary === "none") {
    return "nothingStated";
  }
  return null;
}

/**
 * The one beat that needs the push-day deploys and has no read that could turn
 * it on: who a picture is waiting for is private, so the beat carries no figure
 * at all. It stays out of the film until the claim screens ship on the public
 * site, and this is the one place that changes on that day.
 */
export const WAITING_SHIPPED = false;

/**
 * The beats the day's data lets the film tell, in playing order.
 *
 * A beat is in only when the read behind it succeeded and the thing it shows
 * is live: the terms and the asked beat need a statement the register really
 * answered; the checked beat needs this passport's own Chainlink verdict; the
 * look-alike beat a network record with two pictures; the sign-it-yourself beat
 * a co-signed picture. The rest are in every cut.
 */
export function filmCut(data: StoryData): BeatName[] {
  const stated = statedBlock(data) === null;
  const beats: (BeatName | false)[] = [
    "opening",
    data.focal !== null && "imagined",
    "sealed",
    stated && "stated",
    stated && "asked",
    "shared",
    "verified",
    data.check !== undefined && data.check !== null && "checked",
    data.lookalike !== undefined && data.lookalike !== null && "lookalike",
    data.yourself !== undefined && data.yourself !== null && "yourself",
    WAITING_SHIPPED && "waiting",
    "offer",
    "close",
  ];
  return beats.filter((beat): beat is BeatName => beat !== false);
}

/**
 * How many screens of page the film's section takes on the day's data: the
 * cut's pages, as the film writes them onto its section. The box that holds
 * the film's place asks for the same number, so the page below it has already
 * made room by the time the film arrives.
 */
export function filmPages(data: StoryData): number {
  return beatTable(filmCut(data)).pages;
}
