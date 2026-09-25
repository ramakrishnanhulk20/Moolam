import type { StoryData } from "@/components/story/data";
import type { BeatCut } from "@/components/story/beats";

/**
 * Whether the film may tell the beat about the holder's word on AI use.
 *
 * Silence, a register that would not answer and a statement that speaks about
 * none of the four uses are three different things, and none of them is a
 * reason to invent a beat. In every one of them the film plays exactly as it
 * shipped. The reasons are named so a test can tell the four apart; the home
 * page says nothing about any of them.
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
 * The table the home page's chapter really plays, handed the day's data: the
 * stated cut when the register answered for the focal passport, the classic
 * cut otherwise.
 */
export function storyCut(data: StoryData): BeatCut {
  return statedBlock(data) === null ? "stated" : "classic";
}
