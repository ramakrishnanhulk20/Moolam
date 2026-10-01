// What this file does not cover: Google itself. Its token endpoint is played offline by
// google-stand-in.ts and every other request is refused, so these tests prove what Dreamloom does
// with each answer (the checks openid-client and Dreamloom run on the ID token, the session that
// follows, and what reaches a browser or a log line), not that Google answers. The ID token's
// signature is not checked by design (it comes straight from Google over TLS). The kit and OpenAI
// are stood in for as in server-routes.test.ts.
import { readdirSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CLIENT_ID, CLIENT_SECRET, EMAIL, MASKED, SUB, challengeOf, goodClaims, standInForGoogle, type GoogleStandIn } from "./google-stand-in";

const sdk = vi.hoisted(() => ({
  registerAsPlatform: vi.fn(),
  startCosign: vi.fn(),
  resumeCosign: vi.fn(),
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

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)]);
const ORIGIN = "http://localhost:3300";

let dataDir: string;
let google: GoogleStandIn;
let logged: string[];

function settings(overrides: Record<string, string>): void {
  const base: Record<string, string> = {
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
  for (const [name, value] of Object.entries({ ...base, ...overrides })) vi.stubEnv(name, value);
}

interface Opts {
  cookie?: string;
}

function req(pathname: string, method: string, body: unknown, opts: Opts): Request {
  const headers = new Headers();
  if (body !== undefined) headers.set("content-type", "application/json");
  if (opts.cookie !== undefined) headers.set("cookie", opts.cookie);
  if (method === "POST") headers.set("origin", ORIGIN);
  return new Request(`${ORIGIN}${pathname}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

async function server(overrides: Record<string, string> = {}) {
  settings(overrides);
  vi.resetModules();
  const weave = await import("@/app/api/weave/route");
  const picture = await import("@/app/api/pictures/[id]/route");
  const signin = await import("@/app/api/auth/signin/google/route");
  const callback = await import("@/app/api/auth/callback/google/route");
  const session = await import("@/app/api/auth/session/route");
  const signout = await import("@/app/api/auth/signout/route");
  const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
  return {
    weave: (opts: Opts = {}) => weave.POST(req("/api/weave", "POST", { prompt: "a lighthouse at dusk, oil paint" }, opts)),
    get: (id: string, opts: Opts = {}) => picture.GET(req(`/api/pictures/${id}`, "GET", undefined, opts), ctx(id)),
    signin: (from: string | null, opts: Opts = {}) =>
      signin.GET(req(`/api/auth/signin/google${from === null ? "" : `?from=${encodeURIComponent(from)}`}`, "GET", undefined, opts)),
    callback: (query: string, opts: Opts = {}) => callback.GET(req(`/api/auth/callback/google?${query}`, "GET", undefined, opts)),
    session: (opts: Opts = {}) => session.GET(req("/api/auth/session", "GET", undefined, opts)),
    signout: (opts: Opts = {}) => signout.POST(req("/api/auth/signout", "POST", undefined, opts)),
  };
}

type Server = Awaited<ReturnType<typeof server>>;

function cookieNamed(res: Response, name: string): string | null {
  for (const line of res.headers.getSetCookie()) {
    if (line.startsWith(`${name}=`)) return line;
  }
  return null;
}

function pair(line: string | null): string {
  if (line === null) throw new Error("no such cookie");
  return line.split(";")[0]!;
}

async function weaveOne(s: Server, cookie?: string): Promise<{ id: string; cookie: string }> {
  const res = await s.weave(cookie === undefined ? {} : { cookie });
  expect(res.status).toBe(200);
  const { pictureId } = (await res.json()) as { pictureId: string };
  return { id: pictureId, cookie: cookie ?? pair(cookieNamed(res, "dl_session")) };
}

interface Started {
  google: URL;
  signinCookie: string;
  state: string;
  nonce: string;
}

async function startSignIn(s: Server, from: string | null, cookie?: string): Promise<Started> {
  const res = await s.signin(from, cookie === undefined ? {} : { cookie });
  expect(res.status).toBe(302);
  const google = new URL(res.headers.get("location")!);
  return {
    google,
    signinCookie: pair(cookieNamed(res, "dl_signin")),
    state: google.searchParams.get("state")!,
    nonce: google.searchParams.get("nonce")!,
  };
}

/** A whole sign-in: start, Google answers with these claims, and the callback lands. */
async function signIn(s: Server, opts: { from?: string | null; cookie?: string; claims?: (nonce: string) => Record<string, unknown> } = {}) {
  const started = await startSignIn(s, opts.from ?? null, opts.cookie);
  google.answer = () => ({ claims: (opts.claims ?? goodClaims)(started.nonce) });
  const cookie = [started.signinCookie, opts.cookie].filter(Boolean).join("; ");
  const res = await s.callback(`code=4%2F0Atest-code&state=${started.state}&scope=openid+email`, { cookie });
  return { started, res };
}

beforeAll(async () => {
  await import("@/lib/server/routes");
}, 60_000);

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "dreamloom-signin-"));
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

describe("the way to Google", () => {
  it("sends the visitor to Google with PKCE S256, a state, a nonce and the registered redirect address, and calls nobody", async () => {
    const s = await server();
    const started = await startSignIn(s, "/p/0123456789abcdef0123456789abcdef");
    expect(started.google.origin + started.google.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    const q = started.google.searchParams;
    expect(q.get("client_id")).toBe(CLIENT_ID);
    expect(q.get("redirect_uri")).toBe("http://localhost:3300/api/auth/callback/google");
    expect(q.get("response_type")).toBe("code");
    expect(q.get("scope")).toBe("openid email");
    expect(q.get("code_challenge_method")).toBe("S256");
    expect(q.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(started.state.length).toBeGreaterThanOrEqual(32);
    expect(started.nonce.length).toBeGreaterThanOrEqual(32);
    expect(started.state).not.toBe(started.nonce);
    expect(q.has("client_secret")).toBe(false);
    expect(google.tokenCalls).toHaveLength(0);
    expect(google.strayCalls).toEqual([]);
  });

  it("keeps the sign-in in an httpOnly, SameSite=Lax cookie on the auth path, Secure off this machine", async () => {
    const s = await server();
    const local = await s.signin(null);
    expect(cookieNamed(local, "dl_signin")).toMatch(/^dl_signin=[0-9a-f]{32}; Path=\/api\/auth; HttpOnly; SameSite=Lax; Max-Age=600$/);

    const signin = await import("@/app/api/auth/signin/google/route");
    const remote = await signin.GET(new Request("https://dreamloom.example.com/api/auth/signin/google"));
    expect(cookieNamed(remote, "dl_signin")).toMatch(/; Secure$/);
  });

  it("only ever returns to the home page or a picture page, never off the site", async () => {
    const s = await server();
    for (const from of ["https://evil.example/", "//evil.example/p", "/p/../../x", "/api/weave", "/p/ABC"]) {
      const { res } = await signIn(s, { from });
      expect(res.headers.get("location")).toBe(`${ORIGIN}/`);
    }
    const { res } = await signIn(s, { from: "/p/0123456789abcdef0123456789abcdef" });
    expect(res.headers.get("location")).toBe(`${ORIGIN}/p/0123456789abcdef0123456789abcdef`);
  });
});

describe("the ID token checks", () => {
  it("signs in on a good token, sending the PKCE verifier that matches the challenge and the registered redirect address", async () => {
    const s = await server();
    const { started, res } = await signIn(s, { from: "/" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`${ORIGIN}/`);
    expect(cookieNamed(res, "dl_session")).toMatch(/^dl_session=[0-9a-f]{32}; Path=\/; HttpOnly; SameSite=Lax$/);
    expect(cookieNamed(res, "dl_signin")).toMatch(/^dl_signin=; .*Max-Age=0/);

    expect(google.tokenCalls).toHaveLength(1);
    const body = google.tokenCalls[0]!.body;
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe("4/0Atest-code");
    expect(body.get("redirect_uri")).toBe("http://localhost:3300/api/auth/callback/google");
    expect(challengeOf(body.get("code_verifier")!)).toBe(started.google.searchParams.get("code_challenge"));
    expect(google.strayCalls).toEqual([]);

    const me = await s.session({ cookie: pair(cookieNamed(res, "dl_session")) });
    expect(await me.json()).toEqual({ available: true, signedIn: true, email: MASKED });
  });

  const spoiled: [string, (nonce: string) => Record<string, unknown>, string][] = [
    ["a wrong audience", (n) => goodClaims(n, { aud: "someone-else.apps.googleusercontent.com", azp: "someone-else.apps.googleusercontent.com" }), "failed"],
    ["a wrong issuer", (n) => goodClaims(n, { iss: "https://accounts.evil.example" }), "failed"],
    ["an expired token", (n) => goodClaims(n, { iat: Math.floor(Date.now() / 1000) - 7200, exp: Math.floor(Date.now() / 1000) - 3600 }), "failed"],
    ["a wrong nonce", () => goodClaims("an-older-nonce-from-another-sign-in-attempt"), "failed"],
    ["no nonce", (n) => { const c = goodClaims(n); delete c.nonce; return c; }, "failed"],
    ["email_verified false", (n) => goodClaims(n, { email_verified: false }), "unverified"],
    ["email_verified missing", (n) => { const c = goodClaims(n); delete c.email_verified; return c; }, "unverified"],
    ["email_verified as the text \"true\"", (n) => goodClaims(n, { email_verified: "true" }), "unverified"],
    ["no email", (n) => { const c = goodClaims(n); delete c.email; return c; }, "unverified"],
  ];

  for (const [what, claims, word] of spoiled) {
    it(`refuses ${what}: no session, no account, back with "${word}"`, async () => {
      const s = await server();
      const before = await weaveOne(s);
      const { res } = await signIn(s, { from: `/p/${before.id}`, cookie: before.cookie, claims });
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe(`${ORIGIN}/p/${before.id}?signin=${word}`);
      expect(cookieNamed(res, "dl_session")).toBeNull();
      expect(await (await s.session({ cookie: before.cookie })).json()).toEqual({ available: true, signedIn: false });
      expect(readdirSafe(path.join(dataDir, "accounts"))).toEqual([]);
    });
  }

  it("refuses a callback whose state is not the one this browser was sent with", async () => {
    const s = await server();
    const started = await startSignIn(s, null);
    google.answer = () => ({ claims: goodClaims(started.nonce) });
    const res = await s.callback(`code=abc&state=${"x".repeat(43)}`, { cookie: started.signinCookie });
    expect(res.headers.get("location")).toBe(`${ORIGIN}/?signin=failed`);
    expect(cookieNamed(res, "dl_session")).toBeNull();
    expect(google.tokenCalls).toHaveLength(0);
  });

  it("refuses a callback with no sign-in cookie, and a second use of the same one", async () => {
    const s = await server();
    const started = await startSignIn(s, null);
    google.answer = () => ({ claims: goodClaims(started.nonce) });
    const bare = await s.callback(`code=abc&state=${started.state}`);
    expect(bare.headers.get("location")).toBe(`${ORIGIN}/?signin=failed`);

    const first = await s.callback(`code=abc&state=${started.state}`, { cookie: started.signinCookie });
    expect(cookieNamed(first, "dl_session")).not.toBeNull();
    const again = await s.callback(`code=abc&state=${started.state}`, { cookie: started.signinCookie });
    expect(again.headers.get("location")).toBe(`${ORIGIN}/?signin=failed`);
    expect(cookieNamed(again, "dl_session")).toBeNull();
    expect(google.tokenCalls).toHaveLength(1);
  });

  it("comes back with failed when the visitor cancels at Google, and when Google's token endpoint refuses the code", async () => {
    const s = await server();
    const cancelled = await startSignIn(s, null);
    const res = await s.callback(`error=access_denied&state=${cancelled.state}`, { cookie: cancelled.signinCookie });
    expect(res.headers.get("location")).toBe(`${ORIGIN}/?signin=failed`);

    const refused = await startSignIn(s, null);
    google.answer = () => ({ status: 400, json: { error: "invalid_grant" } });
    const bad = await s.callback(`code=abc&state=${refused.state}`, { cookie: refused.signinCookie });
    expect(bad.headers.get("location")).toBe(`${ORIGIN}/?signin=failed`);
    expect(cookieNamed(bad, "dl_session")).toBeNull();
  });

  it("refuses a sign-in that waited past ten minutes", async () => {
    const s = await server();
    const started = await startSignIn(s, null);
    google.answer = () => ({ claims: goodClaims(started.nonce) });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 11 * 60 * 1000);
    const res = await s.callback(`code=abc&state=${started.state}`, { cookie: started.signinCookie });
    vi.useRealTimers();
    expect(res.headers.get("location")).toBe(`${ORIGIN}/?signin=failed`);
  });
});

function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

describe("the session that follows", () => {
  it("gets a fresh dl_session that takes the pictures over, so a cookie planted before sign-in is never signed in", async () => {
    const s = await server();
    const before = await weaveOne(s);
    const { res } = await signIn(s, { cookie: before.cookie, from: `/p/${before.id}` });
    const after = pair(cookieNamed(res, "dl_session"));
    expect(after).not.toBe(before.cookie);

    expect((await s.get(before.id, { cookie: after })).status).toBe(200);
    expect((await s.get(before.id, { cookie: before.cookie })).status).toBe(404);
    expect(await (await s.session({ cookie: before.cookie })).json()).toEqual({ available: true, signedIn: false });
    expect(await (await s.session({ cookie: after })).json()).toEqual({ available: true, signedIn: true, email: MASKED });
  });

  it("keeps the subject and the verified address on the server, under the session's hash, never the session itself", async () => {
    const s = await server();
    const { res } = await signIn(s);
    const session = pair(cookieNamed(res, "dl_session")).split("=")[1]!;
    const files = readdirSafe(path.join(dataDir, "accounts"));
    expect(files).toHaveLength(1);
    expect(files[0]).not.toContain(session);
    const stored = JSON.parse(readFileSync(path.join(dataDir, "accounts", files[0]!), "utf8")) as Record<string, unknown>;
    expect(stored).toMatchObject({ sub: SUB, email: EMAIL });
    expect(JSON.stringify(stored)).not.toContain(session);
  });

  it("answers another session nothing about this one: not the address, not its mask, not its pictures", async () => {
    const s = await server();
    const mine = await weaveOne(s);
    const { res } = await signIn(s, { cookie: mine.cookie });
    const signedIn = pair(cookieNamed(res, "dl_session"));
    const other = await weaveOne(s);

    const answers: string[] = [];
    for (const r of [await s.session({ cookie: other.cookie }), await s.session(), await s.get(mine.id, { cookie: other.cookie }), await s.get(other.id, { cookie: other.cookie })]) {
      answers.push(`${r.status} ${[...r.headers.entries()].join(" ")} ${await r.text()}`);
    }
    expect(answers[0]).toContain('"signedIn":false');
    expect(answers[2]).toMatch(/^404 /);
    for (const answer of answers) {
      expect(answer).not.toContain(EMAIL);
      expect(answer).not.toContain(MASKED);
      expect(answer).not.toContain("example.com");
    }
    expect(await (await s.session({ cookie: signedIn })).json()).toMatchObject({ signedIn: true });
  });

  it("signs out: the session forgets the account and keeps its pictures", async () => {
    const s = await server();
    const mine = await weaveOne(s);
    const { res } = await signIn(s, { cookie: mine.cookie });
    const cookie = pair(cookieNamed(res, "dl_session"));
    const out = await s.signout({ cookie });
    expect(await out.json()).toEqual({ available: true, signedIn: false });
    expect(await (await s.session({ cookie })).json()).toEqual({ available: true, signedIn: false });
    expect(readdirSafe(path.join(dataDir, "accounts"))).toEqual([]);
    expect((await s.get(mine.id, { cookie })).status).toBe(200);
  });

  it("refuses a sign-out posted from another site", async () => {
    const s = await server();
    const { res } = await signIn(s);
    const cookie = pair(cookieNamed(res, "dl_session"));
    const signout = await import("@/app/api/auth/signout/route");
    const forged = await signout.POST(new Request(`${ORIGIN}/api/auth/signout`, { method: "POST", headers: { cookie, origin: "https://evil.example" } }));
    expect(forged.status).toBe(403);
    expect(await (await s.session({ cookie })).json()).toMatchObject({ signedIn: true });
  });
});

describe("without Google settings", () => {
  it("offers no sign-in, refuses the sign-in routes, and weaves as today", async () => {
    const s = await server({ GOOGLE_CLIENT_ID: "", GOOGLE_CLIENT_SECRET: "" });
    expect(await (await s.session()).json()).toEqual({ available: false, signedIn: false });
    expect((await s.signin(null)).status).toBe(404);
    expect((await s.callback("code=abc&state=x")).status).toBe(404);
    const picture = await weaveOne(s);
    expect((await s.get(picture.id, { cookie: picture.cookie })).status).toBe(200);
  });

  it("treats one Google setting without the other as no sign-in", async () => {
    const s = await server({ GOOGLE_CLIENT_SECRET: "" });
    expect(await (await s.session()).json()).toEqual({ available: false, signedIn: false });
  });
});

describe("log lines", () => {
  it("carry no address, mask, subject, client secret, code, state, nonce or verifier, through every sign-in path", async () => {
    const s = await server();
    const secrets: string[] = [EMAIL, MASKED, SUB, CLIENT_SECRET, "marker", "4/0Atest-code"];
    const good = await signIn(s);
    secrets.push(good.started.state, good.started.nonce, good.started.google.searchParams.get("code_challenge")!);
    secrets.push(google.tokenCalls[0]!.body.get("code_verifier")!);
    const bad = await signIn(s, { claims: (n) => goodClaims(n, { aud: "nope" }) });
    secrets.push(bad.started.state);
    await signIn(s, { claims: (n) => goodClaims(n, { email_verified: false }) });
    await s.callback("code=abc&state=nothing");
    await s.signout({ cookie: pair(cookieNamed(good.res, "dl_session")) });

    expect(logged.length).toBeGreaterThan(0);
    for (const line of logged) {
      for (const secret of secrets) expect(line).not.toContain(secret);
      expect(line).toMatch(/^dreamloom: [a-z ]+: [a-z ,-]+$/);
    }
  });
});
