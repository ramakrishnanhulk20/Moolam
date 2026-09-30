// What this file does not cover: the real verify service, the real chain and the real OpenAI API.
// The kit's chain and service calls and OpenAI's client are stood in for, so these tests prove what
// Dreamloom's server does with each answer, not that the answers come. transferPassport's address
// checks are the kit's real code, since they run before any network call. The co-sign worker, the
// secrets sweep and the settings rules have their own files.
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { APIError } from "openai";
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
const CONSENT_TX = `0x${"c3".repeat(32)}`;
const HOLDER = getAddress("0x1234567890abcdef1234567890abcdef12345678");

let dataDir: string;

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

async function server(overrides: Record<string, string> = {}) {
  settings(overrides);
  vi.resetModules();
  const weave = await import("@/app/api/weave/route");
  const picture = await import("@/app/api/pictures/[id]/route");
  const image = await import("@/app/api/pictures/[id]/image/route");
  const cosign = await import("@/app/api/pictures/[id]/cosign/route");
  const register = await import("@/app/api/pictures/[id]/register/route");
  const move = await import("@/app/api/pictures/[id]/move/route");
  const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
  return {
    weave: (body: unknown, opts: Opts = {}) => weave.POST(req("/api/weave", "POST", body, opts)),
    get: (id: string, opts: Opts = {}) => picture.GET(req(`/api/pictures/${id}`, "GET", undefined, opts), ctx(id)),
    image: (id: string, opts: Opts = {}) => image.GET(req(`/api/pictures/${id}/image`, "GET", undefined, opts), ctx(id)),
    cosign: (id: string, body: unknown, opts: Opts = {}) => cosign.POST(req(`/api/pictures/${id}/cosign`, "POST", body, opts), ctx(id)),
    register: (id: string, body: unknown, opts: Opts = {}) => register.POST(req(`/api/pictures/${id}/register`, "POST", body, opts), ctx(id)),
    move: (id: string, body: unknown, opts: Opts = {}) => move.POST(req(`/api/pictures/${id}/move`, "POST", body, opts), ctx(id)),
  };
}

interface Opts {
  cookie?: string;
  ip?: string;
  origin?: string;
  /** The Origin header. Dreamloom's own unless set; null sends none. */
  sentFrom?: string | null;
}

function req(pathname: string, method: string, body: unknown, opts: Opts): Request {
  const headers = new Headers();
  if (body !== undefined) headers.set("content-type", "application/json");
  if (opts.cookie !== undefined) headers.set("cookie", opts.cookie);
  if (opts.ip !== undefined) headers.set("x-forwarded-for", opts.ip);
  const sentFrom = opts.sentFrom === undefined ? "http://localhost:3300" : opts.sentFrom;
  if (method === "POST" && sentFrom !== null) headers.set("origin", sentFrom);
  return new Request(`${opts.origin ?? "http://localhost:3300"}${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function drawsPng(): void {
  openai.generate.mockResolvedValue({ data: [{ b64_json: PNG.toString("base64") }] });
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

async function registered(s: Server, opts: Opts = {}) {
  registers();
  const picture = await weaveOne(s, opts);
  expect((await s.register(picture.id, { terms: "noAi" }, { cookie: picture.cookie })).status).toBe(200);
  return picture;
}

function pictureFiles(): string[] {
  try {
    return readdirSync(path.join(dataDir, "pictures"));
  } catch {
    return [];
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

// The first import of the routes transforms viem and the kit, which alone can take longer than a test.
beforeAll(async () => {
  await import("@/lib/server/routes");
}, 60_000);

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "dreamloom-routes-"));
  vi.resetAllMocks();
  sdk.transferPassport.mockImplementation((...args: unknown[]) => sdk.realTransfer(...args));
  drawsPng();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("D1: nothing spends past the caps", () => {
  it("stops one address at its daily weaves, whatever it puts on the left of X-Forwarded-For", async () => {
    const s = await server({ WEAVES_PER_ADDRESS_PER_DAY: "2" });
    await weaveOne(s, { ip: "203.0.113.9" });
    await weaveOne(s, { ip: "1.1.1.1, 203.0.113.9" });
    const third = await s.weave({ prompt: "one more lighthouse" }, { ip: "9.9.9.9, 203.0.113.9" });
    expect(third.status).toBe(429);
    expect(await third.json()).toEqual({ error: "limit", scope: "address" });
    expect(openai.generate).toHaveBeenCalledTimes(2);
    await weaveOne(s, { ip: "203.0.113.10" });
  });

  it("stops everyone at the daily total", async () => {
    const s = await server({ WEAVES_PER_DAY: "2" });
    await weaveOne(s, { ip: "203.0.113.1" });
    await weaveOne(s, { ip: "203.0.113.2" });
    const third = await s.weave({ prompt: "a third lighthouse" }, { ip: "203.0.113.3" });
    expect(third.status).toBe(429);
    expect(await third.json()).toEqual({ error: "limit", scope: "day" });
  });

  it("counts a weave before the model is called, so a second request cannot slip into the last slot", async () => {
    const s = await server({ WEAVES_PER_DAY: "1" });
    const pending = deferred<unknown>();
    openai.generate.mockReturnValueOnce(pending.promise);
    const first = s.weave({ prompt: "a slow lighthouse" }, { ip: "203.0.113.1" });
    await vi.waitFor(() => expect(openai.generate).toHaveBeenCalledTimes(1));
    const second = await s.weave({ prompt: "a quick lighthouse" }, { ip: "203.0.113.2" });
    expect(second.status).toBe(429);
    pending.resolve({ data: [{ b64_json: PNG.toString("base64") }] });
    expect((await first).status).toBe(200);
  });

  it("starts a fresh count on a new UTC day", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-01T23:59:00Z"));
    const s = await server({ WEAVES_PER_DAY: "1" });
    await weaveOne(s);
    expect((await s.weave({ prompt: "still the same day" })).status).toBe(429);
    vi.setSystemTime(new Date("2026-10-02T00:01:00Z"));
    await weaveOne(s);
  });

  it("stops registrations at the daily cap", async () => {
    const s = await server({ REGISTRATIONS_PER_DAY: "1" });
    await registered(s);
    const second = await weaveOne(s);
    const res = await s.register(second.id, { terms: "open" }, { cookie: second.cookie });
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "limit", scope: "day" });
    expect(sdk.registerAsPlatform).toHaveBeenCalledTimes(1);
    expect(((await (await s.get(second.id, { cookie: second.cookie })).json()) as { state: string }).state).toBe("woven");
  });

  it("stops co-signs and moves at their daily caps", async () => {
    const s = await server({ COSIGNS_PER_DAY: "1", MOVES_PER_DAY: "1" });
    sdk.startCosign.mockResolvedValue({ handle: "c0".repeat(16), cosignUrl: `https://moolam.example.com/cosign#${"c0".repeat(16)}`, passportId: PASSPORT, openBy: 4_000_000_000 });
    sdk.waitForCreator.mockReturnValue(new Promise(() => {}));
    const a = await weaveOne(s);
    expect((await s.cosign(a.id, { terms: "open" }, { cookie: a.cookie })).status).toBe(200);
    const b = await weaveOne(s, { cookie: a.cookie });
    expect((await s.cosign(b.id, { terms: "open" }, { cookie: a.cookie })).status).toBe(429);

    sdk.transferPassport.mockResolvedValue({ passportId: PASSPORT, from: WALLET, to: HOLDER, txHash: TX, blockNumber: 1n });
    const c = await registered(s, { cookie: a.cookie });
    const d = await registered(s, { cookie: a.cookie });
    expect((await s.move(c.id, { address: HOLDER }, { cookie: a.cookie })).status).toBe(200);
    const res = await s.move(d.id, { address: HOLDER }, { cookie: a.cookie });
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "limit", scope: "day" });
    expect(sdk.transferPassport).toHaveBeenCalledTimes(1);
  });

  it("closes each action whose cap is 0 before anything is called", async () => {
    for (const name of ["WEAVES_PER_ADDRESS_PER_DAY", "WEAVES_PER_DAY"]) {
      const s = await server({ [name]: "0" });
      const res = await s.weave({ prompt: "a closed lighthouse" });
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: "closed" });
    }
    expect(openai.generate).not.toHaveBeenCalled();

    const s = await server({ REGISTRATIONS_PER_DAY: "0", COSIGNS_PER_DAY: "0" });
    const p = await weaveOne(s);
    expect(await (await s.register(p.id, { terms: "noAi" }, { cookie: p.cookie })).json()).toEqual({ error: "closed" });
    expect(await (await s.cosign(p.id, { terms: "noAi" }, { cookie: p.cookie })).json()).toEqual({ error: "closed" });
    expect(sdk.registerAsPlatform).not.toHaveBeenCalled();
    expect(sdk.startCosign).not.toHaveBeenCalled();

    const m = await server({ MOVES_PER_DAY: "0" });
    const r = await registered(m);
    const res = await m.move(r.id, { address: HOLDER }, { cookie: r.cookie });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "closed" });
    expect(sdk.transferPassport).not.toHaveBeenCalled();
  });

  it("hands a registration back when the kit refused before sending, and keeps it when something may have been sent", async () => {
    const { MoolamPlatformError } = await import("@moolam/platform");
    const s = await server({ REGISTRATIONS_PER_DAY: "1" });
    const a = await weaveOne(s);
    sdk.registerAsPlatform.mockRejectedValueOnce(new MoolamPlatformError("service-refused", "refused"));
    expect(await (await s.register(a.id, { terms: "noAi" }, { cookie: a.cookie })).json()).toEqual({ error: "upstream" });
    expect(((await (await s.get(a.id, { cookie: a.cookie })).json()) as { state: string }).state).toBe("woven");

    sdk.registerAsPlatform.mockRejectedValueOnce(new MoolamPlatformError("transaction-failed", "reverted", { hash: TX }));
    expect((await s.register(a.id, { terms: "noAi" }, { cookie: a.cookie })).status).toBe(502);
    expect(await (await s.get(a.id, { cookie: a.cookie })).json()).toMatchObject({ state: "failed", failure: "register" });

    const b = await weaveOne(s, { cookie: a.cookie });
    expect((await s.register(b.id, { terms: "noAi" }, { cookie: a.cookie })).status).toBe(429);
  });
});

describe("D2: a picture belongs to the session that wove it", () => {
  it("answers 404 to every other session, to no session and to a malformed cookie, on every route", async () => {
    const s = await server();
    const mine = await weaveOne(s);
    const theirs = await weaveOne(s);
    expect(theirs.cookie).not.toBe(mine.cookie);
    for (const cookie of [theirs.cookie, undefined, "dl_session=nothex", `dl_session=${"A".repeat(32)}`, `${mine.cookie}; ${theirs.cookie}`]) {
      const answers = [
        await s.get(mine.id, { cookie }),
        await s.image(mine.id, { cookie }),
        await s.cosign(mine.id, { terms: "open" }, { cookie }),
        await s.register(mine.id, { terms: "open" }, { cookie }),
        await s.move(mine.id, { address: HOLDER }, { cookie }),
      ];
      for (const res of answers) {
        expect(res.status).toBe(404);
        expect(await res.json()).toEqual({ error: "not-found" });
      }
    }
    expect(sdk.registerAsPlatform).not.toHaveBeenCalled();
    expect(sdk.startCosign).not.toHaveBeenCalled();
    expect((await s.get(mine.id, { cookie: mine.cookie })).status).toBe(200);
  });

  it("answers the same 404 for an id that does not exist", async () => {
    const s = await server();
    const mine = await weaveOne(s);
    expect((await s.get("0".repeat(32), { cookie: mine.cookie })).status).toBe(404);
    expect((await s.get("../counters", { cookie: mine.cookie })).status).toBe(404);
  });

  it("gives the session cookie httpOnly, SameSite=Lax, Path=/ and Secure off localhost", async () => {
    const s = await server();
    const local = await s.weave({ prompt: "a lighthouse on my laptop" });
    const localCookie = local.headers.get("set-cookie")!;
    expect(localCookie).toMatch(/^dl_session=[0-9a-f]{32}; /);
    expect(localCookie).toContain("HttpOnly");
    expect(localCookie).toContain("SameSite=Lax");
    expect(localCookie).toContain("Path=/");
    expect(localCookie).not.toContain("Secure");
    const hosted = await s.weave({ prompt: "a lighthouse on the web" }, { origin: "https://dreamloom.example.com" });
    expect(hosted.headers.get("set-cookie")).toContain("Secure");
    const again = await s.weave({ prompt: "a second lighthouse" }, { cookie: localCookie.split(";")[0] });
    expect(again.headers.get("set-cookie")).toBeNull();
  });

  it("registers a picture once, even when two requests race", async () => {
    const s = await server();
    const pending = deferred<unknown>();
    sdk.registerAsPlatform.mockReturnValueOnce(pending.promise);
    const p = await weaveOne(s);
    const first = s.register(p.id, { terms: "noAi" }, { cookie: p.cookie });
    await vi.waitFor(() => expect(sdk.registerAsPlatform).toHaveBeenCalledTimes(1));
    const racing = await s.register(p.id, { terms: "noAi" }, { cookie: p.cookie });
    expect(racing.status).toBe(409);
    expect(await racing.json()).toEqual({ error: "state" });
    pending.resolve({ passportId: PASSPORT, registerTx: TX, consentTx: CONSENT_TX, signedFile: new Uint8Array(SIGNED_JPEG) });
    expect((await first).status).toBe(200);
    expect((await s.register(p.id, { terms: "noAi" }, { cookie: p.cookie })).status).toBe(409);
    expect((await s.cosign(p.id, { terms: "noAi" }, { cookie: p.cookie })).status).toBe(409);
    expect(sdk.registerAsPlatform).toHaveBeenCalledTimes(1);
  });

  it("moves a passport once", async () => {
    const s = await server();
    sdk.transferPassport.mockResolvedValue({ passportId: PASSPORT, from: WALLET, to: HOLDER, txHash: TX, blockNumber: 1n });
    const p = await registered(s);
    expect((await s.move(p.id, { address: HOLDER }, { cookie: p.cookie })).status).toBe(200);
    const again = await s.move(p.id, { address: HOLDER }, { cookie: p.cookie });
    expect(again.status).toBe(409);
    expect(sdk.transferPassport).toHaveBeenCalledTimes(1);
  });

  it("refuses to move a picture that was not registered in platform mode", async () => {
    const s = await server();
    const p = await weaveOne(s);
    expect((await s.move(p.id, { address: HOLDER }, { cookie: p.cookie })).status).toBe(409);
    expect(sdk.transferPassport).not.toHaveBeenCalled();
  });
});

describe("D4: a passport moves only to a checked address", () => {
  it("refuses a bad, mistyped, zero, registry or own-wallet address through the kit's checks, and spends nothing", async () => {
    const s = await server({ MOVES_PER_DAY: "1" });
    const p = await registered(s);
    const cases: Array<[string, string]> = [
      ["not an address", "address"],
      ["0x1234", "address"],
      [HOLDER.replace(/[a-f]/, (c) => c.toUpperCase()), "address"],
      [`0x${"0".repeat(40)}`, "recipient"],
      [REGISTRY, "recipient"],
      [WALLET, "recipient"],
    ];
    for (const [address, word] of cases) {
      const res = await s.move(p.id, { address }, { cookie: p.cookie });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: word });
    }
    expect((await s.move(p.id, { address: 42 }, { cookie: p.cookie })).status).toBe(400);
    expect(await (await s.get(p.id, { cookie: p.cookie })).json()).toMatchObject({ state: "registered" });

    sdk.transferPassport.mockResolvedValueOnce({ passportId: PASSPORT, from: WALLET, to: HOLDER, txHash: TX, blockNumber: 1n });
    const res = await s.move(p.id, { address: HOLDER.toLowerCase() }, { cookie: p.cookie });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ moveTx: TX, movedTo: HOLDER });
    expect(sdk.transferPassport).toHaveBeenLastCalledWith(PASSPORT, HOLDER.toLowerCase(), expect.anything());
  });
});

describe("D6: a refused prompt spends nothing and makes nothing", () => {
  it("answers 422 with the model's reason, hands both counts back and stores no picture or session", async () => {
    const s = await server({ WEAVES_PER_DAY: "1", WEAVES_PER_ADDRESS_PER_DAY: "1" });
    openai.generate.mockRejectedValueOnce(
      new APIError(400, { message: "Your request was rejected as a result of our safety system." }, "rejected", new Headers()),
    );
    const res = await s.weave({ prompt: "something the model will not draw" });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: "refused", reason: "Your request was rejected as a result of our safety system." });
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(pictureFiles()).toEqual([]);
    await weaveOne(s);
  });

  it("refuses a prompt outside 8 to 600 characters before the model is called", async () => {
    const s = await server();
    for (const prompt of ["short", "        seven  ", "x".repeat(601), 42, undefined]) {
      const res = await s.weave({ prompt });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "prompt" });
    }
    expect(openai.generate).not.toHaveBeenCalled();
  });

  it("keeps the count when the model may have billed, and hands it back when it provably did not", async () => {
    const s = await server({ WEAVES_PER_DAY: "1" });
    openai.generate.mockRejectedValueOnce(new APIError(429, { message: "quota" }, "quota", new Headers()));
    expect(await (await s.weave({ prompt: "a lighthouse in the rain" })).json()).toEqual({ error: "busy" });
    openai.generate.mockRejectedValueOnce(new APIError(500, { message: "oops" }, "oops", new Headers()));
    expect((await s.weave({ prompt: "a lighthouse in the rain" })).status).toBe(503);
    expect((await s.weave({ prompt: "a lighthouse in the rain" })).status).toBe(429);
  });

  it("sends the prompt to the model exactly as typed", async () => {
    const s = await server();
    const prompt = "  A lighthouse,\n at dusk  ";
    await s.weave({ prompt });
    expect(openai.generate.mock.calls[0]![0]).toMatchObject({ model: "gpt-image-1-mini", quality: "medium", size: "1024x1024", prompt });
  });
});

describe("D7: every passport fact comes from the kit's checked result", () => {
  it("says registered only after registerAsPlatform returned, with its ids, and serves the signed copy", async () => {
    const s = await server();
    const pending = deferred<unknown>();
    sdk.registerAsPlatform.mockReturnValueOnce(pending.promise);
    const p = await weaveOne(s);
    const answer = s.register(p.id, { terms: "askFirst" }, { cookie: p.cookie });
    await vi.waitFor(() => expect(sdk.registerAsPlatform).toHaveBeenCalledTimes(1));
    const during = (await (await s.get(p.id, { cookie: p.cookie })).json()) as Record<string, unknown>;
    expect(during.state).toBe("woven");
    expect(during.passportId).toBeUndefined();

    pending.resolve({ passportId: PASSPORT, registerTx: TX, consentTx: CONSENT_TX, signedFile: new Uint8Array(SIGNED_JPEG) });
    expect(await (await answer).json()).toEqual({ passportId: PASSPORT, registerTx: TX, consentTx: CONSENT_TX, title: "a lighthouse at dusk, oil paint" });
    expect(await (await s.get(p.id, { cookie: p.cookie })).json()).toMatchObject({
      state: "registered",
      mode: "platform",
      passportId: PASSPORT,
      registerTx: TX,
      consentTx: CONSENT_TX,
    });
    const served = await s.image(p.id, { cookie: p.cookie });
    expect(served.headers.get("content-type")).toBe("image/jpeg");
    expect(served.headers.get("cache-control")).toBe("no-store");
    expect(Buffer.from(await served.arrayBuffer()).equals(SIGNED_JPEG)).toBe(true);

    const options = sdk.registerAsPlatform.mock.calls[0]![1] as { terms: unknown; title: string };
    expect(await (await s.get(p.id, { cookie: p.cookie })).json()).toMatchObject({ title: "a lighthouse at dusk, oil paint" });
    expect(options.title).toBe("a lighthouse at dusk, oil paint");
    expect(options.terms).toEqual({
      aiTraining: "constrained",
      aiGenerativeTraining: "constrained",
      aiInference: "constrained",
      dataMining: "constrained",
      constraintInfo: "Ask Dreamloom about AI use of this picture.",
    });
  });

  it("never says registered when the kit threw, and names a passport whose terms did not land only from the kit's receipt ids", async () => {
    const { MoolamPlatformError } = await import("@moolam/platform");
    const s = await server();
    const a = await weaveOne(s);
    sdk.registerAsPlatform.mockRejectedValueOnce(new Error("socket hang up"));
    expect((await s.register(a.id, { terms: "noAi" }, { cookie: a.cookie })).status).toBe(502);
    const failed = (await (await s.get(a.id, { cookie: a.cookie })).json()) as Record<string, unknown>;
    expect(failed).toMatchObject({ state: "failed", failure: "register" });
    expect(failed.passportId).toBeUndefined();

    const b = await weaveOne(s, { cookie: a.cookie });
    sdk.registerAsPlatform.mockRejectedValueOnce(
      new MoolamPlatformError("consent-failed", "terms did not land", { passportId: PASSPORT, registerTx: TX, reason: "x" }),
    );
    expect(await (await s.register(b.id, { terms: "noAi" }, { cookie: a.cookie })).json()).toEqual({
      passportId: PASSPORT,
      registerTx: TX,
      consentTx: null,
      title: "a lighthouse at dusk, oil paint",
    });
    expect(await (await s.get(b.id, { cookie: a.cookie })).json()).toMatchObject({ state: "registered", failure: "terms" });
  });

  it("refuses an unknown terms word before anything is claimed", async () => {
    const s = await server();
    const p = await weaveOne(s);
    for (const terms of ["everything", undefined, { aiTraining: "allowed" }]) {
      const res = await s.register(p.id, { terms }, { cookie: p.cookie });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "terms" });
    }
    expect(sdk.registerAsPlatform).not.toHaveBeenCalled();
  });
});

describe("the title is the visitor's choice", () => {
  it("uses a chosen title, trimmed, in the kit call, the answer and the picture", async () => {
    const s = await server();
    registers();
    const p = await weaveOne(s);
    const res = await s.register(p.id, { terms: "open", title: "  Harbour light  " }, { cookie: p.cookie });
    expect(await res.json()).toMatchObject({ title: "Harbour light" });
    expect((sdk.registerAsPlatform.mock.calls[0]![1] as { title: string }).title).toBe("Harbour light");
    expect(await (await s.get(p.id, { cookie: p.cookie })).json()).toMatchObject({ title: "Harbour light" });

    sdk.startCosign.mockResolvedValue({ handle: "c0".repeat(16), cosignUrl: `https://moolam.example.com/cosign#${"c0".repeat(16)}`, passportId: PASSPORT, openBy: 4_000_000_000 });
    sdk.waitForCreator.mockReturnValue(new Promise(() => {}));
    const q = await weaveOne(s, { cookie: p.cookie });
    const opened = await s.cosign(q.id, { terms: "noAi", title: "Ma lumière 灯台" }, { cookie: p.cookie });
    expect(await opened.json()).toMatchObject({ title: "Ma lumière 灯台" });
    expect((sdk.startCosign.mock.calls[0]![1] as { title: string }).title).toBe("Ma lumière 灯台");
  });

  it("refuses a title that is empty, too long, or carries a control or format character, before anything is claimed", async () => {
    const s = await server();
    const p = await weaveOne(s);
    const hidden = (code: number) => `mark${String.fromCharCode(code)}here`;
    const bad = ["", "   ", "x".repeat(121), 42, null, "line\nbreak", "tab\there", ...[0x07, 0x200b, 0x202e, 0xad, 0xfeff, 0xe000, 0x2028].map(hidden)];
    for (const title of bad) {
      for (const res of [await s.register(p.id, { terms: "open", title }, { cookie: p.cookie }), await s.cosign(p.id, { terms: "open", title }, { cookie: p.cookie })]) {
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error: "title" });
      }
    }
    expect(sdk.registerAsPlatform).not.toHaveBeenCalled();
    expect(sdk.startCosign).not.toHaveBeenCalled();
    expect(await (await s.get(p.id, { cookie: p.cookie })).json()).toMatchObject({ state: "woven" });
    registers();
    expect((await s.register(p.id, { terms: "open", title: "x".repeat(120) }, { cookie: p.cookie })).status).toBe(200);
  });

  it("uses the prompt cut to 120 characters when no title is given", async () => {
    const s = await server();
    registers();
    const prompt = `${"a lighthouse ".repeat(12)}\t${String.fromCharCode(7)}at dusk`;
    const res = await s.weave({ prompt });
    const cookie = res.headers.get("set-cookie")!.split(";")[0]!;
    const { pictureId } = (await res.json()) as { pictureId: string };
    const answer = (await (await s.register(pictureId, { terms: "noAi" }, { cookie })).json()) as { title: string };
    expect(answer.title).toBe("a lighthouse ".repeat(12).slice(0, 120).trim());
    expect(answer.title.length).toBeLessThanOrEqual(120);
    expect((sdk.registerAsPlatform.mock.calls[0]![1] as { title: string }).title).toBe(answer.title);
  });
});

describe("Origin on every POST", () => {
  it("refuses a foreign, a missing, a lookalike or a malformed Origin with 403 before anything runs", async () => {
    const s = await server();
    const p = await weaveOne(s);
    const refused = [
      "https://evil.example.com",
      null,
      "http://localhost:3300.evil.example.com",
      "http://localhost:33000",
      "https://localhost:3300",
      "http://localhost:3300@evil.example.com",
      "http://localhost:3300/api",
      "null",
      "",
    ];
    for (const sentFrom of refused) {
      const answers = [
        await s.weave({ prompt: "a lighthouse from elsewhere" }, { sentFrom }),
        await s.cosign(p.id, { terms: "open" }, { cookie: p.cookie, sentFrom }),
        await s.register(p.id, { terms: "open" }, { cookie: p.cookie, sentFrom }),
        await s.move(p.id, { address: HOLDER }, { cookie: p.cookie, sentFrom }),
      ];
      for (const res of answers) {
        expect(res.status).toBe(403);
        expect(await res.json()).toEqual({ error: "origin" });
      }
    }
    expect(openai.generate).toHaveBeenCalledTimes(1);
    expect(sdk.registerAsPlatform).not.toHaveBeenCalled();
    expect(sdk.startCosign).not.toHaveBeenCalled();
    expect((await s.get(p.id, { cookie: p.cookie, sentFrom: null })).status).toBe(200);
  });

  it("takes the same origin written in another case, since both sides go through one parser", async () => {
    const s = await server({ DREAMLOOM_ORIGIN: "https://Dreamloom.Example.com/" });
    expect((await s.weave({ prompt: "a lighthouse at home" }, { sentFrom: "https://dreamloom.example.com" })).status).toBe(200);
    expect((await s.weave({ prompt: "a lighthouse at home" }, { sentFrom: "http://localhost:3300" })).status).toBe(403);
  });
});
