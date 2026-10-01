// Covers the delivery worker's spending rules with the chain stood in for (P34): a ticket whose
// passport the platform's wallet no longer holds is skipped without a send, a ticket is sent at most
// once in one poll however often the list names it, a destination the recipient rule refuses is never
// sent (P31), a ticket is reported failed after maxTries and never tried again, stop() leaves the
// worker idle, and the worker logs nothing and keeps the platform key in the Authorization header.
// Does NOT cover a hand-over that lands: fork.test.ts runs that against the live registry bytecode
// on an anvil fork, where a successful receipt and the ownerOf read after it are real. The service is
// the HTTP stand-in in support/mock-service.ts; the real routes are tested in packages/verifier.

import { createHash } from "node:crypto";
import { defineChain, getAddress, type Address, type Hex, type PublicClient } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import type { ChainReader, PlatformWalletClient } from "../src/chain.js";
import { MOOLAM_REGISTRY } from "../src/constants.js";
import { runDeliveries, type DeliveryWorker } from "../src/deliveries.js";
import { MockVerifyService } from "./support/mock-service.js";

const KEY = "5c".repeat(32);
const INTERVAL = 250;
const chain = defineChain({
  id: 143,
  name: "Monad stand-in",
  nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: ["http://127.0.0.1:1"] } },
});

const platform = privateKeyToAccount(generatePrivateKey());
const person = getAddress(privateKeyToAccount(generatePrivateKey()).address);
const stranger = getAddress(privateKeyToAccount(generatePrivateKey()).address);

function passportId(label: string): Hex {
  return `0x${createHash("sha256").update(label).digest("hex")}`;
}

function ticketId(label: string): string {
  return createHash("sha256").update(label).digest("hex").slice(0, 32);
}

/** The chain as the worker sees it: who holds each passport, and whether a simulation or receipt fails. */
interface StandIn {
  holders: Map<bigint, Address>;
  simulateFails: boolean;
}

let service: MockVerifyService;
let standIn: StandIn;
let writes: bigint[];
let worker: DeliveryWorker | undefined;
let consoleSpies: MockInstance[];

function publicClient(): ChainReader {
  return {
    getChainId: async () => 143,
    readContract: async ({ functionName, args }: { functionName: string; args: [bigint] }) => {
      if (functionName !== "ownerOf") throw new Error(`unexpected read ${functionName}`);
      const holder = standIn.holders.get(args[0]);
      if (holder === undefined) throw new Error("ERC721NonexistentToken");
      return holder;
    },
    simulateContract: async (call: { address: Address; args: [Address, Address, bigint] }) => {
      if (getAddress(call.address) !== MOOLAM_REGISTRY) throw new Error("not the registry");
      if (standIn.simulateFails) throw new Error("ERC721InvalidReceiver");
      return { request: call };
    },
    // A send that reaches the chain and reverts: a failed try that cost gas.
    waitForTransactionReceipt: async () => ({ status: "reverted", logs: [], blockNumber: 1n }),
  } as unknown as ChainReader;
}

function walletClient(): PlatformWalletClient {
  return {
    account: platform,
    chain,
    request: async ({ method }: { method: string }) => {
      if (method === "eth_chainId") return "0x8f";
      throw new Error(`unexpected request ${method}`);
    },
    writeContract: async (request: { args: [Address, Address, bigint] }) => {
      writes.push(request.args[2]);
      return `0x${"ab".repeat(32)}`;
    },
  } as unknown as PlatformWalletClient;
}

function listed(): number {
  return service.seen.filter((one) => one.url === "/platform/deliveries").length;
}

/** How many lists the service had answered when a test last counted, so no poll is missed or counted twice. */
let mark = 0;

async function start(maxTries?: number): Promise<DeliveryWorker> {
  mark = listed();
  worker = await runDeliveries({
    verifyUrl: service.base,
    platformKey: KEY,
    walletClient: walletClient(),
    publicClient: publicClient(),
    intervalMs: INTERVAL,
    ...(maxTries === undefined ? {} : { maxTries }),
  });
  return worker;
}

/** Waits until the service has answered `count` more deliveries lists, so a test counts whole polls. */
async function polls(count: number): Promise<void> {
  const target = mark + count;
  mark = target;
  const giveUpAt = Date.now() + 20_000;
  while (listed() < target) {
    if (Date.now() > giveUpAt) throw new Error("the worker stopped polling");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  // The list answer is in; give the entries' reads and sends of that poll time to finish.
  await new Promise((resolve) => setTimeout(resolve, INTERVAL / 2));
}

beforeAll(async () => {
  consoleSpies = (["log", "info", "warn", "error", "debug"] as const).map((method) => vi.spyOn(console, method));
  service = new MockVerifyService({ platformKey: KEY, agentId: 1n, creatorWallet: platform.address, reader: {} as PublicClient });
  await service.start();
});

beforeEach(() => {
  standIn = { holders: new Map(), simulateFails: false };
  writes = [];
  service.deliveries = [];
});

afterEach(async () => {
  await worker?.stop();
  worker = undefined;
});

afterAll(async () => {
  await service.stop();
  for (const spy of consoleSpies) spy.mockRestore();
});

describe("the delivery worker", () => {
  it("refuses a bad interval, try count or key before it polls", async () => {
    const base = { verifyUrl: service.base, platformKey: KEY, walletClient: walletClient(), publicClient: publicClient() };
    await expect(runDeliveries({ ...base, intervalMs: 10 })).rejects.toMatchObject({ code: "invalid-input" });
    await expect(runDeliveries({ ...base, maxTries: 0 })).rejects.toMatchObject({ code: "invalid-input" });
    await expect(runDeliveries({ ...base, platformKey: "not-a-key" })).rejects.toMatchObject({ code: "invalid-input" });
    const offChain = { ...publicClient(), getChainId: async () => 1 } as unknown as ChainReader;
    await expect(runDeliveries({ ...base, publicClient: offChain })).rejects.toMatchObject({ code: "wrong-chain" });
  });

  it("skips a ticket whose passport the platform's wallet no longer holds, and never counts it as a try", async () => {
    const id = passportId("moved");
    standIn.holders.set(BigInt(id), stranger);
    service.deliveries = [{ ticketId: ticketId("moved"), passportId: id, destination: person }];
    await start(1);
    await polls(3);
    expect(writes).toEqual([]);
    expect(service.failedReports).toEqual([]);
  });

  it("sends a ticket at most once in one poll, even when the list names it twice", async () => {
    const id = passportId("twice");
    standIn.holders.set(BigInt(id), getAddress(platform.address));
    const entry = { ticketId: ticketId("twice"), passportId: id, destination: person };
    service.deliveries = [entry, entry, { ...entry }];
    await start(10);
    await polls(1);
    const afterOne = writes.length;
    expect(afterOne).toBe(1);
    await polls(1);
    expect(writes.length).toBe(afterOne + 1);
  });

  it("reports a ticket failed after maxTries failed sends and never sends it again", async () => {
    const id = passportId("reverts");
    standIn.holders.set(BigInt(id), getAddress(platform.address));
    const ticket = ticketId("reverts");
    service.deliveries = [{ ticketId: ticket, passportId: id, destination: person }];
    await start(3);
    await polls(5);
    expect(writes).toEqual([BigInt(id), BigInt(id), BigInt(id)]);
    expect(service.failedReports).toEqual([ticket]);

    // A service that still lists the ticket after the report gets no fourth send.
    service.deliveries = [{ ticketId: ticket, passportId: id, destination: person }];
    await polls(2);
    expect(writes).toHaveLength(3);
  });

  it("counts a refused simulation as a failed try without sending anything", async () => {
    const id = passportId("simulation");
    standIn.holders.set(BigInt(id), getAddress(platform.address));
    standIn.simulateFails = true;
    const ticket = ticketId("simulation");
    service.deliveries = [{ ticketId: ticket, passportId: id, destination: person }];
    await start(2);
    await polls(3);
    expect(writes).toEqual([]);
    expect(service.failedReports).toContain(ticket);
  });

  it("never sends to a bad, zero, registry or own-wallet destination", async () => {
    const bad = ["0x1234", `0x${"00".repeat(20)}`, MOOLAM_REGISTRY, platform.address.toLowerCase(), person.replace(/[a-f]/, (c) => c.toUpperCase())];
    service.deliveries = bad.map((destination, index) => {
      const id = passportId(`bad-${index}`);
      standIn.holders.set(BigInt(id), getAddress(platform.address));
      return { ticketId: ticketId(`bad-${index}`), passportId: id, destination };
    });
    await start(1);
    await polls(2);
    expect(writes).toEqual([]);
    expect(service.failedReports.slice(-bad.length).sort()).toEqual(bad.map((_, index) => ticketId(`bad-${index}`)).sort());
  });

  it("stops cleanly: no poll and no send after stop resolves", async () => {
    const id = passportId("stop");
    standIn.holders.set(BigInt(id), getAddress(platform.address));
    service.deliveries = [{ ticketId: ticketId("stop"), passportId: id, destination: person }];
    const running = await start(10);
    await polls(1);
    await running.stop();
    const seenAtStop = service.seen.length;
    const writesAtStop = writes.length;
    await new Promise((resolve) => setTimeout(resolve, INTERVAL * 4));
    expect(service.seen.length).toBe(seenAtStop);
    expect(writes.length).toBe(writesAtStop);
  });

  it("logged nothing, and sent the key only in the Authorization header", () => {
    expect(service.seen.length).toBeGreaterThan(10);
    for (const one of service.seen) {
      expect(one.authorization).toBe(`Bearer ${KEY}`);
      expect(one.url).not.toContain(KEY);
      expect(one.otherHeaders).not.toContain(KEY);
    }
    for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled();
  });
});
