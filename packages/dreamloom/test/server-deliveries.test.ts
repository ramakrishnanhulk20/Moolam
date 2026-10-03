// What this file does not cover: the kit's worker itself (its polls, ownerOf reads, simulations and
// failure reports), which the kit's own tests prove. runDeliveries is stood in for, so this file
// proves that Dreamloom starts exactly one worker per process with its own settings, retries a start
// that failed, stops it on shutdown, and logs fixed words only. It also proves the sweep that frees a
// picture once its passport has left Dreamloom's wallet (WO-318); the chain read under it is stood
// in for, so what a real ownerOf answers on Monad is not covered here.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { MoolamPlatformError } from "@moolam/platform";
import { privateKeyToAccount } from "viem/accounts";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({ runDeliveries: vi.fn(), resumeCosign: vi.fn() }));
const chain = vi.hoisted(() => ({ readContract: vi.fn() }));

vi.mock("viem", async (importOriginal) => {
  const actual = await importOriginal<typeof import("viem")>();
  return {
    ...actual,
    createPublicClient: (config: Parameters<typeof actual.createPublicClient>[0]) =>
      Object.assign(actual.createPublicClient(config), { readContract: chain.readContract }),
  };
});

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
    store: await import("@/lib/server/store"),
    kit: await import("@/lib/server/kit"),
  };
}

function ourListeners(): number {
  return process.listeners("SIGTERM").length;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

// The first import of the server modules reads their whole dependency graph, and on a machine that
// has not run them yet that took 8 seconds, past the 5 a test is given. It is paid here, once,
// where the limit is generous, so each test times only its own work.
beforeAll(async () => {
  await import("@/lib/server/boot");
  await import("@/lib/server/delivery-worker");
}, 120_000);

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "dreamloom-deliveries-"));
  mkdirSync(path.join(dataDir, "pictures"), { recursive: true });
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

const WALLET = privateKeyToAccount(`0x${"5ec1".repeat(16)}`).address;
const ELSEWHERE = `0x${"12".repeat(20)}`;
const START = Date.parse("2026-10-01T00:00:00Z");
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)]);

const idOf = (n: number): string => n.toString(16).padStart(32, "0");
const passportOf = (n: number): string => `0x${n.toString(16).padStart(64, "0")}`;

/** A picture registered for a signed-in visitor, whose passport waits at Moolam, written as the volume holds it. */
function seed(n: number, fields: Record<string, unknown> = {}): string {
  const record = {
    version: 1,
    id: idOf(n),
    sessionHash: "ab".repeat(32),
    prompt: "a lighthouse seeded for the sweep",
    createdAt: new Date(START + n * 1000).toISOString(),
    contentType: "image/png",
    state: "registered",
    title: "Lighthouse",
    mode: "platform",
    passportId: passportOf(n),
    registerTx: `0x${"b2".repeat(32)}`,
    delivery: { kind: "waiting", to: "r***@example.com" },
    ...fields,
  };
  writeFileSync(path.join(dataDir, "pictures", `${idOf(n)}.json`), `${JSON.stringify(record)}\n`);
  return idOf(n);
}

/** Makes the registry say who holds each passport: Dreamloom's wallet unless the id is listed as handed over. */
function handedOver(...ns: number[]): void {
  const gone = new Set(ns.map((n) => BigInt(passportOf(n))));
  chain.readContract.mockImplementation(async (call: { args: [bigint] }) => (gone.has(call.args[0]) ? ELSEWHERE : WALLET));
}

describe("WO-318: the shelf frees what Dreamloom has handed over", () => {
  it("frees a picture once its passport left Dreamloom's wallet, on the worker's own interval, and keeps one still waiting", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    sdk.runDeliveries.mockResolvedValue({ stop: async () => {} });
    const { deliveries, store } = await fresh();
    for (let n = 0; n < store.MAX_PICTURES; n += 1) seed(n);
    handedOver(0);
    expect(store.roomForAnotherPicture()).toBe(false);

    deliveries.startDeliveries();
    await vi.advanceTimersByTimeAsync(0);
    expect(store.roomForAnotherPicture()).toBe(false);
    await vi.advanceTimersByTimeAsync(deliveries.DELIVERY_INTERVAL_MS);
    await settle();

    expect(store.readPicture(idOf(0))?.state).toBe("moved");
    expect(store.readPicture(idOf(1))?.state).toBe("registered");
    expect(store.roomForAnotherPicture()).toBe(true);
    store.createPicture({ sessionHash: "ab".repeat(32), prompt: "one more lighthouse", bytes: PNG });
    expect(store.readPicture(idOf(0))).toBeNull();
    expect(store.readPicture(idOf(1))?.state).toBe("registered");
    expect(store.listPictures()).toHaveLength(store.MAX_PICTURES);
    expect(logged).toEqual(["dreamloom: deliveries: started"]);
  }, 60_000);

  it("keeps a picture whose ownership read failed, and frees it once the read answers", async () => {
    const { deliveries, store } = await fresh();
    const id = seed(1);
    chain.readContract.mockRejectedValue(new Error(`rpc down at ${RPC}`));

    await deliveries.freeHandedOver();
    expect(store.readPicture(id)?.state).toBe("registered");
    expect(logged.join("\n")).not.toContain("marker");

    handedOver(1);
    await deliveries.freeHandedOver();
    expect(store.readPicture(id)?.state).toBe("moved");
  });

  it("reads only pictures waiting at Moolam that nothing is acting on", async () => {
    const { deliveries, store } = await fresh();
    seed(1, { delivery: undefined });
    seed(2, { busy: "move", busyAt: new Date(START).toISOString() });
    seed(3, { state: "woven", mode: undefined, passportId: undefined, registerTx: undefined, delivery: undefined, title: undefined });
    seed(4, { state: "moved", delivery: { kind: "straight", to: "r***@example.com" }, moveTx: `0x${"c3".repeat(32)}`, movedTo: ELSEWHERE });
    seed(5, { mode: "cosign", delivery: undefined });
    handedOver(1, 2, 3, 4, 5);

    await deliveries.freeHandedOver();

    expect(chain.readContract).not.toHaveBeenCalled();
    expect(store.readPicture(idOf(2))?.busy).toBe("move");
    expect(store.readPicture(idOf(1))?.state).toBe("registered");
  });

  it("does not write over a move that claimed the picture while its ownership was being read", async () => {
    const { deliveries, store } = await fresh();
    const id = seed(1);
    chain.readContract.mockImplementation(async () => {
      store.claimPicture(id, ["registered"], "move");
      return ELSEWHERE;
    });

    await deliveries.freeHandedOver();

    const record = store.readPicture(id);
    expect(record?.state).toBe("registered");
    expect(record?.busy).toBe("move");
  });

  it("asks the registry who holds the passport and says held only for Dreamloom's own wallet, however the address is cased", async () => {
    const { kit } = await fresh();
    const id = passportOf(7) as `0x${string}`;
    chain.readContract.mockResolvedValue(WALLET.toLowerCase());
    expect(await kit.heldByDreamloom(id)).toBe(true);
    const call = chain.readContract.mock.calls[0]![0] as { functionName: string; args: bigint[] };
    expect(call.functionName).toBe("ownerOf");
    expect(call.args).toEqual([7n]);
    chain.readContract.mockResolvedValue(ELSEWHERE);
    expect(await kit.heldByDreamloom(id)).toBe(false);
    chain.readContract.mockRejectedValue(new Error("boom"));
    await expect(kit.heldByDreamloom(id)).rejects.toThrow("boom");
  });
});
