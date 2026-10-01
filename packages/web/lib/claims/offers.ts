import type { Hex } from "viem";
import { USE_FIELDS, type Consent } from "@/lib/chain/consent";
import type { ConsentDraft } from "@/lib/consent/call";
import type { SignedInUser } from "@/lib/studio/account";
import { MAX_IDS_PER_CALL, type ClaimOffer, type ClaimPlatform, type ClaimTerms, type ClaimsAnswer, type VerifiedBy, type WaitingClaim } from "./client";

/** One platform's offers, drawn as one card with one answer for all of them. */
export interface PlatformOffers {
  platform: ClaimPlatform;
  /** Every distinct way the platform says it checked the address, in the order its offers came. */
  verifiedBy: VerifiedBy[];
  offers: ClaimOffer[];
}

/** One platform's accepted or failed tickets, for the line that says where they stand. */
export interface PlatformWaiting {
  platform: ClaimPlatform;
  entries: WaitingClaim[];
}

/** Delivered tickets that share one set of terms, which one setConsentBatch can write together. */
export interface TermsGroup {
  key: string;
  terms: ClaimTerms;
  entries: WaitingClaim[];
}

/** The offers grouped by the platform's key, in the order the service listed them (newest first). */
export function offersByPlatform(offers: readonly ClaimOffer[]): PlatformOffers[] {
  const groups = new Map<string, PlatformOffers>();
  for (const offer of offers) {
    const key = offer.platform.keyHash;
    const group = groups.get(key) ?? { platform: offer.platform, verifiedBy: [], offers: [] };
    if (!group.verifiedBy.includes(offer.verifiedBy)) group.verifiedBy.push(offer.verifiedBy);
    group.offers.push(offer);
    groups.set(key, group);
  }
  return [...groups.values()];
}

/** The ticket ids "These are mine" or "Not mine" acts on: that platform's offers and nobody else's. */
export function ticketsFor(offers: readonly ClaimOffer[], platformKeyHash: string): string[] {
  const key = platformKeyHash.toLowerCase();
  return [...new Set(offers.filter((offer) => offer.platform.keyHash === key).map((offer) => offer.ticketId))];
}

/** A list cut into calls the service and the contract both take whole. */
export function inBatches<T>(items: readonly T[], size: number = MAX_IDS_PER_CALL): T[][] {
  const batches: T[][] = [];
  for (let at = 0; at < items.length; at += size) batches.push(items.slice(at, at + size));
  return batches;
}

/** The waiting tickets in one state, grouped by platform. */
export function waitingByPlatform(waiting: readonly WaitingClaim[], state: "accepted" | "failed"): PlatformWaiting[] {
  const groups = new Map<string, PlatformWaiting>();
  for (const entry of waiting) {
    if (entry.state !== state) continue;
    const group = groups.get(entry.platform.keyHash) ?? { platform: entry.platform, entries: [] };
    group.entries.push(entry);
    groups.set(entry.platform.keyHash, group);
  }
  return [...groups.values()];
}

/** The delivered tickets, grouped by their exact terms, since one batch writes one statement. */
export function deliveredByTerms(waiting: readonly WaitingClaim[]): TermsGroup[] {
  const groups = new Map<string, TermsGroup>();
  for (const entry of waiting) {
    if (entry.state !== "delivered") continue;
    const key = termsKey(entry.terms);
    const group = groups.get(key) ?? { key, terms: entry.terms, entries: [] };
    if (!group.entries.some((one) => one.passportId === entry.passportId)) group.entries.push(entry);
    groups.set(key, group);
  }
  return [...groups.values()];
}

export function termsKey(terms: ClaimTerms): string {
  return JSON.stringify([...USE_FIELDS.map((field) => terms[field]), terms.constraintInfo]);
}

/** Whether the section has anything to draw at all. */
export function hasAnything(answer: ClaimsAnswer | null): boolean {
  return answer !== null && answer.offers.length + answer.waiting.length + answer.standing.length + answer.muted.length > 0;
}

/**
 * The statement the page built, as the service stores it and the contract
 * takes it: the conditions text goes only with a use that asks for it, which
 * is the contract's own rule, so the accept is never refused for a leftover.
 */
export function termsFromDraft(draft: ConsentDraft): ClaimTerms {
  const constrained = USE_FIELDS.some((field) => draft.consent[field] === "constrained");
  return {
    aiTraining: draft.consent.aiTraining,
    aiGenerativeTraining: draft.consent.aiGenerativeTraining,
    aiInference: draft.consent.aiInference,
    dataMining: draft.consent.dataMining,
    constraintInfo: constrained ? draft.constraintInfo.trim() : "",
  };
}

/** The stored terms back as the four uses and the text the consent register is given. */
export function draftFromTerms(terms: ClaimTerms): ConsentDraft {
  const consent: Consent = {
    aiTraining: terms.aiTraining,
    aiGenerativeTraining: terms.aiGenerativeTraining,
    aiInference: terms.aiInference,
    dataMining: terms.dataMining,
  };
  return { consent, constraintInfo: terms.constraintInfo };
}

/**
 * The addresses the person proved to Privy, read from their own session: the
 * email account and the Google account's email, the same two the service
 * matches on. This is the only source the page names an address from; the
 * service's answer never carries one.
 */
export function sessionEmails(user: SignedInUser | null | undefined): string[] {
  const found = [user?.email?.address, user?.google?.email].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
  const seen = new Set<string>();
  return found.filter((value) => (seen.has(value.toLowerCase()) ? false : (seen.add(value.toLowerCase()), true)));
}

/** A passport id in the lowercase form every comparison here uses. */
export function idKey(id: string): Hex {
  return id.toLowerCase() as Hex;
}
