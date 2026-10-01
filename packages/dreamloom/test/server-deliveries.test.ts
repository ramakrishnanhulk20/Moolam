// What this file does not cover: the kit's worker itself (its polls, ownerOf reads, simulations and
// failure reports), which the kit's own tests prove. runDeliveries is stood in for, so this file
// proves that Dreamloom starts exactly one worker per process with its own settings, retries a start
// that failed, stops it on shutdown, and logs fixed words only.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { MoolamPlatformError } from "@moolam/platform";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({ runDeliveries: vi.fn(), resumeCosign: vi.fn() }));

vi.mock("@moolam/platform", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@moolam/platform")>();
  return { ...actual, ...sdk };
});

const PLATFORM_KEY = "5ec0".repeat(16);
const RPC = "https://rpc.example.com/v2/marker-5ec4-rpc";

let dataDir: string;
let logged: string[];

function settings(overrides: Record<string, string> = {}): void {
  const values: Record<string, string> = {
    MOOLAM_VERIFY_URL: "https://verify.example.com",
    MOOLAM_SITE_URL: "https://moolam.example.com",
    MOOLAM_INDEX_URL: "https://index.example.com/graphql",
    MONAD_RPC_URL: RPC,
    DREAMLOOM_ORIGIN: "http://localhost:3300",
    DREAMLOOM_WALLET_KEY: `0x${"5ec1".repeat(16)}`,
    DREAMLOOM_PASSKEY_KEY: `0x${"5ec2".repeat(16)}`,
    DREAMLOOM_PASSKEY_RP_ID: "dreamloom.example.com",
    DREAMLOOM_PLATFORM_KEY: PLATFORM_KEY,
    OPENAI_API_KEY: "sk-test",
    DATA_DIR: dataDir,
    ...overrides,
  };
  for (const [name, value] of Object.entries(values)) vi.stubEnv(name, value);
}

async function fresh(overrides: Record<string, string> = {}) {
  settings(overrides);
  vi.resetModules();
  return {
    boot: await import("@/lib/server/boot"),
    deliveries: await import("@/lib/server/delivery-worker"),
  };
}

function ourListeners(): number {
  return process.listeners("SIGTERM").length;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "dreamloom-deliveries-"));
  vi.resetAllMocks();
  logged = [];
  for (const method of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => void logged.push(args.map(String).join(" ")));
  }
});

afterEach(async () => {
  const { stopDeliveries } = await import("@/lib/server/delivery-worker");
  await stopDeliveries();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("the delivery worker", () => {
  it("starts once per process from boot, with Dreamloom's own service, key and clients, however often it is asked", async () => {
    const stop = vi.fn(async () => {});
    sdk.runDeliveries.mockResolvedValue({ stop });
    const listenersBefore = ourListeners();
    const first = await fresh();
    first.boot.startServer();
    first.boot.startServer();
    first.deliveries.startDeliveries();
    // A second copy of the module, as Next.js's separate bundles for instrumentation and routes give.
    const second = await fresh();
    second.boot.startServer();
    second.deliveries.startDeliveries();
    await settle();

    expect(sdk.runDeliveries).toHaveBeenCalledTimes(1);
    const options = sdk.runDeliveries.mock.calls[0]![0] as Record<string, unknown>;
    expect(options.verifyUrl).toBe("https://verify.example.com");
    expect(options.platformKey).toBe(PLATFORM_KEY);
    expect(options.intervalMs).toBe(5_000);
    expect(options.walletClient).toBeDefined();
    expect(options.publicClient).toBeDefined();
    expect(ourListeners()).toBe(listenersBefore + 1);
    expect(logged).toEqual(["dreamloom: deliveries: started"]);
  });

  it("stops on request: the worker's stop runs once, the signal listeners go, and a stop with nothing running is fine", async () => {
    const stop = vi.fn(async () => {});
    sdk.runDeliveries.mockResolvedValue({ stop });
    const listenersBefore = ourListeners();
    const interruptsBefore = process.listeners("SIGINT").length;
    const { deliveries } = await fresh();
    deliveries.startDeliveries();
    await settle();
    expect(process.listeners("SIGINT").length).toBe(interruptsBefore + 1);
    await deliveries.stopDeliveries();
    await deliveries.stopDeliveries();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(ourListeners()).toBe(listenersBefore);
    expect(process.listeners("SIGINT").length).toBe(interruptsBefore);
    expect(logged).toEqual(["dreamloom: deliveries: started", "dreamloom: deliveries: stopped"]);
  });

  it("stops on SIGTERM, leaving the exit to the server that also listens for it", async () => {
    const stop = vi.fn(async () => {});
    sdk.runDeliveries.mockResolvedValue({ stop });
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const other = () => {};
    process.on("SIGTERM", other);
    try {
      const { deliveries } = await fresh();
      deliveries.startDeliveries();
      await settle();
      process.emit("SIGTERM", "SIGTERM");
      await settle();
      expect(stop).toHaveBeenCalledTimes(1);
      expect(exit).not.toHaveBeenCalled();
    } finally {
      process.removeListener("SIGTERM", other);
    }
  });

  it("does not start without the kit's settings", async () => {
    const { deliveries } = await fresh({ DREAMLOOM_PLATFORM_KEY: "" });
    deliveries.startDeliveries();
    await settle();
    expect(sdk.runDeliveries).not.toHaveBeenCalled();
  });

  it("tries a failed start again a minute later, and a stop cancels the retry", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    sdk.runDeliveries.mockRejectedValueOnce(new MoolamPlatformError("wrong-chain", `the RPC at ${RPC} is not Monad`));
    sdk.runDeliveries.mockResolvedValue({ stop: async () => {} });
    const { deliveries } = await fresh();
    deliveries.startDeliveries();
    await vi.advanceTimersByTimeAsync(0);
    expect(logged).toEqual(["dreamloom: deliveries: not started, wrong-chain"]);
    await vi.advanceTimersByTimeAsync(deliveries.RETRY_START_MS);
    expect(sdk.runDeliveries).toHaveBeenCalledTimes(2);
    expect(logged.at(-1)).toBe("dreamloom: deliveries: started");

    await deliveries.stopDeliveries();
    sdk.runDeliveries.mockReset();
    sdk.runDeliveries.mockRejectedValue(new Error(`boom ${PLATFORM_KEY}`));
    deliveries.startDeliveries();
    await vi.advanceTimersByTimeAsync(0);
    await deliveries.stopDeliveries();
    await vi.advanceTimersByTimeAsync(deliveries.RETRY_START_MS * 3);
    expect(sdk.runDeliveries).toHaveBeenCalledTimes(1);
    for (const line of logged) {
      expect(line).not.toContain("5ec0");
      expect(line).not.toContain("marker");
      expect(line).toMatch(/^dreamloom: deliveries: [a-z ,-]+$/);
    }
  });
});
