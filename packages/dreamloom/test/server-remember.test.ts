// What this file does not cover: the real verify service, the real chain and a real browser. The
// kit's service and chain calls are stood in for, so these tests prove what Dreamloom's server does
// with a remembered address and each answer, not that the answers come. The address checks in
// recipientProblem and in transferPassport are the real code, since both run before any network call.
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({
  registerAsPlatform: vi.fn(),
  startCosign: vi.fn(),
  resumeCosign: vi.fn(),
  waitForCreator: vi.fn(),
  signAsAgent: vi.fn(),
  waitForPassport: vi.fn(),
  transferPassport: vi.fn(),
  runDeliveries: vi.fn(),
  realTransfer: undefined as unknown as (...args: unknown[]) => Promise<unknown>,
}));

vi.mock("@moolam/platform", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@moolam/platform")>();
  sdk.realTransfer = actual.transferPassport as never;
  return {
    ...actual,
    registerAsPlatform: sdk.registerAsPlatform,
    startCosign: sdk.startCosign,
    resumeCosign: sdk.resumeCosign,
    waitForCreator: sdk.waitForCreator,
    signAsAgent: sdk.signAsAgent,
    waitForPassport: sdk.waitForPassport,
    transferPassport: sdk.transferPassport,
    runDeliveries: sdk.runDeliveries,
  };
});

const openai = vi.hoisted(() => ({ generate: vi.fn() }));

vi.mock("openai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openai")>();
  class StandIn {
    images = { generate: openai.generate };
  }
  return { ...actual, default: StandIn };
});

const WALLET_KEY = `0x${"5ec1".repeat(16)}` as const;
const WALLET = privateKeyToAccount(WALLET_KEY).address;
const REGISTRY = "0xa19188801E5DC93CD925884d73e4DaFc2bcb80C0";
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)]);
const SIGNED_JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 9)]);
const PASSPORT = `0x${"a1".repeat(32)}`;
const TX = `0x${"b2".repeat(32)}`;
const MOVE_TX = `0x${"d4".repeat(32)}`;
const CONSENT_TX = `0x${"c3".repeat(32)}`;
const HOLDER = getAddress("0x1234567890abcdef1234567890abcdef12345678");
const OTHER = getAddress("0x8617e340b3d01fa5f11f306f4090fd50e238070d");

let dataDir: string;
let logged: string[];

function settings(overrides: Record<string, string>): void {
  const base: Record<string, string> = {
    MOOLAM_VERIFY_URL: "https://verify.example.com",
    MOOLAM_SITE_URL: "https://moolam.example.com",
    MOOLAM_INDEX_URL: "https://index.example.com/graphql",
    MONAD_RPC_URL: "https://rpc.example.com",
    DREAMLOOM_ORIGIN: "http://localhost:3300",
    DREAMLOOM_WALLET_KEY: WALLET_KEY,
    DREAMLOOM_PASSKEY_KEY: `0x${"5ec2".repeat(16)}`,
    DREAMLOOM_PASSKEY_RP_ID: "dreamloom.example.com",
    DREAMLOOM_PLATFORM_KEY: "5ec0".repeat(16),
    OPENAI_API_KEY: "sk-test",
    DATA_DIR: dataDir,
    WEAVES_PER_ADDRESS_PER_DAY: "",
    WEAVES_PER_DAY: "",
    REGISTRATIONS_PER_DAY: "",
    MOVES_PER_DAY: "",
    COSIGNS_PER_DAY: "",
  };
  for (const [name, value] of Object.entries({ ...base, ...overrides })) vi.stubEnv(name, value);
}

interface Opts {
  cookie?: string;
  /** The Origin header. Dreamloom's own unless set; null sends none. */
  sentFrom?: string | null;
}

function req(pathname: string, method: string, body: unknown, opts: Opts): Request {
  const headers = new Headers();
  if (body !== undefined) headers.set("content-type", "application/json");
  if (opts.cookie !== undefined) headers.set("cookie", opts.cookie);
  const sentFrom = opts.sentFrom === undefined ? "http://localhost:3300" : opts.sentFrom;
  if (method !== "GET" && sentFrom !== null) headers.set("origin", sentFrom);
  return new Request(`http://localhost:3300${pathname}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

async function server(overrides: Record<string, string> = {}) {
  settings(overrides);
  vi.resetModules();
  const weave = await import("@/app/api/weave/route");
  const picture = await import("@/app/api/pictures/[id]/route");
  const register = await import("@/app/api/pictures/[id]/register/route");
  const move = await import("@/app/api/pictures/[id]/move/route");
  const address = await import("@/app/api/session/address/route");
  const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
  return {
    weave: (body: unknown, opts: Opts = {}) => weave.POST(req("/api/weave", "POST", body, opts)),
    get: (id: string, opts: Opts = {}) => picture.GET(req(`/api/pictures/${id}`, "GET", undefined, opts), ctx(id)),
    register: (id: string, body: unknown, opts: Opts = {}) => register.POST(req(`/api/pictures/${id}/register`, "POST", body, opts), ctx(id)),
    move: (id: string, body: unknown, opts: Opts = {}) => move.POST(req(`/api/pictures/${id}/move`, "POST", body, opts), ctx(id)),
    remembered: (opts: Opts = {}) => address.GET(req("/api/session/address", "GET", undefined, opts)),
    remember: (body: unknown, opts: Opts = {}) => address.POST(req("/api/session/address", "POST", body, opts)),
    forget: (opts: Opts = {}) => address.DELETE(req("/api/session/address", "DELETE", undefined, opts)),
  };
}

type Server = Awaited<ReturnType<typeof server>>;

async function weaveOne(s: Server, opts: Opts = {}): Promise<{ id: string; cookie: string }> {
  const res = await s.weave({ prompt: "a lighthouse at dusk, oil paint" }, opts);
  expect(res.status).toBe(200);
  const { pictureId } = (await res.json()) as { pictureId: string };
  const cookie = opts.cookie ?? res.headers.get("set-cookie")!.split(";")[0]!;
  return { id: pictureId, cookie };
}

function registers(): void {
  sdk.registerAsPlatform.mockResolvedValue({ passportId: PASSPORT, registerTx: TX, consentTx: CONSENT_TX, signedFile: new Uint8Array(SIGNED_JPEG) });
}

function moves(): void {
  sdk.transferPassport.mockImplementation(async (passportId: string, to: string) => ({
    passportId,
    from: WALLET,
    to: getAddress(to),
    txHash: MOVE_TX,
    blockNumber: 1n,
  }));
}

/** A session that wove a picture and asked Dreamloom to remember `address`. */
async function rememberedSession(s: Server, address = HOLDER): Promise<string> {
  const { cookie } = await weaveOne(s);
  const res = await s.remember({ address }, { cookie });
  expect(res.status).toBe(200);
  return cookie;
}

function counters(): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(dataDir, "counters.json"), "utf8")) as Record<string, unknown>;
}

async function stateOf(s: Server, id: string, cookie: string): Promise<Record<string, unknown>> {
  return (await (await s.get(id, { cookie })).json()) as Record<string, unknown>;
}

beforeAll(async () => {
  await import("@/lib/server/routes");
}, 60_000);

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "dreamloom-remember-"));
  vi.resetAllMocks();
  sdk.transferPassport.mockImplementation((...args: unknown[]) => sdk.realTransfer(...args));
  openai.generate.mockResolvedValue({ data: [{ b64_json: PNG.toString("base64") }] });
  logged = [];
  for (const method of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      logged.push(args.map((a) => (a instanceof Error ? `${a.name} ${a.message} ${a.stack}` : String(a))).join(" "));
    });
  }
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("remembering, showing and forgetting the address", () => {
  it("remembers a checked address for this session, shows it, and forgets it", async () => {
    const s = await server();
    const { cookie } = await weaveOne(s);
    expect(await (await s.remembered({ cookie })).json()).toEqual({ address: null });

    const set = await s.remember({ address: HOLDER.toLowerCase() }, { cookie });
    expect(set.status).toBe(200);
    expect(await set.json()).toEqual({ address: HOLDER });
    expect(await (await s.remembered({ cookie })).json()).toEqual({ address: HOLDER });

    const record = readdirSync(path.join(dataDir, "sessions"));
    expect(record).toHaveLength(1);
    expect(record[0]).toMatch(/^[0-9a-f]{64}\.json$/);
    expect(record[0]).not.toContain(cookie.split("=")[1]!);
    expect(JSON.parse(readFileSync(path.join(dataDir, "sessions", record[0]!), "utf8"))).toMatchObject({ address: HOLDER, sendStraight: true });

    const gone = await s.forget({ cookie });
    expect(await gone.json()).toEqual({ address: null });
    expect(await (await s.remembered({ cookie })).json()).toEqual({ address: null });
    expect(readdirSync(path.join(dataDir, "sessions"))).toEqual([]);
    expect((await s.forget({ cookie })).status).toBe(200);
  });

  it("keeps only an address that passes the kit's transfer checks, with fixed words for the rest", async () => {
    const s = await server();
    const { cookie } = await weaveOne(s);
    const cases: Array<[unknown, string]> = [
      ["not an address", "address"],
      ["0x1234", "address"],
      [HOLDER.replace(/[a-f]/, (c) => c.toUpperCase()), "address"],
      [42, "address"],
      [`${HOLDER}${"0".repeat(80)}`, "address"],
      [`0x${"0".repeat(40)}`, "recipient"],
      [REGISTRY, "recipient"],
      [WALLET, "recipient"],
      [WALLET.toLowerCase(), "recipient"],
    ];
    for (const [address, word] of cases) {
      const res = await s.remember({ address }, { cookie });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: word });
    }
    expect(await (await s.remembered({ cookie })).json()).toEqual({ address: null });
  });

  it("keeps nothing for no session, a made-up session, or a post from another site", async () => {
    const s = await server();
    const { cookie } = await weaveOne(s);
    for (const opts of [{}, { cookie: `dl_session=${"f".repeat(32)}` }, { cookie: "dl_session=nothex" }]) {
      const res = await s.remember({ address: HOLDER }, opts);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "not-found" });
    }
    for (const sentFrom of ["https://evil.example.com", null]) {
      expect(await (await s.remember({ address: HOLDER }, { cookie, sentFrom })).json()).toEqual({ error: "origin" });
      expect((await s.forget({ cookie, sentFrom })).status).toBe(403);
    }
    expect(await (await s.remembered({ cookie })).json()).toEqual({ address: null });
  });
});

describe("D2: another session never sees or uses the remembered address", () => {
  it("answers none to every other session, cannot forget it for them, and claims nothing with it", async () => {
    const s = await server();
    registers();
    moves();
    const mine = await rememberedSession(s);
    const theirs = await weaveOne(s);

    for (const cookie of [theirs.cookie, undefined, `${mine}; ${theirs.cookie}`]) {
      const answer = await s.remembered({ cookie });
      expect(await answer.text()).not.toContain(HOLDER.slice(2, 12).toLowerCase());
    }
    expect(await (await s.remembered({ cookie: theirs.cookie })).json()).toEqual({ address: null });

    await s.forget({ cookie: theirs.cookie });
    expect(await (await s.remembered({ cookie: mine })).json()).toEqual({ address: HOLDER });

    const res = await s.register(theirs.id, { terms: "noAi", claim: true }, { cookie: theirs.cookie });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "forgotten" });
    expect(sdk.registerAsPlatform).not.toHaveBeenCalled();
    expect(sdk.transferPassport).not.toHaveBeenCalled();
    expect(await stateOf(s, theirs.id, theirs.cookie)).toMatchObject({ state: "woven" });

    // Their own remembered address goes to their own picture, never mine.
    await s.remember({ address: OTHER }, { cookie: theirs.cookie });
    expect((await s.register(theirs.id, { terms: "noAi", claim: true }, { cookie: theirs.cookie })).status).toBe(200);
    expect(sdk.transferPassport).toHaveBeenLastCalledWith(PASSPORT, OTHER, expect.anything());
    expect(await (await s.remembered({ cookie: mine })).json()).toEqual({ address: HOLDER });
  });
});

describe("the automatic claim", () => {
  it("registers in platform mode, then moves the passport to the remembered address, in one call", async () => {
    const s = await server();
    registers();
    moves();
    const cookie = await rememberedSession(s);
    const p = await weaveOne(s, { cookie });
    const res = await s.register(p.id, { terms: "open", title: "Harbour light", claim: true }, { cookie });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      passportId: PASSPORT,
      registerTx: TX,
      consentTx: CONSENT_TX,
      title: "Harbour light",
      moveTx: MOVE_TX,
      movedTo: HOLDER,
    });
    expect(sdk.registerAsPlatform).toHaveBeenCalledTimes(1);
    expect(sdk.transferPassport).toHaveBeenCalledTimes(1);
    expect(sdk.transferPassport).toHaveBeenCalledWith(PASSPORT, HOLDER, expect.anything());
    expect(sdk.registerAsPlatform.mock.invocationCallOrder[0]).toBeLessThan(sdk.transferPassport.mock.invocationCallOrder[0]!);
    expect(await stateOf(s, p.id, cookie)).toMatchObject({ state: "moved", mode: "platform", moveTx: MOVE_TX, movedTo: HOLDER });
    expect(counters()).toMatchObject({ register: 1, move: 1 });
  });

  it("counts both caps before any spend: a second claim, a plain register and a hand move are all refused at 1 a day", async () => {
    const s = await server({ REGISTRATIONS_PER_DAY: "1", MOVES_PER_DAY: "1" });
    registers();
    moves();
    const cookie = await rememberedSession(s);
    const a = await weaveOne(s, { cookie });
    let resolve!: (value: unknown) => void;
    const pending = { promise: new Promise<unknown>((r) => (resolve = r)), resolve: (value: unknown) => resolve(value) };
    sdk.registerAsPlatform.mockReturnValueOnce(pending.promise);
    const first = s.register(a.id, { terms: "noAi", claim: true }, { cookie });
    await vi.waitFor(() => expect(sdk.registerAsPlatform).toHaveBeenCalledTimes(1));
    // Both counts are taken while the register is still on its way, before anything was spent.
    expect(counters()).toMatchObject({ register: 1, move: 1 });
    pending.resolve({ passportId: PASSPORT, registerTx: TX, consentTx: CONSENT_TX, signedFile: new Uint8Array(SIGNED_JPEG) });
    expect((await first).status).toBe(200);

    const b = await weaveOne(s, { cookie });
    for (const body of [{ terms: "noAi", claim: true }, { terms: "noAi" }]) {
      const res = await s.register(b.id, body, { cookie });
      expect(res.status).toBe(429);
      expect(await res.json()).toEqual({ error: "limit", scope: "day" });
    }
    expect(sdk.registerAsPlatform).toHaveBeenCalledTimes(1);
    expect(sdk.transferPassport).toHaveBeenCalledTimes(1);
    expect(await stateOf(s, b.id, cookie)).toMatchObject({ state: "woven" });
  });

  it("refuses cleanly when the move cap is reached or closed: nothing registered, the register count handed back", async () => {
    const s = await server({ REGISTRATIONS_PER_DAY: "5", MOVES_PER_DAY: "1" });
    registers();
    moves();
    const cookie = await rememberedSession(s);
    const held = await weaveOne(s, { cookie });
    expect((await s.register(held.id, { terms: "noAi" }, { cookie })).status).toBe(200);
    expect((await s.move(held.id, { address: HOLDER }, { cookie })).status).toBe(200);
    expect(counters()).toMatchObject({ register: 1, move: 1 });

    const p = await weaveOne(s, { cookie });
    const res = await s.register(p.id, { terms: "noAi", claim: true }, { cookie });
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "limit", scope: "day" });
    expect(sdk.registerAsPlatform).toHaveBeenCalledTimes(1);
    expect(counters()).toMatchObject({ register: 1, move: 1 });
    expect(await stateOf(s, p.id, cookie)).toMatchObject({ state: "woven" });
    // The picture was let go, so a plain register still works.
    expect((await s.register(p.id, { terms: "noAi" }, { cookie })).status).toBe(200);

    const closed = await server({ MOVES_PER_DAY: "0" });
    const c = await rememberedSession(closed);
    const q = await weaveOne(closed, { cookie: c });
    const shut = await closed.register(q.id, { terms: "noAi", claim: true }, { cookie: c });
    expect(shut.status).toBe(503);
    expect(await shut.json()).toEqual({ error: "closed" });
    expect(sdk.registerAsPlatform).toHaveBeenCalledTimes(2);
    expect(counters()).toMatchObject({ register: 2 });
  });

  it("refuses cleanly when the register cap is reached, without taking a move", async () => {
    const s = await server({ REGISTRATIONS_PER_DAY: "0" });
    const cookie = await rememberedSession(s);
    const p = await weaveOne(s, { cookie });
    const res = await s.register(p.id, { terms: "noAi", claim: true }, { cookie });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "closed" });
    expect(sdk.registerAsPlatform).not.toHaveBeenCalled();
    expect(sdk.transferPassport).not.toHaveBeenCalled();
  });

  it("keeps the passport held when the move fails after the register, says so in fixed words, and hands a refused move back", async () => {
    const { MoolamPlatformError } = await import("@moolam/platform");
    const s = await server({ MOVES_PER_DAY: "1" });
    registers();
    const cookie = await rememberedSession(s);
    const p = await weaveOne(s, { cookie });
    sdk.transferPassport.mockRejectedValueOnce(new MoolamPlatformError("not-holder", "the platform's wallet does not hold this passport"));
    const res = await s.register(p.id, { terms: "noAi", claim: true }, { cookie });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ passportId: PASSPORT, registerTx: TX, consentTx: CONSENT_TX, title: "a lighthouse at dusk, oil paint", claim: "not-holder" });
    expect(await stateOf(s, p.id, cookie)).toMatchObject({ state: "registered", mode: "platform" });
    expect(counters()).toMatchObject({ register: 1, move: 0 });

    moves();
    expect((await s.move(p.id, { address: HOLDER }, { cookie })).status).toBe(200);
  });

  it("claims nothing once the address is forgotten, and leaves the picture free for either way", async () => {
    const s = await server();
    registers();
    const cookie = await rememberedSession(s);
    await s.forget({ cookie });
    const p = await weaveOne(s, { cookie });
    const res = await s.register(p.id, { terms: "noAi", claim: true }, { cookie });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "forgotten" });
    expect(sdk.registerAsPlatform).not.toHaveBeenCalled();
    expect((await s.register(p.id, { terms: "noAi" }, { cookie })).status).toBe(200);
  });

  it("writes no address and no session into any log line, even when things fail", async () => {
    const { MoolamPlatformError } = await import("@moolam/platform");
    const s = await server();
    registers();
    const cookie = await rememberedSession(s);
    const p = await weaveOne(s, { cookie });
    sdk.transferPassport.mockRejectedValueOnce(new Error(`eth_sendRawTransaction to ${HOLDER} failed`));
    await s.register(p.id, { terms: "noAi", claim: true }, { cookie });
    const q = await weaveOne(s, { cookie });
    sdk.registerAsPlatform.mockRejectedValueOnce(new MoolamPlatformError("service-refused", `refused for ${HOLDER}`));
    await s.register(q.id, { terms: "noAi", claim: true }, { cookie });
    await s.remember({ address: WALLET }, { cookie });
    await s.forget({ cookie });

    expect(logged.length).toBeGreaterThan(0);
    const session = cookie.split("=")[1]!;
    for (const line of logged) {
      expect(line.toLowerCase()).not.toContain(HOLDER.slice(2).toLowerCase());
      expect(line.toLowerCase()).not.toContain(WALLET.slice(2).toLowerCase());
      expect(line).not.toContain(session);
    }
  });
});
