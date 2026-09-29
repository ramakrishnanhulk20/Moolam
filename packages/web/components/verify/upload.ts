import { chosenProblem, type Problem } from "./answer";

/**
 * Whether these first bytes open a JPEG, a PNG or a WebP file, the only three
 * the verify service decodes.
 *
 * The browser names a file's type from its extension, so a text file renamed
 * to .png arrives as image/png and passes the type test. Its first bytes are
 * the one thing a rename cannot change.
 */
export function isImageSignature(head: Uint8Array): boolean {
  const starts = (bytes: number[], at = 0) => bytes.every((byte, index) => head[at + index] === byte);
  if (starts([0xff, 0xd8, 0xff])) {
    return true;
  }
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return true;
  }
  // "RIFF", four bytes of length, then "WEBP".
  return starts([0x52, 0x49, 0x46, 0x46]) && starts([0x57, 0x45, 0x42, 0x50], 8);
}

/**
 * What is wrong with a file the reader chose or dropped, or null when it is
 * worth uploading: the shared size and type test first, then the first bytes.
 *
 * A browser that cannot read the file here lets it through, because the service
 * checks the same bytes and its answer still counts.
 */
export async function uploadProblem(file: File): Promise<Problem | null> {
  const problem = chosenProblem(file);
  if (problem !== null) {
    return problem;
  }
  let head: Uint8Array;
  try {
    head = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  } catch {
    return null;
  }
  return isImageSignature(head) ? null : { key: "problem.notAnImage" };
}

/**
 * A file size a person can read, or nothing when the size is zero or unknown.
 * A 46 KB screenshot must not print as 0.0 MB, and a file of a few bytes must
 * not print as 0 KB, which reads as empty.
 */
export function sizeLabel(bytes: number | undefined): string {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes <= 0) {
    return "";
  }
  return bytes < 1_000_000 ? `${Math.max(1, Math.round(bytes / 1_000))} KB` : `${(bytes / 1_000_000).toFixed(1)} MB`;
}

/** Whether a drag is carrying files, as opposed to a link or a run of selected text. */
export function carriesFiles(transfer: { types?: ArrayLike<string> | null } | null | undefined): boolean {
  return transfer?.types != null && Array.from(transfer.types).includes("Files");
}

/** The first file a drop brought, if it brought any. */
export function droppedFile(transfer: { files?: ArrayLike<File> | null } | null | undefined): File | undefined {
  return transfer?.files?.[0] ?? undefined;
}

type ClipboardItemLike = { kind: string; type: string; getAsFile(): File | null };

/**
 * The picture on the clipboard, if a paste carried one.
 *
 * A picture copied from a web page or a screenshot tool arrives as an item
 * rather than a file in some browsers, so both lists are read. Anything that is
 * not an image, text above all, is left alone for the page to paste as usual.
 * The picture still goes through the same first-bytes check as a chosen file.
 */
export function pastedImage(
  data: { files?: ArrayLike<File> | null; items?: ArrayLike<ClipboardItemLike> | null } | null | undefined,
): File | undefined {
  if (data == null) {
    return undefined;
  }
  const file = Array.from(data.files ?? []).find((one) => one.type.startsWith("image/"));
  if (file !== undefined) {
    return file;
  }
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind === "file" && item.type.startsWith("image/")) {
      const found = item.getAsFile();
      if (found !== null) {
        return found;
      }
    }
  }
  return undefined;
}

/** Whether a paste landed in a place that takes typed text, where it must stay a normal paste. */
export function pastedIntoText(target: EventTarget | null): boolean {
  if (typeof HTMLElement === "undefined" || !(target instanceof HTMLElement)) {
    return false;
  }
  return target.isContentEditable || target.closest("input, textarea, select, [contenteditable]") !== null;
}
