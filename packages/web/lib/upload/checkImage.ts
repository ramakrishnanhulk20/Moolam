/**
 * The one check every upload path runs before a byte leaves the browser.
 *
 * The verify service checks the same two things and its answer is still the one
 * that counts. Running it here first means a file the service was always going
 * to refuse is refused at once, in the page's own words, instead of after a
 * 20 MB upload.
 */

/** The same number as MAX_UPLOAD_BYTES in packages/verifier/src/env.ts: 20 MB. */
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];

/**
 * A drag from an archive or a file with an unusual extension can arrive with no
 * type at all, so the name is the only thing left to read.
 */
const IMAGE_SUFFIXES = [".jpg", ".jpeg", ".png", ".webp"];

/** The service's own codes, so each caller keeps the one table it already has. */
export type RefusalCode = "too-large" | "not-an-image" | "empty";

export interface Refusal {
  code: RefusalCode;
  /** The file's own words: its type or name when the type is wrong, its size when it is too big, its name when it holds nothing. */
  reason: string;
}

/** What is wrong with this file, or null when it is worth uploading. */
export function checkImage(file: File): Refusal | null {
  if (!isImage(file)) {
    return { code: "not-an-image", reason: file.type === "" ? file.name : file.type };
  }
  // A file with a picture's name and no bytes in it. The type test passes, the
  // size test passes, and the service refuses it after a whole upload with a
  // sentence of its own in English. Answered here instead, in the reader's
  // language, before anything leaves the machine.
  if (file.size === 0) {
    return { code: "empty", reason: file.name };
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return { code: "too-large", reason: `${(file.size / 1_000_000).toFixed(1)} MB` };
  }
  return null;
}

function isImage(file: File): boolean {
  if (file.type !== "") {
    return IMAGE_TYPES.includes(file.type);
  }
  const name = file.name.toLowerCase();
  return IMAGE_SUFFIXES.some((suffix) => name.endsWith(suffix));
}
