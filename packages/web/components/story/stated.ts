import type { StoryData } from "@/components/story/data";
import type { StoryVariant } from "@/components/story/beats";

/**
 * Whether the film may tell the beat about the holder's word on AI use.
 *
 * Silence, a register that would not answer and a statement that speaks about
 * none of the four uses are three different things, and none of them is a
 * reason to invent a beat. In every one of them the film plays exactly as it
 * shipped. The reasons are named rather than written out because the home page
 * says nothing about them at all and the bench says all four in English.
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
 * The cut a screen really plays, asked for one cut and handed the day's data.
 *
 * The home page and the bench both go through here, so a day with nothing
 * stated on the focal passport cannot put a different film on the two of them.
 */
export function storyCut(wanted: StoryVariant, data: StoryData): StoryVariant {
  return wanted === "stated" && statedBlock(data) === null ? "stated" : "classic";
}
