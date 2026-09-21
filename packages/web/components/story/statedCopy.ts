import type { Statement } from "@/lib/chain/consent";
import type { StoryData } from "@/components/story/data";

/**
 * The words of the stated beat, in English, in one place.
 *
 * The bench is English only. When Ram says the beat joins the film these lines
 * move into the ten message files and this module goes; keeping them here means
 * the bench never waits on a translation to be looked at, and nothing on the
 * home page can reach them in the meantime.
 */

/** The five plain summaries, the same vocabulary the passport card speaks. */
const SUMMARY: Record<Statement, string> = {
  open: "Open to AI use",
  closed: "Not for AI training",
  ask: "Ask the holder first",
  mixed: "Stated use by use",
  none: "Nothing stated yet",
};

export const STATED_COPY = {
  kicker: "Stated",
  /** The statement's own summary, said as a sentence. */
  title: (summary: Statement) => `${SUMMARY[summary]}.`,
  body:
    "Its maker's word on AI use went on Monad beside the passport, with the date. " +
    "Ask the chain about any day since, and it answers for that day.",
  /** The small mono line, the way the other beats quote a block or a passport. */
  readout: (written: string) => `Statement written on Monad ${written}, and in force ever since`,
  registered: "Registered",
  today: "Today",
  /** The four uses, short enough to sit under a mark. */
  uses: ["AI training", "Generative AI", "Inference", "Data mining"],
  bench: {
    stated: "Stated cut",
    classic: "Classic cut",
    toStated: "Play the stated cut",
    toClassic: "Back to the classic cut",
  },
} as const;

/**
 * Why the stated beat cannot be played, or null when it can.
 *
 * Silence, a register that would not answer and a statement that speaks about
 * none of the four uses are three different sentences, and none of them is a
 * reason to invent a beat. In every one of them the bench plays the film
 * exactly as it ships and says this line above it.
 */
export function statedWhyNot(data: StoryData): string | null {
  if (data.focal === null) {
    return "No passport could be read just now, so there is no statement to tell this beat with. This is the classic film.";
  }
  if (data.statementError !== null) {
    return `The consent register did not answer: ${data.statementError}. This is the classic film.`;
  }
  if (data.statement === null) {
    return "Nobody has written a statement for this passport, so there is nothing to show. This is the classic film.";
  }
  if (data.statement.summary === "none") {
    return "The statement on this passport speaks about none of the four uses, so there is nothing to draw. This is the classic film.";
  }
  return null;
}
