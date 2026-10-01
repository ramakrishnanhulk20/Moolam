import { getAddress, type Address, type Hex } from "viem";
import type { ChainPassport } from "../platform/chain.js";
import { platformLabel, type Platform } from "../platforms/platforms.js";
import type { ClaimChain } from "./chain.js";
import { underPepper, type Pepper } from "./email.js";
import { advance, isTerminal, pruneClosed, type ClaimStore, type Ticket, type TicketState } from "./store.js";

/**
 * How many waiting tickets one run reads the chain for. Two reads each at most, eight at a time, so
 * a run costs at most 400 reads and a few seconds; the rest wait for the next run, in turn.
 */
export const SWEEP_TICKETS_PER_RUN = 200;

const READS_AT_ONCE = 8;

/** The longest metadataURI a ticket keeps. A longer one is kept as none, and the offer shows no preview. */
const MAX_URI_LENGTH = 2048;

export interface SweepCounts {
  opened: number;
  accepted: number;
  delivered: number;
  moved: number;
  expired: number;
  pruned: number;
  /** Tickets whose chain read failed this run, so nothing about them changed. */
  unread: number;
}

export interface ClaimSweeper {
  /** One pass. Undefined when a pass is already running, or chain time could not be read. */
  run: () => Promise<SweepCounts | undefined>;
}

type Decision = { to: TicketState; uri?: string | null } | null;

/**
 * The sweep that turns chain facts into ticket states (P27). Every move below is taken only on a
 * chain read made in this run, and a read that fails leaves the ticket as it was (fail closed).
 *
 * pending: opens only when the registry's creator and ownerOf both equal the ticket's creator
 * wallet and platformLabel says "kit" (P16). A ticket written with a standing destination is
 * accepted on the same facts, or delivered when the holder is already that destination. Anything
 * else waits, then expires at its pending window. A ticket under an older pepper expires (P29).
 *
 * open: moves to moved when the passport has left the platform's wallet, and expires at its
 * lifetime. accepted: delivered only when ownerOf equals the destination; moved when anyone else
 * holds it; expired at its lifetime while the platform still holds it.
 *
 * Every step names the state it was judged from, so a ticket an accept or a refuse moved while the
 * chain was being read is left as that request made it (P33).
 */
export function claimSweeper(deps: {
  store: ClaimStore;
  chain: ClaimChain;
  platforms: readonly Platform[];
  pepper: Pepper;
  log: (line: string) => void;
  perRun?: number;
}): ClaimSweeper {
  const perRun = deps.perRun ?? SWEEP_TICKETS_PER_RUN;
  let running = false;
  let cursor = 0;

  const ownerOf = async (passportId: string): Promise<Address | undefined> => {
    try {
      return getAddress(await deps.chain.ownerOf(passportId as Hex));
    } catch {
      return undefined;
    }
  };

  const decide = async (ticket: Ticket, now: number): Promise<Decision | "unread"> => {
    if ((ticket.state === "pending" || ticket.state === "open") && !underPepper(ticket.emailHash, deps.pepper)) {
      return { to: "expired" };
    }
    if (ticket.state === "pending") {
      let passport: ChainPassport | undefined;
      try {
        passport = await deps.chain.passport(ticket.passportId as Hex);
      } catch {
        return "unread";
      }
      if (passport !== undefined && sameAddress(passport.creator, ticket.creatorWallet) && kit(passport, deps.platforms, BigInt(now))) {
        const owner = await ownerOf(ticket.passportId);
        if (owner === undefined) return "unread";
        const uri = passport.metadataURI.length <= MAX_URI_LENGTH ? passport.metadataURI : null;
        if (owner === ticket.creatorWallet) return { to: ticket.standing === null ? "open" : "accepted", uri };
        if (ticket.standing !== null && owner === ticket.standing) return { to: "delivered", uri };
      }
      return now > ticket.pendingUntil ? { to: "expired" } : null;
    }
    if (ticket.state === "open") {
      if (now > ticket.expiresAt) return { to: "expired" };
      const owner = await ownerOf(ticket.passportId);
      if (owner === undefined) return "unread";
      return owner === ticket.creatorWallet ? null : { to: "moved" };
    }
    if (ticket.state === "accepted") {
      const owner = await ownerOf(ticket.passportId);
      if (owner === undefined) return "unread";
      if (owner === ticket.destination) return { to: "delivered" };
      if (owner !== ticket.creatorWallet) return { to: "moved" };
      return now > ticket.expiresAt ? { to: "expired" } : null;
    }
    return null;
  };

  return {
    async run() {
      if (running) return undefined;
      running = true;
      try {
        let now: number;
        try {
          now = Number(await deps.chain.now());
        } catch {
          deps.log("claim sweep: chain time could not be read, nothing changed");
          return undefined;
        }
        const counts: SweepCounts = { opened: 0, accepted: 0, delivered: 0, moved: 0, expired: 0, pruned: 0, unread: 0 };
        const pruned = pruneClosed(deps.store, now);
        if (pruned.ok) counts.pruned = pruned.value;

        const waiting = deps.store.read().tickets.filter((ticket) => !isTerminal(ticket.state));
        const start = waiting.length === 0 ? 0 : cursor % waiting.length;
        const batch = [...waiting.slice(start), ...waiting.slice(0, start)].slice(0, perRun);
        cursor = start + batch.length;

        for (let at = 0; at < batch.length; at += READS_AT_ONCE) {
          const chunk = batch.slice(at, at + READS_AT_ONCE);
          const decisions = await Promise.all(chunk.map(async (ticket) => await decide(ticket, now)));
          chunk.forEach((ticket, index) => {
            const decision = decisions[index];
            if (decision === "unread") {
              counts.unread += 1;
              return;
            }
            if (decision === null || decision === undefined) return;
            const moved = deps.store.change((state) => {
              const step = advance(state, ticket.ticketId, ticket.state, (current) => stepTo(current, decision, now));
              return step.ok ? { ok: true, value: { state, result: step.value } } : step;
            });
            if (!moved.ok) return;
            if (decision.to === "open") counts.opened += 1;
            else if (decision.to === "accepted") counts.accepted += 1;
            else if (decision.to === "delivered") counts.delivered += 1;
            else if (decision.to === "moved") counts.moved += 1;
            else if (decision.to === "expired") counts.expired += 1;
          });
        }
        if (Object.values(counts).some((count) => count > 0)) {
          deps.log(
            `claim sweep: ${counts.opened} opened, ${counts.accepted} accepted by a standing choice, ${counts.delivered} delivered, ${counts.moved} moved, ${counts.expired} expired, ${counts.pruned} pruned, ${counts.unread} unread`,
          );
        }
        return counts;
      } finally {
        running = false;
      }
    },
  };
}

/** Both sides through getAddress; anything that is not an address matches nothing. */
function sameAddress(a: string, b: string): boolean {
  try {
    return getAddress(a) === getAddress(b);
  } catch {
    return false;
  }
}

/** The platform's own label holds for this passport: its listed wallet registered it inside the kit's terms (P16). */
function kit(passport: ChainPassport, platforms: readonly Platform[], now: bigint): boolean {
  return platformLabel(passport, platforms, now)?.status === "kit";
}

/** The ticket after the step the sweep decided, with the fields that step sets. The store checks it against its schema. */
function stepTo(current: Ticket, decision: NonNullable<Decision>, now: number): Ticket {
  const opened = current.openedAt ?? now;
  const uri = current.metadataURI ?? decision.uri ?? null;
  switch (decision.to) {
    case "open":
      return { ...current, state: "open", openedAt: opened, metadataURI: uri } as Ticket;
    case "accepted":
      return {
        ...current,
        state: "accepted",
        openedAt: opened,
        metadataURI: uri,
        destination: current.standing,
        terms: current.standingTerms,
        acceptedAt: now,
      } as Ticket;
    case "delivered":
      return {
        ...current,
        state: "delivered",
        openedAt: opened,
        metadataURI: uri,
        destination: current.destination ?? current.standing,
        terms: current.terms ?? current.standingTerms,
        acceptedAt: current.acceptedAt ?? now,
        closedAt: now,
      } as Ticket;
    default:
      return { ...current, state: decision.to, closedAt: now } as Ticket;
  }
}
