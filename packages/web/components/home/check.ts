import type { TrySample } from "@/lib/data/samples";
import { verify } from "@/lib/verifier/client";
import { AnswerCard, type Stage } from "@/components/verify/AnswerCard";
import { chosenProblem, readAnswer, verifyProblem } from "@/components/verify/answer";
import { matchedPassport } from "@/components/verify/lookup";
import { fileFromSample } from "@/components/verify/sample";

/**
 * Everything the first screen's drop needs to run a check, and nothing it needs
 * to be drawn.
 *
 * Drop.tsx imports this only with import(), on the first press or drop, so the
 * card, the verify client and the chain reads behind the matched passport
 * (viem among them) are not part of what the home page sends before anyone
 * has asked for a check. The steps are the verify page's own, piece for piece.
 */

export { AnswerCard };

/** A file the reader chose or dropped, turned into the card's next face. */
export async function answerFor(file: File): Promise<Stage> {
  const problem = chosenProblem(file);
  if (problem !== null) {
    return { kind: "problem", problem: { ...problem, reason: file.name } };
  }
  try {
    const answer = readAnswer(await verify({ file }));
    const passport = answer.kind === "miss" ? null : await matchedPassport(answer.id);
    return { kind: "answer", answer, passport };
  } catch (error) {
    return { kind: "problem", problem: verifyProblem(error) };
  }
}

/** One of the three real passports, fetched as the file a reader would have dropped. */
export async function sampleFile(sample: TrySample): Promise<File | null> {
  try {
    return await fileFromSample(sample);
  } catch {
    return null;
  }
}
