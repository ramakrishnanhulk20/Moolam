// What this file does not cover: the verify service's co-sign record and the chain read inside
// waitForPassport, which the kit's own fork tests prove. The kit's co-sign calls are stood in for,
// so this file proves what Dreamloom writes after each answer and that it picks stored co-signs up
// again, not that Moolam answers. The retry pause for an unreachable service is not exercised.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({
  registerAsPlatform: vi.fn(),
  startCosign: vi.fn(),
  resumeCosign: vi.fn(),
  waitForCreator: vi.fn(),
  signAsAgent: vi.fn(),
  waitForPassport: vi.fn(),
  transferPassport: vi.fn(),
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
const PASSPORT = `0x${"a1".repeat(32)}`;
const DIGEST = `0x${"d4".repeat(32)}`;
const OWNER = "ab".repeat(32);
const NOW = new Date("2026-10-01T12:00:00Z");
const NOW_SECONDS = Math.floor(NOW.getTime() / 1000);

let dataDir: string;

function settings(): void {
  const values: Record<string, string> = {
    MOOLAM_VERIFY_URL: "https://verify.example.com",
    MOOLAM_SITE_URL: "https://moolam.example.com",
    MOOLAM_INDEX_URL: "https://index.example.com/graphql",
    MONAD_RPC_URL: "https://rpc.example.com",
    DREAMLOOM_ORIGIN: "http://localhost:3300",
    DREAMLOOM_WALLET_KEY: `0x${"5ec1".repeat(16)}`,
    DREAMLOOM_PASSKEY_KEY: `0x${"5ec2".repeat(16)}`,
    DREAMLOOM_PASSKEY_RP_ID: "dreamloom.example.com",
    DREAMLOOM_PLATFORM_KEY: "5ec0".repeat(16),
    OPENAI_API_KEY: "sk-test",
    DATA_DIR: dataDir,
  };
  for (const [name, value] of Object.entries(values)) vi.stubEnv(name, value);
}

/** A fresh process: new module instances over the same data folder. */
async function boot() {
  vi.resetModules();
  return {
    routes: await import("@/lib/server/routes"),
    worker: await import("@/lib/server/cosign-worker"),
    store: await import("@/lib/server/store"),
  };
}

function handleOf(handle: string, openBy = NOW_SECONDS + 1800) {
  return { handle, cosignUrl: `https://moolam.example.com/cosign#${handle}`, passportId: PASSPORT, openBy };
}

/** Leaves a co-sign on the volume the way a stopped process would have. */
async function storedCosign(handle: string, state: "cosign-open" | "cosign-signed", openBy = NOW_SECONDS + 1800): Promise<string> {
  const { store } = await boot();
  const record = store.createPicture({ sessionHash: OWNER, prompt: "a lighthouse left open", bytes: PNG });
  store.advancePicture(record.id, "cosign-open", { mode: "cosign", cosign: { handle, cosignUrl: handleOf(handle).cosignUrl, openBy } });
  if (state === "cosign-signed") store.advancePicture(record.id, "cosign-signed");
  return record.id;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

beforeAll(async () => {
  await import("@/lib/server/routes");
}, 60_000);

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "dreamloom-worker-"));
  vi.resetAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  settings();
  openai.generate.mockResolvedValue({ data: [{ b64_json: PNG.toString("base64") }] });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("the co-sign worker", () => {
  it("writes each step, and says registered only once waitForPassport returned the passport (D7)", async () => {
    const { routes, store } = await boot();
    const woven = await routes.weave(new Request("http://localhost/api/weave", { method: "POST", headers: { "content-type": "application/json", origin: "http://localhost:3300" }, body: JSON.stringify({ prompt: "a lighthouse to co-sign" }) }));
    const { pictureId } = (await woven.json()) as { pictureId: string };
    const cookie = woven.headers.get("set-cookie")!.split(";")[0]!;
    const landed = deferred<unknown>();
    sdk.startCosign.mockResolvedValue(handleOf("c1".repeat(16)));
    sdk.waitForCreator.mockResolvedValue(DIGEST);
    sdk.signAsAgent.mockResolvedValue(`0x${"5a".repeat(65)}`);
    sdk.waitForPassport.mockReturnValue(landed.promise);

    const opened = await routes.cosignPicture(
      new Request(`http://localhost/api/pictures/${pictureId}/cosign`, { method: "POST", headers: { "content-type": "application/json", origin: "http://localhost:3300", cookie }, body: JSON.stringify({ terms: "open" }) }),
      pictureId,
    );
    expect(opened.status).toBe(200);
    await vi.waitFor(() => expect(store.readPicture(pictureId)?.state).toBe("cosign-signed"));
    expect(sdk.signAsAgent).toHaveBeenCalledWith(expect.objectContaining({ handle: "c1".repeat(16) }), DIGEST);
    expect(store.readPicture(pictureId)?.passportId).toBeUndefined();

    landed.resolve({ passportId: PASSPORT, creator: "0x1234567890abcdef1234567890abcdef12345678", registeredAt: 1n });
    await vi.waitFor(() => expect(store.readPicture(pictureId)).toMatchObject({ state: "registered", passportId: PASSPORT }));
  });

  it("picks up every stored co-sign on the first request after a restart, from its stored handle", async () => {
    const open = await storedCosign("c2".repeat(16), "cosign-open");
    const signed = await storedCosign("c3".repeat(16), "cosign-signed");
    sdk.resumeCosign.mockImplementation(async (handle: string) => handleOf(handle));
    sdk.waitForCreator.mockResolvedValue(DIGEST);
    sdk.signAsAgent.mockResolvedValue(`0x${"5a".repeat(65)}`);
    sdk.waitForPassport.mockResolvedValue({ passportId: PASSPORT, creator: "0x1234567890abcdef1234567890abcdef12345678", registeredAt: 1n });

    const { routes, store } = await boot();
    const answer = await routes.getPicture(new Request("http://localhost/api/pictures/x"), "0".repeat(32));
    expect(answer.status).toBe(404);
    await vi.waitFor(() => {
      expect(store.readPicture(open)?.state).toBe("registered");
      expect(store.readPicture(signed)?.state).toBe("registered");
    });
    expect(sdk.resumeCosign.mock.calls.map((call) => call[0]).sort()).toEqual(["c2".repeat(16), "c3".repeat(16)]);
    expect(sdk.resumeCosign.mock.calls[0]![1]).toMatchObject({ platformKey: "5ec0".repeat(16), siteUrl: "https://moolam.example.com" });
    expect(sdk.signAsAgent).toHaveBeenCalledTimes(1);
  });

  it("carries on to the chain read when a resumed co-sign's signature was already posted", async () => {
    const { MoolamPlatformError } = await import("@moolam/platform");
    const id = await storedCosign("c4".repeat(16), "cosign-open");
    sdk.resumeCosign.mockImplementation(async (handle: string) => handleOf(handle));
    sdk.waitForCreator.mockResolvedValue(DIGEST);
    sdk.signAsAgent.mockRejectedValue(new MoolamPlatformError("service-refused", "already signed", { status: 409 }));
    sdk.waitForPassport.mockResolvedValue({ passportId: PASSPORT, creator: "0x1234567890abcdef1234567890abcdef12345678", registeredAt: 1n });
    const { worker, store } = await boot();
    await worker.resumeOpenCosigns();
    expect(store.readPicture(id)).toMatchObject({ state: "registered", passportId: PASSPORT });
  });

  it("marks a co-sign whose last chance has passed on the clock as expired without asking Moolam", async () => {
    const id = await storedCosign("c5".repeat(16), "cosign-open", NOW_SECONDS - 2 * 60 * 60);
    const { worker, store } = await boot();
    await worker.resumeOpenCosigns();
    expect(store.readPicture(id)).toMatchObject({ state: "failed", failure: "expired" });
    expect(sdk.resumeCosign).not.toHaveBeenCalled();
  });

  it("marks expired when the kit says the deadline passed, and taken when another passport holds the picture", async () => {
    const { MoolamPlatformError } = await import("@moolam/platform");
    const expired = await storedCosign("c6".repeat(16), "cosign-open");
    const late = await storedCosign("c7".repeat(16), "cosign-open");
    const taken = await storedCosign("c8".repeat(16), "cosign-signed");
    sdk.resumeCosign.mockImplementation(async (handle: string) => {
      if (handle === "c6".repeat(16)) throw new MoolamPlatformError("cosign-expired", "expired");
      return handleOf(handle);
    });
    sdk.waitForCreator.mockRejectedValue(new MoolamPlatformError("timed-out", "nobody opened it"));
    sdk.waitForPassport.mockRejectedValue(new MoolamPlatformError("passport-taken", "taken"));
    const { worker, store } = await boot();
    await worker.resumeOpenCosigns();
    expect(store.readPicture(expired)).toMatchObject({ state: "failed", failure: "expired" });
    expect(store.readPicture(late)).toMatchObject({ state: "failed", failure: "expired" });
    expect(store.readPicture(taken)).toMatchObject({ state: "failed", failure: "taken" });
    for (const id of [expired, late, taken]) expect(store.readPicture(id)?.passportId).toBeUndefined();
  });
});

describe("the start work in instrumentation.ts", () => {
  it("picks up stored co-signs at start without waiting for a request, and the first request does not do it twice", async () => {
    const id = await storedCosign("c9".repeat(16), "cosign-open");
    sdk.resumeCosign.mockImplementation(async (handle: string) => handleOf(handle));
    sdk.waitForCreator.mockReturnValue(new Promise(() => {}));
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    const { routes, store } = await boot();
    const { register } = await import("@/instrumentation");
    await register();
    await vi.waitFor(() => expect(sdk.resumeCosign).toHaveBeenCalledWith("c9".repeat(16), expect.anything()));
    await routes.getPicture(new Request("http://localhost/api/pictures/x"), "0".repeat(32));
    expect(sdk.resumeCosign).toHaveBeenCalledTimes(1);
    expect(store.readPicture(id)?.state).toBe("cosign-open");
  });

  it("does nothing in the edge runtime", async () => {
    await storedCosign("ca".repeat(16), "cosign-open");
    vi.stubEnv("NEXT_RUNTIME", "edge");
    await boot();
    const { register } = await import("@/instrumentation");
    await register();
    expect(sdk.resumeCosign).not.toHaveBeenCalled();
  });

  it("stops a production server missing a setting, naming the variable and never a value", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DREAMLOOM_PLATFORM_KEY", undefined);
    const lines: string[] = [];
    vi.mocked(console.error).mockImplementation((line: unknown) => void lines.push(String(line)));
    await boot();
    const { startServer } = await import("@/lib/server/boot");
    const stop = vi.fn();
    startServer(stop);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(lines.join("\n")).toContain("DREAMLOOM_PLATFORM_KEY");
    expect(lines.join("\n")).not.toContain("5ec0");
    expect(sdk.resumeCosign).not.toHaveBeenCalled();
  });

  it("marks a claim older than 15 minutes as interrupted at start, keeps its count, and leaves a fresh claim alone", async () => {
    vi.stubEnv("REGISTRATIONS_PER_DAY", "2");
    const { store } = await boot();
    const caps = await import("@/lib/server/caps");
    const old = store.createPicture({ sessionHash: OWNER, prompt: "a lighthouse left mid-register", bytes: PNG });
    const fresh = store.createPicture({ sessionHash: OWNER, prompt: "a lighthouse still registering", bytes: PNG });
    vi.setSystemTime(new Date(NOW.getTime() - 20 * 60 * 1000));
    expect(caps.take("register").ok).toBe(true);
    expect(store.claimPicture(old.id, ["woven"], "register")).not.toBeNull();
    vi.setSystemTime(new Date(NOW.getTime() - 5 * 60 * 1000));
    expect(caps.take("register").ok).toBe(true);
    expect(store.claimPicture(fresh.id, ["woven"], "register")).not.toBeNull();
    vi.setSystemTime(NOW);

    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    const after = await boot();
    const { register } = await import("@/instrumentation");
    await register();
    expect(after.store.readPicture(old.id)).toMatchObject({ state: "failed", failure: "interrupted" });
    expect(after.store.readPicture(old.id)?.busy).toBeUndefined();
    expect(after.store.readPicture(fresh.id)).toMatchObject({ state: "woven", busy: "register" });
    const againCaps = await import("@/lib/server/caps");
    expect(againCaps.take("register")).toEqual({ ok: false, refusal: "limit", scope: "day" });
  });
});
