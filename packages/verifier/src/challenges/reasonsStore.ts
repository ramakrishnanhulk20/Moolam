import { readFileSync } from "node:fs";
import { z } from "zod";
import { safeReason } from "../net/errorText.js";
import { writeJsonFile } from "../stateDir.js";
import { fitsDecisions, reasonsDocumentSchema, type ReasonsDocument } from "./reasons.js";

/** What the reasons file calls itself, so a file of another shape is refused rather than misread. */
export const REASONS_FILE_VERSION = 1;

/**
 * The most reasons documents this service keeps. Only the resolver can add one, and the route's
 * daily ceiling bounds how fast; reaching it closes new pins rather than dropping old ones.
 */
export const MAX_REASONS = 10_000;

const entrySchema = z.strictObject({
  reasonsURI: z.string().refine(fitsDecisions, "the address must fit MoolamDecisions"),
  document: reasonsDocumentSchema,
});

const fileSchema = z.strictObject({
  version: z.literal(REASONS_FILE_VERSION),
  reasons: z.array(entrySchema).max(MAX_REASONS),
});

export type ReasonsEntry = z.infer<typeof entrySchema>;

/** The store could not be believed at boot, or is full: nothing new is pinned, nothing is guessed. */
export class ReasonsStoreClosed extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReasonsStoreClosed";
  }
}

/**
 * What makes two reasons the same document: the decision (passport, openedAt, outcome), who signed
 * and the hash of the words. Deadline and signature are left out, so a fresh signature over the same
 * reasons finds the address already pinned.
 */
export function reasonsKey(document: Pick<ReasonsDocument, "passportId" | "openedAt" | "upheld" | "resolver" | "reasonsHash">): string {
  return [
    document.passportId.toLowerCase(),
    document.openedAt,
    document.upheld ? "upheld" : "rejected",
    document.resolver.toLowerCase(),
    document.reasonsHash.toLowerCase(),
  ].join(":");
}

/**
 * Every reasons document pinned for the resolver, keyed by reasonsKey (L28). Kept in a JSON file in
 * the data folder, written to a temp name and renamed into place like every other state file, and in
 * memory under a test runner. A file that is there and cannot be believed closes the store until an
 * operator looks.
 */
export class ReasonsStore {
  private readonly byKey = new Map<string, ReasonsEntry>();
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
      this.closedBecause = `the reasons file at ${file} could not be read`;
      log(this.closedBecause);
      return;
    }
    let parsed: z.infer<typeof fileSchema>;
    try {
      parsed = fileSchema.parse(JSON.parse(text));
    } catch {
      this.closedBecause = `the reasons file at ${file} is not a record this version reads`;
      log(this.closedBecause);
      return;
    }
    for (const entry of parsed.reasons) {
      this.byKey.set(reasonsKey(entry.document), entry);
    }
  }

  /** Why the store is closed, or undefined while it is open. */
  closed(): string | undefined {
    return this.closedBecause;
  }

  /** The entry already pinned under this key, or undefined. Throws ReasonsStoreClosed when closed. */
  find(key: string): ReasonsEntry | undefined {
    this.assertOpen();
    return this.byKey.get(key);
  }

  /**
   * Keeps one pinned document. Throws ReasonsStoreClosed when the store is closed or full. A key
   * already held keeps its first entry. A save that fails keeps the entry in memory and says so,
   * since the pin cannot be taken back.
   */
  add(entry: ReasonsEntry): void {
    this.assertOpen();
    if (this.byKey.size >= MAX_REASONS) throw new ReasonsStoreClosed("the reasons file is full");
    const checked = entrySchema.parse(entry);
    const key = reasonsKey(checked.document);
    if (this.byKey.has(key)) return;
    this.byKey.set(key, checked);
    if (this.file === undefined) return;
    try {
      writeJsonFile(this.file, { version: REASONS_FILE_VERSION, reasons: [...this.byKey.values()] });
    } catch (error) {
      this.log(`the reasons file could not be saved, the entry is kept in memory only: ${safeReason(error)}`);
    }
  }

  private assertOpen(): void {
    if (this.closedBecause !== undefined) throw new ReasonsStoreClosed(this.closedBecause);
  }
}
