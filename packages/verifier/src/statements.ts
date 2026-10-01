import { z } from "zod";
import type { Hex } from "./fingerprint.js";
import { MAX_PAGES, pageAddress } from "./webcheck/vision.js";

/**
 * The line a person swears to beside the sign button in the studio and on the co-sign page. Its
 * words and its version are pinned into the document the passkey signs the address of, so a later
 * change of wording is a new version, never a silent rewrite of what earlier passports said.
 */
export const SWORN_TEXT = "I made this picture, or I hold the rights to register it.";

export const SWORN_VERSION = 1;

/** The most a platform's own statement may weigh in UTF-8 bytes. */
export const MAX_PLATFORM_STATEMENT_BYTES = 1_000;

/**
 * The largest page count a document records. Vision is asked for fifty results, so a count past
 * this did not come from the web check.
 */
const MAX_SEEN_COUNT = 1_000;

// Letters, marks, digits, punctuation, symbols and the plain space, the rule a platform's name and
// a claims title are held to. Shuts out control, format, direction and line-break characters
// without a list of them. Does not catch look-alike letters from two scripts.
const PRINTABLE_TEXT = /^[\p{L}\p{M}\p{N}\p{P}\p{S} ]+$/u;

const PASSPORT_ID = /^0x[0-9a-f]{64}$/;

export const swornSchema = z.strictObject({ text: z.literal(SWORN_TEXT), version: z.literal(SWORN_VERSION) });

export type Sworn = z.infer<typeof swornSchema>;

/** A page address as the document stores it: exactly what pageAddress would make of itself. */
const storedPage = z.string().refine((page) => pageAddress(page) === page, "a page must be an http or https address with no query or fragment, at most 256 characters");

export const seenOnlineSchema = z
  .strictObject({
    count: z.number().int().min(1).max(MAX_SEEN_COUNT),
    pages: z.array(storedPage).min(1).max(MAX_PAGES),
  })
  .refine((seen) => seen.count >= seen.pages.length, "count must be at least the number of pages listed")
  .refine((seen) => new Set(seen.pages).size === seen.pages.length, "a page is listed once");

export type SeenOnline = z.infer<typeof seenOnlineSchema>;

/**
 * A platform's statement as the kit sent it: one line of printable text, at most
 * MAX_PLATFORM_STATEMENT_BYTES. It is refused rather than rewritten, because these are the
 * platform's words and the document carries them byte for byte.
 */
export const platformStatementSchema = z
  .string()
  .min(1)
  .refine((text) => Buffer.byteLength(text, "utf8") <= MAX_PLATFORM_STATEMENT_BYTES, `at most ${MAX_PLATFORM_STATEMENT_BYTES} bytes`)
  .refine((text) => PRINTABLE_TEXT.test(text), "one line of printable text, with no control or direction characters")
  .refine((text) => text.trim() === text, "no spaces at either end");

/**
 * What a passport's document says in the registrant's own voice (L21): the sworn line, or in
 * platform mode the platform's statement instead; the earlier passport the person was shown before
 * they went ahead; and the pages the web check found. Each is the registrant's statement, never a
 * chain fact, and is checked here before any document carrying it is pinned.
 */
const statementsSchema = z
  .strictObject({
    sworn: swornSchema.optional(),
    platformStatement: platformStatementSchema.optional(),
    seenEarlier: z.string().regex(PASSPORT_ID, "seenEarlier must be a passport id: 0x and 64 lower case hex characters").optional(),
    seenOnline: seenOnlineSchema.optional(),
  })
  .refine((words) => words.sworn === undefined || words.platformStatement === undefined, "a document carries the sworn line or the platform's statement, never both");

export type RegistrantStatements = z.infer<typeof statementsSchema>;

/** A document's statements did not pass their shape. Nothing carrying them may be pinned. */
export class StatementsRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StatementsRefused";
  }
}

export interface StatementsInput {
  /** "sworn" from the studio and the co-sign page; a platform's own words in platform mode; or nothing. */
  voice: "sworn" | { platformStatement: string } | "none";
  /** The earlier passport the prepare answer named as "found", if it did. */
  seenEarlier?: Hex;
  /** What the web check found, if it said "found". */
  seenOnline?: { count: number; pages: readonly string[] };
}

/**
 * Builds the statements for one document and hands back the schema's own output, so a key nobody
 * described cannot ride along. The earlier passport's id is lower-cased first, by the same rule
 * every passport id here goes through.
 *
 * Throws StatementsRefused naming each field that did not fit.
 */
export function registrantStatements(input: StatementsInput): RegistrantStatements {
  const parsed = statementsSchema.safeParse({
    ...(input.voice === "sworn" ? { sworn: { text: SWORN_TEXT, version: SWORN_VERSION } } : {}),
    ...(typeof input.voice === "object" ? { platformStatement: input.voice.platformStatement } : {}),
    ...(input.seenEarlier === undefined ? {} : { seenEarlier: input.seenEarlier.toLowerCase() }),
    ...(input.seenOnline === undefined ? {} : { seenOnline: { count: input.seenOnline.count, pages: [...input.seenOnline.pages] } }),
  });
  if (!parsed.success) {
    const detail = parsed.error.issues.map((issue) => `${issue.path.join(".") || "statements"}: ${issue.message}`).join("; ");
    throw new StatementsRefused(`these statements are not ones this service may pin: ${detail}`);
  }
  return parsed.data;
}
