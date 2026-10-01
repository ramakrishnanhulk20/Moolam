// Covers the ticket store and the sweep with the chain stood in for: P33 every step names the state
// it leaves, an accept racing a refuse or a second accept loses whole, a record changed on disk is
// dropped and the file written back without it, a file that is not this outline closes the store;
// P38 the per-key and per-person caps and the refusal share that closes a key; P27 a pending ticket
// opens only when the registry's creator and ownerOf both equal the platform's wallet under its
// kit label, a passport registered under another creator never opens, a passport that left the
// wallet moves the ticket to a terminal state, "delivered" only when ownerOf is the destination,
// and a chain that cannot be read changes nothing; P29 a ticket under an older pepper expires.
// Does NOT cover the routes (claims-routes.test.ts), two processes sharing one file, a writer who
// can write a well-formed record into the data folder, or reorgs behind the latest block.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { getAddress, type Hex } from "viem";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { ClaimChain } from "../src/claims/chain.js";
import { emailHash, type Pepper } from "../src/claims/email.js";
import {
  ClaimStoreClosed,
  DEFAULT_CLAIM_CAPS,
  PENDING_WINDOW_SECONDS,
  acceptTickets,
  claimStore,
  refuseTickets,
  writeTicket,
  type ClaimStore,
  type Ticket,
} from "../src/claims/store.js";
import { claimSweeper } from "../src/claims/sweep.js";
import type { ClaimTerms } from "../src/claims/terms.js";
import type { Platform } from "../src/platforms/platforms.js";

const pepper: Pepper = { secret: Buffer.alloc(32, 1), version: "1" };
const KEY_HASH = `0x${"ab".repeat(32)}`;
const PLATFORM_WALLET = getAddress("0x00000000000000000000000000000000000000aa");
const STRANGER = getAddress("0x00000000000000000000000000000000000000bb");
const PERSON = getAddress("0x00000000000000000000000000000000000000cc");
const AGENT_ID = 77n;
const NOW = 1_800_000_000;
const terms: ClaimTerms = { aiTraining: "notAllowed", aiGenerativeTraining: "notAllowed", aiInference: "allowed", dataMining: "unspecified", constraintInfo: "" };

const platforms: Platform[] = [
  {
    name: "Acme Images",
    agentId: AGENT_ID,
    ownerAtOnboarding: STRANGER,
    creatorWallet: PLATFORM_WALLET,
    keyHash: KEY_HASH as Hex,
    origins: ["https://acme.example"],
    validFrom: 1n,
    validTo: null,
    acceptedAt: 1n,
  },
];

const made: string[] = [];
let file: string;
let store: ClaimStore;
let passports: Map<string, { creator: string; registeredAt: bigint }>;
let owners: Map<string, string>;
let chainNow: number;
let chainDown: boolean;

const chain: ClaimChain = {
  now: async () => {
    if (chainDown) throw new Error("rpc down");
    return BigInt(chainNow);
  },
  passport: async (id) => {
    if (chainDown) throw new Error("rpc down");
    const found = passports.get(id);
    return found === undefined
      ? undefined
      : {
          creator: getAddress(found.creator),
          generatorAgentId: AGENT_ID,
          manifestHash: `0x${"11".repeat(32)}`,
          kind: 0,
          metadataURI: "ipfs://bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy",
          registeredAt: found.registeredAt,
        };
  },
  ownerOf: async (id) => {
    const owner = owners.get(id);
    if (chainDown || owner === undefined) throw new Error("no owner");
    return getAddress(owner);
  },
};

let next = 0;
function passportId(): string {
  next += 1;
  return `0x${next.toString(16).padStart(64, "0")}`;
}

const hashOf = (email: string): string => emailHash(email, pepper) as string;

function write(email: string, id = passportId(), at = NOW): Ticket {
  const written = writeTicket(
    store,
    { passportId: id, keyHash: KEY_HASH, platformName: "Acme Images", creatorWallet: PLATFORM_WALLET, verifiedBy: "google", emailHash: hashOf(email), standing: undefined },
    at,
    DEFAULT_CLAIM_CAPS,
  );
  if (!written.ok) throw new Error(written.reason);
  return written.value;
}

function landed(id: string, creator = PLATFORM_WALLET, owner: string = creator): void {
  passports.set(id, { creator, registeredAt: BigInt(NOW) });
  owners.set(id, owner);
}

const sweeper = () => claimSweeper({ store, chain, platforms, pepper, log: () => undefined });

function stateOf(ticketId: string): string | undefined {
  return store.read().tickets.find((one) => one.ticketId === ticketId)?.state;
}

async function openTicket(email: string): Promise<Ticket> {
  const ticket = write(email);
  landed(ticket.passportId);
  await sweeper().run();
  expect(stateOf(ticket.ticketId)).toBe("open");
  return ticket;
}

beforeEach(() => {
  const dir = mkdtempSync(path.join(tmpdir(), "moolam-claims-"));
  made.push(dir);
  file = path.join(dir, "claim-tickets.json");
  store = claimStore(file);
  passports = new Map();
  owners = new Map();
  chainNow = NOW + 60;
  chainDown = false;
});

afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

describe("the ticket store (P32, P33)", () => {
  it("writes a ticket pending, with a 128 bit id from the CSPRNG and the email only as its hash", () => {
    const ticket = write("ram@example.com");
    expect(ticket.state).toBe("pending");
    expect(ticket.ticketId).toMatch(/^[0-9a-f]{32}$/);
    expect(write("ram@example.com").ticketId).not.toBe(ticket.ticketId);
    const onDisk = readFileSync(file, "utf8");
    expect(onDisk).not.toContain("ram@example.com");
    expect(onDisk).toContain(hashOf("ram@example.com"));
  });

  it("lets an accept racing a refuse, and a second accept, lose whole", async () => {
    const first = await openTicket("ram@example.com");
    const second = await openTicket("ram@example.com");
    const mine = new Set([hashOf("ram@example.com")]);
    const accept = acceptTickets(store, { ticketIds: [first.ticketId, second.ticketId], emailHashes: mine, destination: PERSON, terms, sendFuture: false, now: NOW, allowed: () => true }, DEFAULT_CLAIM_CAPS);
    expect(accept.ok).toBe(true);
    const refuse = refuseTickets(store, { ticketIds: [second.ticketId], emailHashes: mine, now: NOW }, DEFAULT_CLAIM_CAPS);
    expect(refuse).toEqual({ ok: false, reason: "not-open" });
    const again = acceptTickets(store, { ticketIds: [first.ticketId], emailHashes: mine, destination: STRANGER, terms, sendFuture: false, now: NOW, allowed: () => true }, DEFAULT_CLAIM_CAPS);
    expect(again).toEqual({ ok: false, reason: "not-open" });
    const kept = store.read().tickets.find((one) => one.ticketId === first.ticketId);
    expect(kept).toMatchObject({ state: "accepted", destination: PERSON });
    expect(store.read().muted).toEqual([]);
  });

  it("answers the losing accept not-open when the refuse came first and muted the platform", async () => {
    const ticket = await openTicket("ram@example.com");
    const mine = new Set([hashOf("ram@example.com")]);
    expect(refuseTickets(store, { ticketIds: [ticket.ticketId], emailHashes: mine, now: NOW }, DEFAULT_CLAIM_CAPS).ok).toBe(true);
    expect(store.read().muted).toHaveLength(1);
    const late = acceptTickets(store, { ticketIds: [ticket.ticketId], emailHashes: mine, destination: PERSON, terms, sendFuture: false, now: NOW, allowed: () => true }, DEFAULT_CLAIM_CAPS);
    expect(late).toEqual({ ok: false, reason: "not-open" });
    const stranger = acceptTickets(store, { ticketIds: [ticket.ticketId], emailHashes: new Set([hashOf("other@example.com")]), destination: PERSON, terms, sendFuture: false, now: NOW, allowed: () => true }, DEFAULT_CLAIM_CAPS);
    expect(stranger).toEqual({ ok: false, reason: "not-found" });
    const hidden = await openTicket("ram@example.com");
    const muted = acceptTickets(store, { ticketIds: [hidden.ticketId], emailHashes: mine, destination: PERSON, terms, sendFuture: false, now: NOW, allowed: () => true }, DEFAULT_CLAIM_CAPS);
    expect(muted).toEqual({ ok: false, reason: "not-found" });
  });

  it("refuses a step that skips a state or rewrites a fixed field, and writes nothing", () => {
    const ticket = write("ram@example.com");
    const skipped = store.change((state) => {
      const at = state.tickets.findIndex((one) => one.ticketId === ticket.ticketId);
      state.tickets[at] = { ...ticket, state: "refused", openedAt: NOW, closedAt: NOW } as Ticket;
      return { ok: true, value: { state, result: null } };
    });
    expect(skipped.ok).toBe(false);
    const rewritten = store.change((state) => {
      const at = state.tickets.findIndex((one) => one.ticketId === ticket.ticketId);
      state.tickets[at] = { ...ticket, emailHash: hashOf("other@example.com") };
      return { ok: true, value: { state, result: null } };
    });
    expect(rewritten).toMatchObject({ ok: false });
    const removed = store.change((state) => ({ ok: true, value: { state: { ...state, tickets: [] }, result: null } }));
    expect(removed).toEqual({ ok: false, reason: "only a closed ticket may be removed" });
    expect(stateOf(ticket.ticketId)).toBe("pending");
  });

  it("drops a record changed on disk and writes the file back without it; a file that is not JSON closes the store", async () => {
    const edited = await openTicket("ram@example.com");
    const kept = write("ram@example.com");
    const onDisk = JSON.parse(readFileSync(file, "utf8"));
    const row = onDisk.tickets.find((one: Ticket) => one.ticketId === edited.ticketId);
    row.state = "accepted";
    writeFileSync(file, JSON.stringify(onDisk));

    const read = store.read();
    expect(read.tickets.map((one) => one.ticketId)).toEqual([kept.ticketId]);
    expect(readFileSync(file, "utf8")).not.toContain(edited.ticketId);

    writeFileSync(file, "{ not json");
    expect(() => store.read()).toThrow(ClaimStoreClosed);
    expect(() => write("ram@example.com")).toThrow(ClaimStoreClosed);
  });

  it("refuses an id outside the caller's set whole, and an unknown id the same way (P32)", async () => {
    const mine = await openTicket("ram@example.com");
    const theirs = await openTicket("someone@example.com");
    const asked = acceptTickets(
      store,
      { ticketIds: [mine.ticketId, theirs.ticketId], emailHashes: new Set([hashOf("ram@example.com")]), destination: PERSON, terms, sendFuture: false, now: NOW, allowed: () => true },
      DEFAULT_CLAIM_CAPS,
    );
    expect(asked).toEqual({ ok: false, reason: "not-found" });
    const unknown = refuseTickets(store, { ticketIds: ["0".repeat(32)], emailHashes: new Set([hashOf("ram@example.com")]), now: NOW }, DEFAULT_CLAIM_CAPS);
    expect(unknown).toEqual({ ok: false, reason: "not-found" });
    expect(stateOf(mine.ticketId)).toBe("open");
    expect(stateOf(theirs.ticketId)).toBe("open");
  });
});

describe("the caps and the refusal share (P38)", () => {
  it("stops one person's tickets from one platform at the cap, and the key's waiting tickets at its own", () => {
    const caps = { ...DEFAULT_CLAIM_CAPS, perEmailAndKey: 2, waitingPerKey: 3 };
    const at = (email: string) =>
      writeTicket(store, { passportId: passportId(), keyHash: KEY_HASH, platformName: "Acme Images", creatorWallet: PLATFORM_WALLET, verifiedBy: "platform", emailHash: hashOf(email), standing: undefined }, NOW, caps);
    expect(at("a@example.com").ok).toBe(true);
    expect(at("a@example.com").ok).toBe(true);
    expect(at("a@example.com")).toEqual({ ok: false, reason: "full" });
    expect(at("b@example.com").ok).toBe(true);
    expect(at("c@example.com")).toEqual({ ok: false, reason: "full" });
  });

  it("P30: never lets a person's refusal free a slot the platform could probe for", async () => {
    const caps = { ...DEFAULT_CLAIM_CAPS, perEmailAndKey: 1 };
    const first = await openTicket("a@example.com");
    expect(refuseTickets(store, { ticketIds: [first.ticketId], emailHashes: new Set([hashOf("a@example.com")]), now: NOW }, caps).ok).toBe(true);
    const again = writeTicket(
      store,
      { passportId: passportId(), keyHash: KEY_HASH, platformName: "Acme Images", creatorWallet: PLATFORM_WALLET, verifiedBy: "platform", emailHash: hashOf("a@example.com"), standing: undefined },
      NOW,
      caps,
    );
    expect(again).toEqual({ ok: false, reason: "full" });
  });

  it("closes a key's ticket writing once more than one in four of at least ten tickets were refused", async () => {
    const tickets: Ticket[] = [];
    for (let n = 0; n < 12; n += 1) tickets.push(await openTicket(`p${n}@example.com`));
    for (let n = 0; n < 10; n += 1) {
      const refused = refuseTickets(store, { ticketIds: [tickets[n]!.ticketId], emailHashes: new Set([hashOf(`p${n}@example.com`)]), now: NOW }, DEFAULT_CLAIM_CAPS);
      expect(refused.ok).toBe(true);
    }
    const tally = store.read().keys.find((one) => one.keyHash === KEY_HASH);
    expect(tally).toMatchObject({ written: 12, refused: 10 });
    expect(tally?.closedAt).not.toBeNull();
    expect(() => write("new@example.com")).toThrow("closed");
    expect(store.read().muted).toHaveLength(10);
  });
});

describe("the sweep (P27, P29)", () => {
  it("opens a ticket only when creator and ownerOf both equal the platform's wallet under its label", async () => {
    const ticket = write("ram@example.com");
    await sweeper().run();
    expect(stateOf(ticket.ticketId)).toBe("pending");

    landed(ticket.passportId, PLATFORM_WALLET, STRANGER);
    await sweeper().run();
    expect(stateOf(ticket.ticketId)).toBe("pending");

    owners.set(ticket.passportId, PLATFORM_WALLET);
    passports.set(ticket.passportId, { creator: PLATFORM_WALLET, registeredAt: BigInt(chainNow + 3600) });
    await sweeper().run();
    expect(stateOf(ticket.ticketId)).toBe("pending");

    landed(ticket.passportId);
    await sweeper().run();
    expect(store.read().tickets[0]).toMatchObject({ state: "open", openedAt: chainNow });
  });

  it("never opens a ticket for a passport registered under another creator, and expires it after its window", async () => {
    const ticket = write("ram@example.com");
    landed(ticket.passportId, STRANGER, PLATFORM_WALLET);
    await sweeper().run();
    expect(stateOf(ticket.ticketId)).toBe("pending");
    chainNow = NOW + PENDING_WINDOW_SECONDS + 1;
    await sweeper().run();
    expect(stateOf(ticket.ticketId)).toBe("expired");
  });

  it("changes nothing while the chain cannot be read, past every window included", async () => {
    const pending = write("ram@example.com");
    const open = await openTicket("ram@example.com");
    chainDown = true;
    chainNow = NOW + 10 * PENDING_WINDOW_SECONDS;
    expect(await sweeper().run()).toBeUndefined();
    expect(stateOf(pending.ticketId)).toBe("pending");
    expect(stateOf(open.ticketId)).toBe("open");
  });

  it("moves an offer whose passport left the platform's wallet, and delivers only to the destination", async () => {
    const left = await openTicket("ram@example.com");
    owners.set(left.passportId, STRANGER);
    await sweeper().run();
    expect(stateOf(left.ticketId)).toBe("moved");

    const sent = await openTicket("ram@example.com");
    const mine = new Set([hashOf("ram@example.com")]);
    expect(acceptTickets(store, { ticketIds: [sent.ticketId], emailHashes: mine, destination: PERSON, terms, sendFuture: false, now: NOW, allowed: () => true }, DEFAULT_CLAIM_CAPS).ok).toBe(true);
    await sweeper().run();
    expect(stateOf(sent.ticketId)).toBe("accepted");
    owners.set(sent.passportId, PERSON);
    await sweeper().run();
    expect(stateOf(sent.ticketId)).toBe("delivered");

    const elsewhere = await openTicket("ram@example.com");
    acceptTickets(store, { ticketIds: [elsewhere.ticketId], emailHashes: mine, destination: PERSON, terms, sendFuture: false, now: NOW, allowed: () => true }, DEFAULT_CLAIM_CAPS);
    owners.set(elsewhere.passportId, STRANGER);
    await sweeper().run();
    expect(stateOf(elsewhere.ticketId)).toBe("moved");
  });

  it("accepts a ticket written with a standing destination on the same facts, and delivers it when it has landed", async () => {
    const standing = { emailHash: hashOf("ram@example.com"), keyHash: KEY_HASH, platformName: "Acme Images", destination: PERSON, terms, setAt: NOW };
    const at = (id: string) =>
      writeTicket(store, { passportId: id, keyHash: KEY_HASH, platformName: "Acme Images", creatorWallet: PLATFORM_WALLET, verifiedBy: "google", emailHash: standing.emailHash, standing }, NOW, DEFAULT_CLAIM_CAPS);
    const waiting = at(passportId());
    const sent = at(passportId());
    if (!waiting.ok || !sent.ok) throw new Error("not written");
    landed(waiting.value.passportId);
    landed(sent.value.passportId, PLATFORM_WALLET, PERSON);
    await sweeper().run();
    expect(store.read().tickets.find((one) => one.ticketId === waiting.value.ticketId)).toMatchObject({ state: "accepted", destination: PERSON, terms });
    expect(stateOf(sent.value.ticketId)).toBe("delivered");
  });

  it("expires waiting offers written under an older pepper (P29)", async () => {
    const old = await openTicket("ram@example.com");
    const rotated = claimSweeper({ store, chain, platforms, pepper: { secret: Buffer.alloc(32, 2), version: "2" }, log: () => undefined });
    await rotated.run();
    expect(stateOf(old.ticketId)).toBe("expired");
  });
});
