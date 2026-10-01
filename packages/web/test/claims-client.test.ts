import { describe, expect, it } from "vitest";
import {
  MAX_IDS_PER_CALL,
  acceptClaims,
  readClaims,
  refuseClaims,
  stopStanding,
  unmutePlatform,
  type ClaimsAnswer,
  type Fetcher,
} from "@/lib/claims/client";
import { sayMine, sayNotMine } from "@/lib/claims/answer";
import { termsFromDraft } from "@/lib/claims/offers";
import { refusalFor } from "@/lib/claims/refusal";

/**
 * My pictures' client for the claim routes (WO-264): the token travels in the
 * Authorization header and nowhere else, every refusal word becomes plain words
 * with a next step, an answer cannot hand the page an email, and "Not mine"
 * names that platform's offers and no other's, at most 32 at a time.
 */

const TOKEN = "privy-token-7f3a9c";
const PLATFORM_A = `0x${"a1".repeat(32)}`;
const PLATFORM_B = `0x${"b2".repeat(32)}`;
const WALLET = "0x559F357aDa3A96d11AEa679eC0D622E4AF15F67c";

interface Sent {
  url: string;
  init: RequestInit;
}

function stub(status: number, body: unknown): { fetcher: Fetcher; sent: Sent[] } {
  const sent: Sent[] = [];
  const fetcher: Fetcher = async (url, init) => {
    sent.push({ url, init });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  };
  return { fetcher, sent };
}

function ticket(n: number): string {
  return n.toString(16).padStart(32, "0");
}

function passport(n: number): string {
  return `0x${n.toString(16).padStart(64, "0")}`;
}

function offer(n: number, keyHash: string, name: string) {
  return {
    ticketId: ticket(n),
    passportId: passport(n),
    platform: { name, keyHash },
    verifiedBy: "google",
    preview: null,
    createdAt: 1_790_000_000 - n,
  };
}

const EMPTY: ClaimsAnswer = { offers: [], waiting: [], standing: [], muted: [] };

const TERMS = {
  aiTraining: "notAllowed",
  aiGenerativeTraining: "notAllowed",
  aiInference: "allowed",
  dataMining: "notAllowed",
  constraintInfo: "",
} as const;

describe("the claims client", () => {
  it("sends the Privy token in the Authorization header and nowhere else, on every route", async () => {
    const calls: [string, (fetcher: Fetcher) => Promise<unknown>, unknown][] = [
      ["read", (f) => readClaims(TOKEN, f), EMPTY],
      ["accept", (f) => acceptClaims({ ticketIds: [ticket(1)], terms: TERMS, sendFuture: true }, TOKEN, f), { accepted: [ticket(1)], destination: WALLET }],
      ["refuse", (f) => refuseClaims([ticket(1)], TOKEN, f), { refused: [ticket(1)] }],
      ["unmute", (f) => unmutePlatform(PLATFORM_A as `0x${string}`, TOKEN, f), { ok: true }],
      ["stop", (f) => stopStanding(PLATFORM_A as `0x${string}`, TOKEN, f), { ok: true }],
    ];
    for (const [name, call, body] of calls) {
      const { fetcher, sent } = stub(200, body);
      await call(fetcher);
      expect(sent, name).toHaveLength(1);
      const { url, init } = sent[0];
      const headers = init.headers as Record<string, string>;
      expect(headers.authorization, name).toBe(`Bearer ${TOKEN}`);
      expect(url, name).not.toContain(TOKEN);
      expect(String(init.body ?? ""), name).not.toContain(TOKEN);
      for (const [header, value] of Object.entries(headers)) {
        if (header !== "authorization") expect(value, `${name} ${header}`).not.toContain(TOKEN);
      }
      expect(init.credentials, name).toBe("omit");
      expect(init.referrerPolicy, name).toBe("no-referrer");
      expect(init.cache, name).toBe("no-store");
    }
  });

  it("never sends an empty list or one over 32 ids: it is refused here, before the network", async () => {
    for (const ids of [[], Array.from({ length: MAX_IDS_PER_CALL + 1 }, (_, n) => ticket(n))]) {
      const { fetcher, sent } = stub(200, { refused: [] });
      const refused = await refuseClaims(ids, TOKEN, fetcher);
      const accepted = await acceptClaims({ ticketIds: ids, terms: TERMS, sendFuture: false }, TOKEN, fetcher);
      expect(sent).toHaveLength(0);
      expect(refused.ok).toBe(false);
      expect(accepted.ok).toBe(false);
    }
  });

  it("takes no email from an answer, even one that carries an address", async () => {
    const evil = "someone.else@example.org";
    const { fetcher } = stub(200, {
      email: evil,
      offers: [{ ...offer(1, PLATFORM_A, "Dreamloom"), email: evil, platform: { name: "Dreamloom", keyHash: PLATFORM_A, email: evil } }],
      waiting: [],
      standing: [],
      muted: [],
    });
    const read = await readClaims(TOKEN, fetcher);
    expect(read.ok).toBe(true);
    expect(JSON.stringify(read)).not.toContain(evil);
  });

  it("reads an answer in a shape it does not know as a refusal, never as an empty list", async () => {
    const { fetcher } = stub(200, { offers: "everything" });
    const read = await readClaims(TOKEN, fetcher);
    expect(read).toEqual({ ok: false, refusal: { key: "badResponse", next: "again" } });
  });
});

describe("each refusal word", () => {
  it("maps to its plain words and the one next step", () => {
    const table: [number, string, string, string | undefined][] = [
      [503, "claims-unavailable", "unavailable", "again"],
      [401, "unauthorized", "signIn", "signIn"],
      [429, "limit", "limit", undefined],
      [429, "global-limit", "globalLimit", undefined],
      [502, "privy-unavailable", "privy", "again"],
      [403, "no-wallet", "noWallet", "signIn"],
      [403, "destination", "destination", undefined],
      [404, "not-found", "notFound", "reload"],
      [409, "not-open", "notOpen", "reload"],
      [429, "full", "full", undefined],
      [409, "record-refused", "recordRefused", "again"],
      [400, "ticketIds", "badRequest", "reload"],
      [400, "terms", "badRequest", "reload"],
      [400, "sendFuture", "badRequest", "reload"],
      [400, "platformKeyHash", "badRequest", "reload"],
      [400, "body", "badRequest", "reload"],
    ];
    for (const [status, word, key, next] of table) {
      expect(refusalFor(status, { error: word }), word).toEqual({ key, ...(next === undefined ? {} : { next }), word });
    }
  });

  it("falls back on the status for a word it does not know, and on the network for no answer", () => {
    expect(refusalFor(0, null)).toEqual({ key: "offline", next: "again" });
    expect(refusalFor(429, { statusCode: 429, error: "Too Many Requests" })).toEqual({ key: "limit" });
    expect(refusalFor(401, null)).toEqual({ key: "signIn", next: "signIn" });
    expect(refusalFor(500, { error: "toString" })).toEqual({ key: "badResponse", next: "again" });
  });

  it("has words in English for every key it can name", async () => {
    const en = (await import("@/messages/en.json")).default as { claims: { refusal: Record<string, string>; next: Record<string, string> } };
    for (const key of ["unavailable", "signIn", "limit", "globalLimit", "privy", "noWallet", "destination", "notFound", "notOpen", "full", "recordRefused", "badRequest", "offline", "badResponse"]) {
      expect(en.claims.refusal[key], key).toMatch(/\S/);
    }
    for (const next of ["again", "signIn", "reload"]) {
      expect(en.claims.next[next], next).toMatch(/\S/);
    }
  });
});

describe("the answers to one platform", () => {
  const answer: ClaimsAnswer = {
    ...EMPTY,
    offers: [
      ...Array.from({ length: 40 }, (_, n) => offer(n + 1, PLATFORM_A, "Dreamloom")),
      offer(100, PLATFORM_B, "Elsewhere"),
      offer(101, PLATFORM_B, "Elsewhere"),
    ] as ClaimsAnswer["offers"],
  };

  function bodies(sent: Sent[]): { ticketIds: string[]; terms?: unknown; sendFuture?: boolean }[] {
    return sent.map(({ init }) => JSON.parse(String(init.body)) as { ticketIds: string[] });
  }

  it("Not mine calls refuse with that platform's ids only, in calls of at most 32", async () => {
    const sent: Sent[] = [];
    const fetcher: Fetcher = async (url, init) => {
      sent.push({ url, init });
      const ids = (JSON.parse(String(init.body)) as { ticketIds: string[] }).ticketIds;
      return new Response(JSON.stringify({ refused: ids }), { status: 200 });
    };
    const outcome = await sayNotMine(answer, PLATFORM_A, TOKEN, fetcher);
    expect(outcome.ok).toBe(true);
    expect(sent.every(({ url }) => url.endsWith("/claims/refuse"))).toBe(true);
    const sentIds = bodies(sent).map((body) => body.ticketIds);
    expect(sentIds.map((ids) => ids.length)).toEqual([32, 8]);
    expect(sentIds.flat().sort()).toEqual(Array.from({ length: 40 }, (_, n) => ticket(n + 1)).sort());
    expect(sentIds.flat()).not.toContain(ticket(100));
    expect(sentIds.flat()).not.toContain(ticket(101));
  });

  it("These are mine sends that platform's ids with the chosen terms and the tick, and stops at the first refusal", async () => {
    const sent: Sent[] = [];
    const fetcher: Fetcher = async (url, init) => {
      sent.push({ url, init });
      return new Response(JSON.stringify({ error: "not-open" }), { status: 409 });
    };
    const draft = {
      consent: { aiTraining: "notAllowed", aiGenerativeTraining: "notAllowed", aiInference: "notAllowed", dataMining: "notAllowed" },
      // Left over from a choice that asked for conditions: the contract refuses it with no use constrained.
      constraintInfo: "leftover",
    } as const;
    const outcome = await sayMine(answer, PLATFORM_B, { terms: termsFromDraft(draft), sendFuture: true }, TOKEN, fetcher);
    expect(outcome).toEqual({ ok: false, refusal: { key: "notOpen", next: "reload", word: "not-open" } });
    expect(sent).toHaveLength(1);
    const [body] = bodies(sent);
    expect(body.ticketIds).toEqual([ticket(100), ticket(101)]);
    expect(body.sendFuture).toBe(true);
    expect(body.terms).toEqual({ ...draft.consent, constraintInfo: "" });
  });
});
