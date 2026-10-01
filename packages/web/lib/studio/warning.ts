import type { Hex } from "viem";
import { passportIdFrom } from "@/lib/passport/original";
import type { GenerateResponse, PrepareResponse } from "@/lib/verifier/client";
import type { Mode, RegisterState } from "./flow";

/**
 * What the studio says about earlier passports before the creator signs, read
 * from the prepare answer (L19, L20).
 *
 * "unchecked" covers the service's own "could not check" and an answer this
 * page could not read, which the client turns into undefined. Neither is ever
 * drawn as "none found": silence there would read as a clean search.
 */
export type EarlierPassport =
  | { state: "found"; passportId: Hex | null; title: string; registeredAt: number }
  | { state: "yours"; passportId: Hex | null }
  | { state: "none"; indexAt: number }
  | { state: "unchecked" };

/** What Google found, as the creator is about to sign it. Absent when it found nothing to show (L23). */
export interface SeenOnline {
  count: number;
  pages: string[];
  /** Pages counted by Google and not listed in the answer. */
  more: number;
}

/** The most code points a stranger's title is drawn at, the same cut the verify service makes. */
export const TITLE_POINTS = 120;

/** The most pages the web check lists, and the longest page address it keeps. */
const MAX_PAGES = 10;
const MAX_PAGE_CHARS = 256;

/**
 * Control, format and direction characters, which would let a stranger's title
 * break the line, hide text or turn the sentence around it.
 */
const UNPRINTABLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

/** A stranger's title as one printable line of at most TITLE_POINTS code points, or "" when nothing printable is left. */
export function plainTitle(value: string): string {
  const line = value.replace(UNPRINTABLE, " ").replace(/\s+/g, " ").trim();
  return Array.from(line).slice(0, TITLE_POINTS).join("").trim();
}

/** True for an answer from the upload path, which is the only one the search runs on. */
function fromPrepare(answer: PrepareResponse | GenerateResponse): answer is PrepareResponse {
  return !("generatorSig" in answer);
}

/**
 * The look-alike answer for this run, or null when this run has none to show:
 * nothing prepared yet, or a picture the agent drew, whose route never searches.
 */
export function earlierPassport(state: Pick<RegisterState, "mode" | "prepared">): EarlierPassport | null {
  const answer = state.prepared;
  if (state.mode !== "upload" || answer === null || !fromPrepare(answer)) {
    return null;
  }
  const found = answer.lookalike;
  switch (found?.state) {
    case "found":
      return {
        state: "found",
        passportId: passportIdFrom(found.passportId),
        title: plainTitle(found.title),
        registeredAt: found.registeredAt,
      };
    case "yours":
      return { state: "yours", passportId: passportIdFrom(found.passportId) };
    case "none":
      return { state: "none", indexAt: found.indexAt };
    default:
      return { state: "unchecked" };
  }
}

/**
 * The pages Google named, as text to read, or null for every other outcome.
 * "silent", an unreadable answer and a found answer with no usable page all
 * show nothing, so no screen can say "not online" from an absence (L23).
 */
export function seenOnline(state: Pick<RegisterState, "mode" | "prepared">): SeenOnline | null {
  const answer = state.prepared;
  if (state.mode !== "upload" || answer === null || !fromPrepare(answer)) {
    return null;
  }
  const web = answer.webCheck;
  if (web?.state !== "found") {
    return null;
  }
  const pages = web.pages
    .map((page) => page.replace(UNPRINTABLE, "").trim())
    .filter((page) => page.length > 0 && page.length <= MAX_PAGE_CHARS)
    .slice(0, MAX_PAGES);
  if (pages.length === 0) {
    return null;
  }
  const count = Math.max(web.count, pages.length);
  return { count, pages, more: count - pages.length };
}

/**
 * True when the run stops after prepare for the creator's go-ahead: an earlier
 * passport by someone else, one of their own, or pages on the web. "none" and
 * "unchecked" carry on to the passkey once their line is drawn.
 */
export function needsGoAhead(state: Pick<RegisterState, "mode" | "prepared">): boolean {
  const earlier = earlierPassport(state);
  return earlier?.state === "found" || earlier?.state === "yours" || seenOnline(state) !== null;
}

/**
 * Whether the verify service's one rule would send this picture to Google
 * (L22): a studio upload, of kind Captured, not sealed. The studio's upload
 * path always registers Captured and the agent's never does, so the mode and
 * the switch decide it.
 */
export function webCheckApplies({ mode, sealed }: { mode: Mode; sealed: boolean }): boolean {
  return mode === "upload" && !sealed;
}
