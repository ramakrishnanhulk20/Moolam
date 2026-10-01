// What this file does not cover: the browser bundle (no client file imports lib/server, which the
// screen cook's work order and the head chef's leak grep on a built page check), and what the kit
// or OpenAI's client might print themselves. The kit's own promise is that it logs nothing; here
// the kit, OpenAI and the chain are stood in for, and hostile stand-ins throw errors that quote the
// secrets, to prove Dreamloom's server does not pass them on.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { getAddress } from "viem";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CLIENT_ID, CLIENT_SECRET, goodClaims, standInForGoogle } from "./google-stand-in";

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

const openai = vi.hoisted(() => ({ generate: vi.fn(), apiKeys: [] as unknown[] }));

vi.mock("openai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openai")>();
  class StandIn {
    images = { generate: openai.generate };
    constructor(options: { apiKey?: unknown }) {
      openai.apiKeys.push(options.apiKey);
    }
  }
  return { ...actual, default: StandIn };
});

// Each secret is a marker that is still a valid value of its kind, so the server takes it and runs.
const MARK = {
  platformKey: "5ec0".repeat(16),
  walletKey: `0x${"5ec1".repeat(16)}`,
  passkeyKey: `0x${"5ec2".repeat(16)}`,
  openAiKey: "sk-marker-5ec3-openai",
  rpcUrl: "https://rpc.example.com/v2/marker-5ec4-rpc",
  googleSecret: CLIENT_SECRET,
};
/** What each marker looks like however it is cut: the hex bodies without 0x, and the distinctive words. */
const NEEDLES = ["5ec05ec05ec0", "5ec15ec15ec1", "5ec25ec25ec2", "marker-5ec3", "marker-5ec4", "marker-5ec9"];

const HANDLE = "c0ffee00".repeat(4);
const PASSPORT = `0x${"a1".repeat(32)}`;
const TX = `0x${"b2".repeat(32)}`;
const HOLDER = getAddress("0x1234567890abcdef1234567890abcdef12345678");
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)]);

let dataDir: string;
let logged: string[];

function settings(overrides: Record<string, string | undefined> = {}): void {
  const base: Record<string, string | undefined> = {
    MOOLAM_VERIFY_URL: "https://verify.example.com",
    MOOLAM_SITE_URL: "https://moolam.example.com",
    MOOLAM_INDEX_URL: "https://index.example.com/graphql",
    MONAD_RPC_URL: MARK.rpcUrl,
    DREAMLOOM_ORIGIN: "https://dreamloom.example.com",
    DREAMLOOM_WALLET_KEY: MARK.walletKey,
    DREAMLOOM_PASSKEY_KEY: MARK.passkeyKey,
    DREAMLOOM_PASSKEY_RP_ID: "dreamloom.example.com",
    DREAMLOOM_PLATFORM_KEY: MARK.platformKey,
    OPENAI_API_KEY: MARK.openAiKey,
    GOOGLE_CLIENT_ID: CLIENT_ID,
    GOOGLE_CLIENT_SECRET: MARK.googleSecret,
    DATA_DIR: dataDir,
  };
  for (const [name, value] of Object.entries({ ...base, ...overrides })) vi.stubEnv(name, value);
}

async function server() {
  settings();
  vi.resetModules();
  const routes = await import("@/lib/server/routes");
  const worker = await import("@/lib/server/cosign-worker");
  return { routes, worker };
}

function req(pathname: string, method: string, body?: unknown, cookie?: string): Request {
  const headers = new Headers();
  if (body !== undefined) headers.set("content-type", "application/json");
  if (cookie !== undefined) headers.set("cookie", cookie);
  if (method === "POST") headers.set("origin", "https://dreamloom.example.com");
  return new Request(`https://dreamloom.example.com${pathname}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

async function seen(res: Response): Promise<string> {
  const headers = [...res.headers.entries()].map(([k, v]) => `${k}: ${v}`).join("\n");
  return `${res.status}\n${headers}\n${await res.clone().text()}`;
}

function expectClean(text: string): void {
  for (const needle of NEEDLES) expect(text).not.toContain(needle);
}

beforeAll(async () => {
  await import("@/lib/server/routes");
}, 60_000);

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "dreamloom-secrets-"));
  vi.resetAllMocks();
  openai.apiKeys.length = 0;
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
  vi.unstubAllGlobals();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("D3: secrets never leave the server", () => {
  it("keeps every secret out of every answer, header and log line, while the kit and OpenAI do get them", async () => {
    const { routes } = await server();
    const answers: string[] = [];
    const keep = async (res: Response) => {
      answers.push(await seen(res));
      return res;
    };

    const woven = await keep(await routes.weave(req("/api/weave", "POST", { prompt: "a lighthouse at dusk" })));
    const cookie = woven.headers.get("set-cookie")!.split(";")[0]!;
    const { pictureId: a } = (await woven.clone().json()) as { pictureId: string };
    await keep(await routes.getPicture(req(`/api/pictures/${a}`, "GET", undefined, cookie), a));
    await keep(await routes.getPictureImage(req(`/api/pictures/${a}/image`, "GET", undefined, cookie), a));

    // A hostile failure: an error whose text quotes the platform key and the RPC URL, the way a raw
    // HTTP client error can quote the URL it called.
    sdk.registerAsPlatform.mockRejectedValueOnce(new Error(`request to ${MARK.rpcUrl} with Bearer ${MARK.platformKey} failed`));
    await keep(await routes.registerOwnPicture(req(`/api/pictures/${a}/register`, "POST", { terms: "noAi" }, cookie), a));

    const b = ((await (await keep(await routes.weave(req("/api/weave", "POST", { prompt: "a second lighthouse" }, cookie)))).clone().json()) as { pictureId: string }).pictureId;
    sdk.registerAsPlatform.mockResolvedValueOnce({ passportId: PASSPORT, registerTx: TX, consentTx: null, signedFile: new Uint8Array(PNG) });
    await keep(await routes.registerOwnPicture(req(`/api/pictures/${b}/register`, "POST", { terms: "open" }, cookie), b));
    for (const address of ["0x1234", `0x${"0".repeat(40)}`, "0xa19188801E5DC93CD925884d73e4DaFc2bcb80C0"]) {
      await keep(await routes.movePicture(req(`/api/pictures/${b}/move`, "POST", { address }, cookie), b));
    }
    sdk.transferPassport.mockRejectedValueOnce(new Error(`eth_sendRawTransaction to ${MARK.rpcUrl} failed`));
    await keep(await routes.movePicture(req(`/api/pictures/${b}/move`, "POST", { address: HOLDER }, cookie), b));

    const c = ((await (await keep(await routes.weave(req("/api/weave", "POST", { prompt: "a third lighthouse" }, cookie)))).clone().json()) as { pictureId: string }).pictureId;
    sdk.startCosign.mockRejectedValueOnce(new Error(`prepare failed with key ${MARK.platformKey}`));
    await keep(await routes.cosignPicture(req(`/api/pictures/${c}/cosign`, "POST", { terms: "askFirst" }, cookie), c));

    // OpenAI's own 401 text quotes part of the key.
    openai.generate.mockRejectedValueOnce(new Error(`Incorrect API key provided: ${MARK.openAiKey}`));
    await keep(await routes.weave(req("/api/weave", "POST", { prompt: "a lighthouse that fails" }, cookie)));

    expect(answers.length).toBeGreaterThan(10);
    for (const answer of answers) expectClean(answer);
    expect(logged.length).toBeGreaterThan(0);
    for (const line of logged) expectClean(line);

    expect(openai.apiKeys).toContain(MARK.openAiKey);
    const registerOptions = sdk.registerAsPlatform.mock.calls[0]![1] as { platformKey: string; passkey: { qx: string } };
    expect(registerOptions.platformKey).toBe(MARK.platformKey);
    expect(JSON.stringify(registerOptions.passkey)).not.toContain("5ec25ec2");
  });

  it("names a missing or malformed setting and never its value, and stops a production server", async () => {
    const { parseEnv, EnvError } = await import("@/lib/server/env");
    expect(() => parseEnv({ NODE_ENV: "production" })).toThrow(EnvError);
    let message = "";
    try {
      parseEnv({ NODE_ENV: "production", DREAMLOOM_WALLET_KEY: "0x5ec1-marker-not-a-key", OPENAI_API_KEY: MARK.openAiKey });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("DREAMLOOM_WALLET_KEY");
    expect(message).not.toContain("5ec1-marker");
    expectClean(message);
    message = "";
    try {
      parseEnv({ NODE_ENV: "production", OPENAI_API_KEY: MARK.openAiKey });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("DREAMLOOM_PLATFORM_KEY");
    expect(message).not.toContain("OPENAI_API_KEY");
    expectClean(message);
    expect(parseEnv({}).WEAVES_PER_ADDRESS_PER_DAY).toBe(5);
    const caps = parseEnv({});
    expect([caps.WEAVES_PER_ADDRESS_PER_DAY, caps.WEAVES_PER_DAY, caps.REGISTRATIONS_PER_DAY, caps.MOVES_PER_DAY, caps.COSIGNS_PER_DAY]).toEqual([5, 60, 10, 10, 30]);
    expect(() => parseEnv({ WEAVES_PER_DAY: "-1" })).toThrow(/WEAVES_PER_DAY/);

    settings({ NODE_ENV: "production", DREAMLOOM_PLATFORM_KEY: undefined, OPENAI_API_KEY: "not-a-marker" });
    vi.resetModules();
    const { guarded } = await import("@/lib/server/http");
    const stop = vi.fn();
    const run = vi.fn();
    const res = await guarded(run, stop);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(run).not.toHaveBeenCalled();
    expect(await res.json()).toEqual({ error: "closed" });
    expect(logged.join("\n")).toContain("DREAMLOOM_PLATFORM_KEY");
    for (const line of logged) expectClean(line);
  });
});

describe("the Google client secret never leaves the server except to Google", () => {
  it("keeps the client secret out of every sign-in answer, header and log line, even when Google's error quotes it", async () => {
    const google = standInForGoogle();
    settings();
    vi.resetModules();
    const auth = await import("@/lib/server/auth-routes");
    const answers: string[] = [];
    const keep = async (res: Response) => {
      answers.push(await seen(res));
      return res;
    };
    const signinCookie = (res: Response) => res.headers.getSetCookie().find((line) => line.startsWith("dl_signin="))!.split(";")[0]!;
    const start = async () => {
      const res = await keep(await auth.signInWithGoogle(req("/api/auth/signin/google?from=%2F", "GET")));
      const page = new URL(res.headers.get("location")!);
      return { cookie: signinCookie(res), state: page.searchParams.get("state")!, nonce: page.searchParams.get("nonce")! };
    };

    // A hostile failure: Google's token endpoint refuses and its error text quotes the secret back.
    const refused = await start();
    google.answer = () => ({ status: 401, json: { error: "invalid_client", error_description: `client_secret ${MARK.googleSecret} is not valid` } });
    await keep(await auth.googleCallback(req(`/api/auth/callback/google?code=4%2F0Atest&state=${refused.state}`, "GET", undefined, refused.cookie)));

    const good = await start();
    google.answer = () => ({ claims: goodClaims(good.nonce) });
    const landed = await keep(await auth.googleCallback(req(`/api/auth/callback/google?code=4%2F0Atest&state=${good.state}`, "GET", undefined, good.cookie)));
    const session = landed.headers.getSetCookie().find((line) => line.startsWith("dl_session="))!.split(";")[0]!;
    expect(await (await keep(await auth.currentAccount(req("/api/auth/session", "GET", undefined, session)))).clone().json()).toMatchObject({ signedIn: true });
    await keep(await auth.signOut(req("/api/auth/signout", "POST", undefined, session)));

    expect(answers).toHaveLength(6);
    for (const answer of answers) expectClean(answer);
    expect(logged.length).toBeGreaterThan(0);
    for (const line of logged) expectClean(line);

    // The secret is in use: it went to Google's token endpoint, and nowhere else.
    expect(google.tokenCalls).toHaveLength(2);
    expect(google.tokenCalls.every((call) => call.body.get("client_secret") === MARK.googleSecret)).toBe(true);
    expect(google.strayCalls).toEqual([]);
  });
});

describe("D5: a co-sign link goes only to the session that wove the picture, and is never logged", () => {
  it("shows the link to the owner only and keeps the handle out of every log line, even when the worker fails", async () => {
    const { routes } = await server();
    const woven = await routes.weave(req("/api/weave", "POST", { prompt: "a lighthouse to co-sign" }));
    const cookie = woven.headers.get("set-cookie")!.split(";")[0]!;
    const { pictureId } = (await woven.json()) as { pictureId: string };
    const cosignUrl = `https://moolam.example.com/cosign#${HANDLE}`;
    sdk.startCosign.mockResolvedValue({ handle: HANDLE, cosignUrl, passportId: PASSPORT, openBy: 4_000_000_000 });
    // A hostile failure that quotes the handle, which the real kit promises never to do.
    sdk.waitForCreator.mockRejectedValue(new Error(`status for ${HANDLE} failed at ${cosignUrl}`));

    const opened = await routes.cosignPicture(req(`/api/pictures/${pictureId}/cosign`, "POST", { terms: "open" }, cookie), pictureId);
    expect(await opened.json()).toEqual({ cosignUrl, title: "a lighthouse to co-sign" });
    expect(sdk.startCosign.mock.calls[0]![1]).toMatchObject({ platformKey: MARK.platformKey, siteUrl: "https://moolam.example.com" });

    const other = (await routes.weave(req("/api/weave", "POST", { prompt: "someone else's lighthouse" }))).headers.get("set-cookie")!.split(";")[0]!;
    const theirs = await routes.getPicture(req(`/api/pictures/${pictureId}`, "GET", undefined, other), pictureId);
    expect(theirs.status).toBe(404);
    expect(await theirs.text()).not.toContain(HANDLE);

    await vi.waitFor(async () => {
      const mine = (await (await routes.getPicture(req(`/api/pictures/${pictureId}`, "GET", undefined, cookie), pictureId)).json()) as Record<string, unknown>;
      expect(mine).toMatchObject({ state: "failed", failure: "cosign" });
      expect(mine.cosignUrl).toBeUndefined();
    });
    expect(logged.length).toBeGreaterThan(0);
    for (const line of logged) expect(line).not.toContain(HANDLE);
  });

  it("shows the link to its owner while the co-sign is open", async () => {
    const { routes } = await server();
    const woven = await routes.weave(req("/api/weave", "POST", { prompt: "a lighthouse to co-sign" }));
    const cookie = woven.headers.get("set-cookie")!.split(";")[0]!;
    const { pictureId } = (await woven.json()) as { pictureId: string };
    const cosignUrl = `https://moolam.example.com/cosign#${HANDLE}`;
    sdk.startCosign.mockResolvedValue({ handle: HANDLE, cosignUrl, passportId: PASSPORT, openBy: 4_000_000_000 });
    sdk.waitForCreator.mockReturnValue(new Promise(() => {}));
    await routes.cosignPicture(req(`/api/pictures/${pictureId}/cosign`, "POST", { terms: "noAi" }, cookie), pictureId);
    const mine = (await (await routes.getPicture(req(`/api/pictures/${pictureId}`, "GET", undefined, cookie), pictureId)).json()) as Record<string, unknown>;
    expect(mine).toMatchObject({ state: "cosign-open", mode: "cosign", cosignUrl });
    expect(mine.passportId).toBeUndefined();
    expect(JSON.stringify(mine).split(HANDLE).length).toBe(2);
  });
});
