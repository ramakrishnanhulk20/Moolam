import type { Hex } from "viem";
import { pinnedUri, type Art } from "@/components/passport/art";
import { CLAIM_WINDOW_DAYS, DAY_SECONDS, SWORN_SINCE } from "./rule";

/**
 * Where the claim behind a passport comes from, strongest first.
 *
 * "studio" is a picture Moolam's own studio agent signed the moment it drew
 * it. "platform" is a listed platform's agent inside its window, which is what
 * the platform label's "kit" status already means. "cosigned" is a picture
 * drawn on a listed platform that the person signed with their own passkey,
 * which is what the credit rule's co-signed case means. Everything else is the
 * registrant's own claim: open to challenge for thirty days from registration
 * on the record's words, and always open to challenge with evidence after.
 *
 * A camera-signed claim is not issued: the document does not say whether the
 * camera's record was kept at upload, so the page has nothing to read it from.
 */
export type ClaimLine =
  | { key: "studio" }
  | { key: "platform"; platform: string }
  | { key: "cosigned"; platform: string; person: Hex; date: number }
  | { key: "self"; address: Hex; date: number; until: number }
  | { key: "selfLater"; address: Hex; date: number };

export interface ClaimInput {
  generatorAgentId: bigint;
  /** The agent Moolam's studio draws with. */
  studioAgentId: bigint;
  /** The platform label's status and name, or null when the passport has none or the list could not be read. */
  platform: { status: "kit" | "outsideKit"; name: string } | null;
  /** The credit rule's answer (lib/platforms/platforms.ts), or null when there is none or the list could not be read. */
  credit?: { case: string; platform: string; imaginedBy: string | null } | null;
  creator: Hex;
  /** Unix seconds. */
  registeredAt: number;
  /** Unix seconds, read once per render. */
  now: number;
}

export function claimOf(input: ClaimInput): ClaimLine {
  if (input.generatorAgentId !== 0n && input.generatorAgentId === input.studioAgentId) {
    return { key: "studio" };
  }
  if (input.platform?.status === "kit") {
    return { key: "platform", platform: input.platform.name };
  }
  const credit = input.credit ?? null;
  if (credit !== null && credit.case === "cosigned" && credit.imaginedBy !== null) {
    return { key: "cosigned", platform: credit.platform, person: credit.imaginedBy as Hex, date: input.registeredAt };
  }
  const until = input.registeredAt + CLAIM_WINDOW_DAYS * DAY_SECONDS;
  return input.now <= until
    ? { key: "self", address: input.creator, date: input.registeredAt, until }
    : { key: "selfLater", address: input.creator, date: input.registeredAt };
}

/**
 * The origin line under the claim, decided by chain facts and never by a
 * field in the document, which anyone writing straight on chain can copy (L25).
 *
 * "stated": the sworn line, or a platform's statement in its place, is in the
 * document. A platform's statement counts only when the creator is a platform
 * Moolam's list names, since any other registrant can write the same field.
 * "kit": the signed platform list says a listed platform registered
 * it in its own name, and it sent no statement. "beforeSworn": the registry's
 * own time puts it before the sworn line went live, so it could not carry one,
 * whoever prepared it. "outside": registered after the line went live with no
 * statement, which no registration through the service does any more. Null
 * when a pinned document could not be read after that time: a failed read
 * says nothing either way (L32). An address the service never pins is a chain
 * fact, so a data: document after that time reads outside.
 */
export type ClaimOrigin = "stated" | "beforeSworn" | "kit" | "outside";

export function claimOrigin(input: {
  /** The registry's registeredAt, in unix seconds. */
  registeredAt: number;
  metadataURI: string;
  art: Pick<Art, "statements">;
  /**
   * The platform label: null unless the creator is a platform Moolam's list
   * names, "kit" when the passport was registered through the kit in that
   * platform's own name.
   */
  platform: { status: "kit" | "outsideKit" } | null;
  /** When the sworn line went live, for a test; the product reads SWORN_SINCE. */
  swornSince?: number | null;
}): ClaimOrigin | null {
  const statements = input.art.statements;
  if (
    statements !== undefined &&
    (statements.sworn || (input.platform !== null && statements.platformStatement !== undefined))
  ) {
    return "stated";
  }
  if (input.platform?.status === "kit") {
    return "kit";
  }
  const since = input.swornSince === undefined ? SWORN_SINCE : input.swornSince;
  if (since === null || input.registeredAt < since) {
    return "beforeSworn";
  }
  if (statements === undefined) {
    return pinnedUri(input.metadataURI) === undefined ? "outside" : null;
  }
  return "outside";
}

const PASSPORT_ID = /^0x[0-9a-fA-F]{64}$/;

/**
 * The seenEarlier value as a passport id the page may link, or null when it is
 * not one. Held to the one pattern before any link is made (L21, R14).
 */
export function seenEarlierLink(value: string | undefined): Hex | null {
  return value !== undefined && PASSPORT_ID.test(value) ? (value.toLowerCase() as Hex) : null;
}
