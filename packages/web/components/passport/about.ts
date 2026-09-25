import type { SealedCopyLookup } from "@/lib/verifier/client";
import type { Art } from "./art";

/** The sentences a sealed passport's ABOUT line can say, under passport.sealed.about. */
export type SealedAboutKey = "noCopy" | "kept" | "deleted" | "asked" | "published";

export type AboutLine =
  | { kind: "pinned"; text: string }
  | { kind: "sealed"; key: Exclude<SealedAboutKey, "published"> }
  | { kind: "sealed"; key: "published"; at: string };

/**
 * What the ABOUT line says for this passport today.
 *
 * A sealed document's description is one fixed sentence Moolam wrote at
 * registration and pinned for ever ("never published", "kept no copy"). The
 * creator never writes it, and it stops being true the day a private copy is
 * kept or the holder publishes the picture. So a sealed passport, including one
 * published since, gets the sentence for its state now, and the pinned words
 * stay one tap away in the metadata link. A public passport's description is
 * the creator's own and is shown exactly as written.
 *
 * A private copy whose state could not be read gets the sentence that is true
 * either way: the creator asked for one.
 */
export function aboutLine(art: Art, privateCopy?: SealedCopyLookup["state"]): AboutLine | null {
  if (art.unsealed !== undefined) {
    return { kind: "sealed", key: "published", at: art.unsealed.at };
  }
  if (art.sealed === true) {
    if (art.privateRecheck !== true) {
      return { kind: "sealed", key: "noCopy" };
    }
    if (privateCopy === "kept") {
      return { kind: "sealed", key: "kept" };
    }
    return { kind: "sealed", key: privateCopy === "gone" ? "deleted" : "asked" };
  }
  return art.description === undefined ? null : { kind: "pinned", text: art.description };
}
