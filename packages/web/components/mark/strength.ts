import type { Hex } from "viem";
import { pinnedUri, type Art } from "@/components/passport/art";
import { CLAIM_WINDOW_DAYS, DAY_SECONDS } from "./rule";

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
 * Who wrote the document behind the claim, read off what it carries (L25).
 *
 * "stated": the sworn line, or a platform's statement in its place, is in it.
 * "beforeSworn": Moolam's verify service pinned it (art.prepared) with no
 * statement, which only a document from before the sworn line existed can be.
 * "kit": the service pinned it for a listed platform registering in its own
 * name, and the platform sent no statement of its own. "outside": the service
 * never pinned it, either because the address is not a pinned document at all
 * (the service only ever pins) or because the document lacks the field only
 * the service writes. Null when a pinned document could not be read, which
 * says nothing either way (L32).
 */
export type ClaimOrigin = "stated" | "beforeSworn" | "kit" | "outside";

export function claimOrigin(input: {
  metadataURI: string;
  art: Pick<Art, "statements" | "prepared">;
  /** True when the platform label says the passport was registered through the kit in the platform's own name. */
  platformKit: boolean;
}): ClaimOrigin | null {
  const statements = input.art.statements;
  if (statements !== undefined && (statements.sworn || statements.platformStatement !== undefined)) {
    return "stated";
  }
  if (pinnedUri(input.metadataURI) === undefined) {
    return "outside";
  }
  if (statements === undefined) {
    return null;
  }
  if (input.art.prepared !== true) {
    return "outside";
  }
  return input.platformKit ? "kit" : "beforeSworn";
}

const PASSPORT_ID = /^0x[0-9a-fA-F]{64}$/;

/**
 * The seenEarlier value as a passport id the page may link, or null when it is
 * not one. Held to the one pattern before any link is made (L21, R14).
 */
export function seenEarlierLink(value: string | undefined): Hex | null {
  return value !== undefined && PASSPORT_ID.test(value) ? (value.toLowerCase() as Hex) : null;
}
