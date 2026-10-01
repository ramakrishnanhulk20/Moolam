import { readFileSync } from "node:fs";
import { z } from "zod";
import { safeReason } from "../net/errorText.js";
import { writeJsonFile } from "../stateDir.js";
import { answerDocumentSchema, type AnswerDocument } from "./answer.js";

/** What the answers file calls itself, so a file of another shape is refused rather than misread. */
export const ANSWER_FILE_VERSION = 1;

/**
 * The most answers this service keeps. One answer per dispute and every dispute costs its challenger
 * a 1 MON bond, so this is far past what the chain can produce in the life of this file; reaching it
 * closes new answers rather than dropping old ones.
 */
export const MAX_ANSWERS = 10_000;

const entrySchema = z.strictObject({
  digest: z.string().regex(/^0x[0-9a-f]{64}$/),
  answerURI: z.string().regex(/^ipfs:\/\/[A-Za-z0-9]+$/),
  document: answerDocumentSchema,
});

const fileSchema = z.strictObject({
  version: z.literal(ANSWER_FILE_VERSION),
  answers: z.array(entrySchema).max(MAX_ANSWERS),
});

export type AnswerEntry = z.infer<typeof entrySchema>;

/** The store could not be believed at boot, or is full: nothing new is accepted, nothing is guessed. */
export class AnswerStoreClosed extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AnswerStoreClosed";
  }
}

/** The key of one dispute: the passport and the second it was opened, which getDispute both answer. */
function disputeKey(passportId: string, openedAt: number): string {
  return `${passportId.toLowerCase()}:${openedAt}`;
}

/**
 * Every answer pinned for a dispute, one per dispute, with the digest each was signed over (L26,
 * L27). Kept in a JSON file in the data folder, written to a temp name and renamed into place like
 * every other state file, and in memory under a test runner. A file that is there and cannot be
 * believed closes the store: no answer is taken and none is shown until an operator looks.
 */
export class AnswerStore {
  private readonly byDispute = new Map<string, AnswerEntry>();
  private readonly digests = new Set<string>();
  private closedBecause: string | undefined;

  constructor(
    private readonly file: string | undefined,
    private readonly log: (line: string) => void = () => undefined,
  ) {
    if (file === undefined) return;
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      this.closedBecause = `the answers file at ${file} could not be read`;
      log(this.closedBecause);
      return;
    }
    let parsed: z.infer<typeof fileSchema>;
    try {
      parsed = fileSchema.parse(JSON.parse(text));
    } catch {
      this.closedBecause = `the answers file at ${file} is not a record this version reads`;
      log(this.closedBecause);
      return;
    }
    for (const entry of parsed.answers) {
      this.byDispute.set(disputeKey(entry.document.passportId, entry.document.openedAt), entry);
      this.digests.add(entry.digest);
    }
  }

  /** Why the store is closed, or undefined while it is open. */
  closed(): string | undefined {
    return this.closedBecause;
  }

  /** The answer pinned for this dispute, or undefined. Throws AnswerStoreClosed when closed. */
  answerFor(passportId: string, openedAt: number): AnswerEntry | undefined {
    this.assertOpen();
    return this.byDispute.get(disputeKey(passportId, openedAt));
  }

  /** Whether an answer was already accepted under this digest. Throws AnswerStoreClosed when closed. */
  usedDigest(digest: string): boolean {
    this.assertOpen();
    return this.digests.has(digest.toLowerCase());
  }

  /**
   * Keeps one pinned answer. Throws AnswerStoreClosed when the store is closed or full, and when the
   * dispute or the digest already has one, so a second caller racing the first cannot overwrite it.
   * A save that fails keeps the answer in memory and says so, since the pin cannot be taken back.
   */
  add(entry: { digest: string; answerURI: string; document: AnswerDocument }): void {
    this.assertOpen();
    if (this.byDispute.size >= MAX_ANSWERS) throw new AnswerStoreClosed("the answers file is full");
    const checked = entrySchema.parse({ ...entry, digest: entry.digest.toLowerCase() });
    const key = disputeKey(checked.document.passportId, checked.document.openedAt);
    if (this.byDispute.has(key) || this.digests.has(checked.digest)) {
      throw new AnswerStoreClosed("this dispute already has an answer");
    }
    this.byDispute.set(key, checked);
    this.digests.add(checked.digest);
    if (this.file === undefined) return;
    try {
      writeJsonFile(this.file, { version: ANSWER_FILE_VERSION, answers: [...this.byDispute.values()] });
    } catch (error) {
      this.log(`the answers file could not be saved, the answer is kept in memory only: ${safeReason(error)}`);
    }
  }

  private assertOpen(): void {
    if (this.closedBecause !== undefined) throw new AnswerStoreClosed(this.closedBecause);
  }
}
