/**
 * Everything a sealed passport makes public, in the order a creator should read
 * it, with the plain sentence that says why each one is there.
 *
 * This list is the studio's promise, so it is not written twice. Every row
 * whose source is the pinned file names a top level key of the sealed metadata
 * schema in packages/verifier/src/sealed.ts, and the test holds the two
 * together key for key: a field added to that document and not to this list
 * would be something the creator was never shown before they signed.
 *
 * The wallet is the one row that is not in that document. It goes on Monad, as
 * the registry's creator, which is just as public and would be a strange thing
 * to leave off a list headed "what becomes public".
 */

/** Where the value lands: in the one pinned file, or in the registry record itself. */
export type SealedFieldSource = "document" | "chain";

/**
 * When a row applies: to every sealed registration, only to a drawn picture, or
 * only while the creator has asked for a private re-check.
 */
export type SealedFieldWhen = "always" | "generated" | "privateRecheck";

export interface SealedPublicField {
  /** The key in the sealed document, or the registry's own name for the value. */
  key: string;
  source: SealedFieldSource;
  when: SealedFieldWhen;
  /** What it is, in the creator's words. English here; a caller may pass its own. */
  label: string;
  /** Why it is public, in one line. */
  line: string;
  /**
   * True for the one row the creator decides: the prompt is left out of the
   * document unless they ask for it, so it is listed and marked rather than
   * hidden until it appears.
   */
  optional?: boolean;
}

export const SEALED_PUBLIC_FIELDS: SealedPublicField[] = [
  {
    key: "commitment",
    source: "document",
    when: "always",
    label: "The passport id",
    line: "The sha-256 of the file we hand back. The chain commits to the exact bytes without showing them.",
  },
  {
    key: "fingerprint",
    source: "document",
    when: "always",
    label: "The two fingerprints",
    line: "A 64 bit perceptual hash, and the 16 by 16 block hash drawn above. Rough light and dark, nothing finer.",
  },
  {
    key: "name",
    source: "document",
    when: "always",
    label: "The title you type",
    line: "Whatever you name it is the name everyone reads, so name it with that in mind.",
  },
  {
    key: "description",
    source: "document",
    when: "always",
    label: "The line Moolam writes",
    line: "One fixed sentence saying how this passport was made. It never describes the picture.",
  },
  {
    key: "creator",
    source: "chain",
    when: "always",
    label: "Your wallet address",
    line: "The registry records who registered it, the way it does for every passport.",
  },
  {
    key: "generator",
    source: "document",
    when: "generated",
    label: "The agent id",
    line: "Which Moolam agent drew it, and the ERC-8004 registry it is identified in.",
  },
  {
    key: "createdAt",
    source: "document",
    when: "always",
    label: "The date",
    line: "The moment this record was made, which is the whole point of registering early.",
  },
  {
    key: "training",
    source: "document",
    when: "always",
    label: "Your statement on AI use",
    line: "The four answers you gave above, in the words the CAWG standard uses.",
  },
  {
    key: "sealed",
    source: "document",
    when: "always",
    label: "The word sealed",
    line: "So a passport page, Explore and a link preview all say the picture is not published.",
  },
  {
    key: "model",
    source: "document",
    when: "generated",
    label: "Which model drew it",
    line: "The name of the image model, the same as on a published passport.",
  },
  {
    key: "prompt",
    source: "document",
    when: "generated",
    label: "The prompt",
    line: "Words that describe the picture, so it stays out of the file unless you put it in.",
    optional: true,
  },
  {
    key: "privateRecheck",
    source: "document",
    when: "privateRecheck",
    label: "That you asked for a private re-check",
    line: "One word in the pinned file, so a passport page can say it. The copy's address is never in it.",
  },
];

/** The keys of the pinned document, which is what the schema in the verify service must match. */
export const SEALED_DOCUMENT_KEYS = SEALED_PUBLIC_FIELDS.filter((field) => field.source === "document").map(
  (field) => field.key,
);

/**
 * The rows to draw for one registration.
 *
 * A picture nobody drew has no agent, no model and no prompt, and a list that
 * showed them would be promising to publish three things that will not exist.
 * The private re-check's one word is listed only while it is asked for, for the
 * same reason.
 */
export function sealedFieldsFor({
  generated,
  privateRecheck = false,
}: {
  generated: boolean;
  privateRecheck?: boolean;
}): SealedPublicField[] {
  return SEALED_PUBLIC_FIELDS.filter(
    (field) =>
      field.when === "always" ||
      (field.when === "generated" && generated) ||
      (field.when === "privateRecheck" && privateRecheck),
  );
}
