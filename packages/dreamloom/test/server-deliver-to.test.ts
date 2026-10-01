// What this file does not cover: the verify service's tickets and the kit's prepare body, which the
// verifier's and the kit's own tests prove. The kit is stood in for, so this file proves what
// Dreamloom hands the kit (deliverTo, only for a signed-in visitor, only with verifiedBy "google")
// and what it writes and answers after each result, and which of Dreamloom's two statements each
// register path hands the kit. Sign-in runs the real routes against the offline Google stand-in.
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { MoolamPlatformError } from "@moolam/platform";
import { getAddress } from "viem";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { EMAIL, MASKED, goodClaims, standInForGoogle, type GoogleStandIn, CLIENT_ID, CLIENT_SECRET } from "./google-stand-in";

const sdk = vi.hoisted(() => ({
  registerAsPlatform: vi.fn(),
  startCosign: vi.fn(),
  resumeCosign: vi.fn(),
  transferPassport: vi.fn(),
  runDeliveries: vi.fn(),
}));

vi.mock("@moolam/platform", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@moolam/platform")>();
  return { ...actual, ...sdk };
});

const openai = vi.hoisted(() => ({ generate: vi.fn() }));

vi.mock("openai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openai")>();
  class StandIn {
    images = { generate: openai.generate };
  }
  return { ...actual, default: StandIn };
});

const ORIGIN = "http://localhost:3300";
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)]);
const SIGNED_JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 9)]);
const PASSPORT = `0x${"a1".repeat(32)}`;
const TX = `0x${"b2".repeat(32)}`;
const CONSENT_TX = `0x${"c3".repeat(32)}`;
const MOVE_TX = `0x${"d4".repeat(32)}`;
const HOLDER = getAddress("0x1234567890abcdef1234567890abcdef12345678");

let dataDir: string;
let google: GoogleStandIn;
let logged: string[];

function settings(): void {
  const values: Record<string, string> = {
    MOOLAM_VERIFY_URL: "https://verify.example.com",
    MOOLAM_SITE_URL: "https://moolam.example.com",
    MOOLAM_INDEX_URL: "https://index.example.com/graphql",
    MONAD_RPC_URL: "https://rpc.example.com",
    DREAMLOOM_ORIGIN: ORIGIN,
    DREAMLOOM_WALLET_KEY: `0x${"5ec1".repeat(16)}`,
    DREAMLOOM_PASSKEY_KEY: `0x${"5ec2".repeat(16)}`,
    DREAMLOOM_PASSKEY_RP_ID: "dreamloom.example.com",
    DREAMLOOM_PLATFORM_KEY: "5ec0".repeat(16),
    OPENAI_API_KEY: "sk-test",
    GOOGLE_CLIENT_ID: CLIENT_ID,
    GOOGLE_CLIENT_SECRET: CLIENT_SECRET,
    DATA_DIR: dataDir,
  };
  for (const [name, value] of Object.entries(values)) vi.stubEnv(name, value);
}

function req(pathname: string, method: string, body: unknown, cookie?: string): Request {
  const headers = new Headers();
  if (body !== undefined) headers.set("content-type", "application/json");
  if (cookie !== undefined) headers.set("cookie", cookie);
  if (method === "POST" || method === "DELETE") headers.set("origin", ORIGIN);
  return new Request(`${ORIGIN}${pathname}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

async function server() {
  settings();
  vi.resetModules();
  const weave = await import("@/app/api/weave/route");
  const picture = await import("@/app/api/pictures/[id]/route");
  const register = await import("@/app/api/pictures/[id]/register/route");
  const remember = await import("@/app/api/session/address/route");
  const signin = await import("@/app/api/auth/signin/google/route");
  const callback = await import("@/app/api/auth/callback/google/route");
  const signout = await import("@/app/api/auth/signout/route");
  const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
  return {
    weave: (cookie?: string) => weave.POST(req("/api/weave", "POST", { prompt: "a lighthouse at dusk, oil paint" }, cookie)),
    get: (id: string, cookie?: string) => picture.GET(req(`/api/pictures/${id}`, "GET", undefined, cookie), ctx(id)),
    register: (id: string, body: unknown, cookie?: string) => register.POST(req(`/api/pictures/${id}/register`, "POST", body, cookie), ctx(id)),
    remember: (address: string, cookie?: string) => remember.POST(req("/api/session/address", "POST", { address }, cookie)),
    signin: (cookie?: string) => signin.GET(req("/api/auth/signin/google", "GET", undefined, cookie)),
    callback: (query: string, cookie: string) => callback.GET(req(`/api/auth/callback/google?${query}`, "GET", undefined, cookie)),
    signout: (cookie: string) => signout.POST(req("/api/auth/signout", "POST", undefined, cookie)),
  };
}

type Server = Awaited<ReturnType<typeof server>>;

function setCookie(res: Response, name: string): string | null {
  const line = res.headers.getSetCookie().find((l) => l.startsWith(`${name}=`));
  return line === undefined ? null : line.split(";")[0]!;
}

async function weaveOne(s: Server, cookie?: string): Promise<{ id: string; cookie: string }> {
  const res = await s.weave(cookie);
  expect(res.status).toBe(200);
  const { pictureId } = (await res.json()) as { pictureId: string };
  return { id: pictureId, cookie: cookie ?? setCookie(res, "dl_session")! };
}

/** Signs this session in with Google and answers the fresh session cookie that carries the account. */
async function signIn(s: Server, cookie: string): Promise<string> {
  const start = await s.signin(cookie);
  const google_ = new URL(start.headers.get("location")!);
  google.answer = () => ({ claims: goodClaims(google_.searchParams.get("nonce")!) });
  const res = await s.callback(`code=abc&state=${google_.searchParams.get("state")}`, `${setCookie(start, "dl_signin")}; ${cookie}`);
  const fresh = setCookie(res, "dl_session");
  if (fresh === null) throw new Error("sign-in did not finish");
  return fresh;
}

function registers(transfer: unknown = null): void {
  sdk.registerAsPlatform.mockResolvedValue({ passportId: PASSPORT, registerTx: TX, consentTx: CONSENT_TX, signedFile: new Uint8Array(SIGNED_JPEG), transfer });
}

function lastOptions(): Record<string, unknown> {
  const call = sdk.registerAsPlatform.mock.calls.at(-1);
  if (call === undefined) throw new Error("registerAsPlatform was not called");
  return call[1] as Record<string, unknown>;
}

function pictureFiles(): string {
  const dir = path.join(dataDir, "pictures");
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => readFileSync(path.join(dir, name), "utf8"))
    .join("\n");
}

beforeAll(async () => {
  await import("@/lib/server/routes");
}, 60_000);

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "dreamloom-deliver-"));
  vi.resetAllMocks();
  openai.generate.mockResolvedValue({ data: [{ b64_json: PNG.toString("base64") }] });
  sdk.runDeliveries.mockResolvedValue({ stop: async () => {} });
  google = standInForGoogle();
  logged = [];
  for (const method of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      logged.push(args.map((a) => (a instanceof Error ? `${a.name} ${a.message} ${a.stack}` : String(a))).join(" "));
    });
  }
});

afterEach(async () => {
  const { stopDeliveries } = await import("@/lib/server/delivery-worker");
  await stopDeliveries();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("deliverTo", () => {
  it("is sent for a signed-in visitor's 'hold it for me', with exactly the verified address and verifiedBy google", async () => {
    const s = await server();
    const woven = await weaveOne(s);
    const cookie = await signIn(s, woven.cookie);
    registers();
    const res = await s.register(woven.id, { terms: "noAi" }, cookie);
    expect(res.status).toBe(200);
    expect(lastOptions().deliverTo).toEqual({ email: EMAIL, verifiedBy: "google" });
    expect(Object.keys(lastOptions().deliverTo as object).sort()).toEqual(["email", "verifiedBy"]);
    expect(await res.json()).toMatchObject({ passportId: PASSPORT, delivery: { kind: "waiting", to: MASKED } });

    const view = (await (await s.get(woven.id, cookie)).json()) as Record<string, unknown>;
    expect(view).toMatchObject({ state: "registered", mode: "platform", delivery: { kind: "waiting", to: MASKED } });
    expect(JSON.stringify(view)).not.toContain(EMAIL);
    expect(pictureFiles()).not.toContain(EMAIL);
    expect(pictureFiles()).toContain(MASKED);
  });

  it("is never sent for a signed-out visitor, who is held with no ticket as today", async () => {
    const s = await server();
    const woven = await weaveOne(s);
    registers();
    expect((await s.register(woven.id, { terms: "noAi" }, woven.cookie)).status).toBe(200);
    expect("deliverTo" in lastOptions()).toBe(false);
    const view = (await (await s.get(woven.id, woven.cookie)).json()) as Record<string, unknown>;
    expect(view.state).toBe("registered");
    expect(view.delivery).toBeUndefined();
  });

  it("is not sent after the visitor signs out", async () => {
    const s = await server();
    const first = await weaveOne(s);
    const cookie = await signIn(s, first.cookie);
    await s.signout(cookie);
    const woven = await weaveOne(s, cookie);
    registers();
    expect((await s.register(woven.id, { terms: "open" }, cookie)).status).toBe(200);
    expect("deliverTo" in lastOptions()).toBe(false);
  });

  it("is not sent for another session's picture while someone else is signed in", async () => {
    const s = await server();
    const mine = await weaveOne(s);
    await signIn(s, mine.cookie);
    const theirs = await weaveOne(s);
    registers();
    expect((await s.register(theirs.id, { terms: "noAi" }, theirs.cookie)).status).toBe(200);
    expect("deliverTo" in lastOptions()).toBe(false);
  });

  it("is not sent with a claim to a remembered address, which hands the passport over at once", async () => {
    const s = await server();
    const first = await weaveOne(s);
    const cookie = await signIn(s, first.cookie);
    expect((await s.remember(HOLDER, cookie)).status).toBe(200);
    registers();
    sdk.transferPassport.mockResolvedValue({ passportId: PASSPORT, from: HOLDER, to: HOLDER, txHash: MOVE_TX, blockNumber: 1n });
    const res = await s.register(first.id, { terms: "noAi", claim: true }, cookie);
    expect(res.status).toBe(200);
    expect("deliverTo" in lastOptions()).toBe(false);
  });
});

describe("Dreamloom's statement", () => {
  const SIGNED_IN = "Dreamloom's image agent drew this from the prompt of a person signed in to Dreamloom.";
  const VISITOR = "Dreamloom's image agent drew this from a visitor's prompt on Dreamloom.";
  const KIT_OPTIONS = ["agentAccount", "passkey", "platformKey", "platformStatement", "terms", "title", "verifyUrl", "walletClient"];

  it("says a signed-in person's prompt on a signed-in 'hold it for me', beside the delivery", async () => {
    const s = await server();
    const woven = await weaveOne(s);
    const cookie = await signIn(s, woven.cookie);
    registers();
    expect((await s.register(woven.id, { terms: "noAi" }, cookie)).status).toBe(200);
    expect(lastOptions().platformStatement).toBe(SIGNED_IN);
    expect(Object.keys(lastOptions()).sort()).toEqual([...KIT_OPTIONS, "deliverTo"].sort());
  });

  it("says a signed-in person's prompt on a signed-in claim to a remembered address", async () => {
    const s = await server();
    const first = await weaveOne(s);
    const cookie = await signIn(s, first.cookie);
    expect((await s.remember(HOLDER, cookie)).status).toBe(200);
    registers();
    sdk.transferPassport.mockResolvedValue({ passportId: PASSPORT, from: HOLDER, to: HOLDER, txHash: MOVE_TX, blockNumber: 1n });
    expect((await s.register(first.id, { terms: "noAi", claim: true }, cookie)).status).toBe(200);
    expect(lastOptions().platformStatement).toBe(SIGNED_IN);
    expect(Object.keys(lastOptions()).sort()).toEqual(KIT_OPTIONS);
  });

  it("says a visitor's prompt when nobody is signed in", async () => {
    const s = await server();
    const woven = await weaveOne(s);
    registers();
    expect((await s.register(woven.id, { terms: "open" }, woven.cookie)).status).toBe(200);
    expect(lastOptions().platformStatement).toBe(VISITOR);
    expect(Object.keys(lastOptions()).sort()).toEqual(KIT_OPTIONS);
  });

  it("says a visitor's prompt after the visitor signs out", async () => {
    const s = await server();
    const first = await weaveOne(s);
    const cookie = await signIn(s, first.cookie);
    await s.signout(cookie);
    const woven = await weaveOne(s, cookie);
    registers();
    expect((await s.register(woven.id, { terms: "noAi" }, cookie)).status).toBe(200);
    expect(lastOptions().platformStatement).toBe(VISITOR);
  });

  it("says a visitor's prompt for a session that is not signed in while another one is", async () => {
    const s = await server();
    const mine = await weaveOne(s);
    await signIn(s, mine.cookie);
    const theirs = await weaveOne(s);
    registers();
    expect((await s.register(theirs.id, { terms: "noAi" }, theirs.cookie)).status).toBe(200);
    expect(lastOptions().platformStatement).toBe(VISITOR);
  });
});

describe("what the page is told", () => {
  it("says the passport went straight to the person's Moolam account when the prepare answer carried deliverNow", async () => {
    const s = await server();
    const woven = await weaveOne(s);
    const cookie = await signIn(s, woven.cookie);
    registers({ passportId: PASSPORT, from: HOLDER, to: HOLDER, txHash: MOVE_TX, blockNumber: 9n });
    const res = await s.register(woven.id, { terms: "noAi" }, cookie);
    expect(await res.json()).toMatchObject({ delivery: { kind: "straight", to: MASKED }, moveTx: MOVE_TX, movedTo: HOLDER });
    const view = (await (await s.get(woven.id, cookie)).json()) as Record<string, unknown>;
    expect(view).toMatchObject({ state: "moved", moveTx: MOVE_TX, movedTo: HOLDER, delivery: { kind: "straight", to: MASKED } });
  });

  it("keeps a passport whose straight hand-over failed as registered and waiting, never offered for a second register", async () => {
    const s = await server();
    const woven = await weaveOne(s);
    const cookie = await signIn(s, woven.cookie);
    sdk.registerAsPlatform.mockRejectedValue(
      new MoolamPlatformError("delivery-failed", "not handed over", { passportId: PASSPORT, registerTx: TX, consentTx: CONSENT_TX }),
    );
    const res = await s.register(woven.id, { terms: "noAi" }, cookie);
    expect(res.status).toBe(200);
    const view = (await (await s.get(woven.id, cookie)).json()) as Record<string, unknown>;
    expect(view).toMatchObject({ state: "registered", passportId: PASSPORT, consentTx: CONSENT_TX, delivery: { kind: "waiting", to: MASKED } });
    expect((await s.register(woven.id, { terms: "noAi" }, cookie)).status).toBe(409);
  });

  it("lets the visitor try again when the kit refused a destination before sending anything", async () => {
    const s = await server();
    const woven = await weaveOne(s);
    const cookie = await signIn(s, woven.cookie);
    sdk.registerAsPlatform.mockRejectedValue(new MoolamPlatformError("refused-recipient", "refused"));
    expect((await s.register(woven.id, { terms: "noAi" }, cookie)).status).toBe(502);
    expect(((await (await s.get(woven.id, cookie)).json()) as Record<string, unknown>).state).toBe("woven");
  });

  it("logs no address and no mask on any of these paths", async () => {
    const s = await server();
    const woven = await weaveOne(s);
    const cookie = await signIn(s, woven.cookie);
    sdk.registerAsPlatform.mockRejectedValue(new MoolamPlatformError("refused-recipient", `refused ${EMAIL}`));
    await s.register(woven.id, { terms: "noAi" }, cookie);
    sdk.registerAsPlatform.mockRejectedValue(new MoolamPlatformError("delivery-failed", `failed for ${EMAIL}`, { passportId: PASSPORT, registerTx: TX }));
    await s.register(woven.id, { terms: "noAi" }, cookie);
    expect(logged.length).toBeGreaterThan(0);
    for (const line of logged) {
      expect(line).not.toContain(EMAIL);
      expect(line).not.toContain(MASKED);
      expect(line).not.toContain("example.com");
    }
    expect(google.strayCalls).toEqual([]);
  });
});
