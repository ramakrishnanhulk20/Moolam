import type { Hex } from "viem";
import type { RegisterState } from "@/lib/studio/flow";
import type { PrepareResponse } from "@/lib/verifier/client";
import { fixtureState } from "./studio-fixtures";

/**
 * The studio's run as the prepare answer leaves it, one pose for each thing the
 * look-alike search and the web check can say. Written by hand from the verify
 * service's documented answers (docs/api/verifier-endpoints.md, POST /prepare),
 * so nothing here reaches the service, Google or Monad.
 */

/** An earlier passport by somebody else, as the service names it. */
export const EARLIER_ID = `0x${"3c".repeat(32)}` as Hex;

/** 22 September 2026, 04:10 UTC, in the chain's whole seconds. */
export const EARLIER_AT = 1_790_050_200;

/** When the service's copy of the index was current, in whole seconds. */
export const INDEX_AT = 1_790_312_400;

export const EARLIER_TITLE = "Kochi harbour, the morning boats";

/** Ten pages, as many as the service ever lists, of the fourteen Google counted. */
export const PAGES = [
  "https://www.flickr.com/photos/coastline/53120988841/",
  "https://www.pinterest.com/pin/412783596869512345/",
  "https://kerala-travel-notes.example/harbours/kochi",
  "https://news.example.in/2025/08/fishing-season-opens",
  "https://wallpapers.example.com/sea/harbour-morning-4k",
  "https://www.reddit.com/r/itookapicture/comments/1abcde/",
  "https://blog.example.org/a-week-in-fort-kochi",
  "https://stock.example.com/photo/harbour-boats-dawn",
  "https://www.tumblr.com/coastlines/7310298712",
  "https://images.example.net/collections/india-coast",
];

export const PAGE_COUNT = 14;

export type Finding = "found" | "yours" | "none" | "unchecked" | "unread" | "web" | "foundAndWeb";

export const FINDINGS: readonly Finding[] = ["found", "yours", "none", "unchecked", "unread", "web", "foundAndWeb"];

/** The two fields a prepare answer adds, for each finding. "unread" is an answer the page could not read. */
function answerFor(finding: Finding): Pick<PrepareResponse, "lookalike" | "webCheck"> {
  const silent = { state: "silent" } as const;
  const found = { state: "found", passportId: EARLIER_ID, title: EARLIER_TITLE, registeredAt: EARLIER_AT } as const;
  const pages = { state: "found", count: PAGE_COUNT, pages: PAGES } as const;
  switch (finding) {
    case "found":
      return { lookalike: found, webCheck: silent };
    case "yours":
      return { lookalike: { state: "yours", passportId: EARLIER_ID }, webCheck: silent };
    case "none":
      return { lookalike: { state: "none", indexAt: INDEX_AT }, webCheck: silent };
    case "unchecked":
      return { lookalike: { state: "unchecked" }, webCheck: silent };
    case "unread":
      return { lookalike: undefined, webCheck: undefined };
    case "web":
      return { lookalike: { state: "none", indexAt: INDEX_AT }, webCheck: pages };
    case "foundAndWeb":
      return { lookalike: found, webCheck: pages };
  }
}

/** True for the findings that pause the run for the creator's go-ahead. */
export function pauses(finding: Finding): boolean {
  return finding === "found" || finding === "yours" || finding === "web" || finding === "foundAndWeb";
}

/** The prepare answer for a finding, on the public upload path. */
export function preparedWith(finding: Finding): PrepareResponse {
  const base = fixtureState("upload", "signing").prepared as PrepareResponse;
  return { ...base, ...answerFor(finding) };
}

/**
 * The run straight after prepare: paused for a go-ahead when the finding asks
 * for one, else at the passkey with the line already drawn.
 */
export function signingState(finding: Finding): RegisterState {
  const signing = fixtureState("upload", "signing");
  const prepared = preparedWith(finding);
  if (pauses(finding)) {
    return { ...signing, prepared, review: true, steps: { ...signing.steps, sign: "waiting" } };
  }
  return { ...signing, prepared };
}
