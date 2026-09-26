// Covers the text this service writes about a failed read, against review pass 7 (V66): viem puts
// the endpoint it called into its own errors as a "URL:" line, a dedicated RPC endpoint's path is
// its access token, and the error that reaches a log line is a real viem error built here by a real
// client against a stubbed fetch. The sweep's chain read is the logging site, since it logs the
// reason as the read threw it.
// Does NOT cover a real endpoint (no request leaves the machine), and does NOT cover every call
// site one by one: the report lists them from a grep, and each one hands its error to safeReason.

import { afterEach, describe, expect, it, vi } from "vitest";
import { createPublicClient, http, type Hex } from "viem";

vi.hoisted(() => {
  process.env.PINATA_JWT = "test-token-not-a-real-pinata-jwt";
  process.env.PINATA_GATEWAY_URL = "https://moolam-test.mypinata.cloud/ipfs/";
});

const { privateSweep, memoryCursorStore } = await import("../src/sweep.js");
const { registryUnsealAbi } = await import("../src/unseal.js");
const { safeReason } = await import("../src/net/errorText.js");
type SweepLog = import("../src/sweep.js").SweepLog;

const ENDPOINT = "https://rpc.example/TOKEN123";
const TOKEN = "TOKEN123";
const REGISTRY = `0x${"cd".repeat(20)}` as Hex;
const NOW = Date.parse("2026-09-26T12:00:00Z");
const PASSPORT = `0x${"ab".repeat(32)}` as Hex;

afterEach(() => {
  vi.unstubAllGlobals();
});

/** The error viem raises when the endpoint answers 429: a ContractFunctionExecutionError around an HttpRequestError. */
async function viemError(): Promise<Error> {
  vi.stubGlobal("fetch", async () => new Response("rate limited", { status: 429 }));
  const client = createPublicClient({ transport: http(ENDPOINT, { retryCount: 0 }) });
  const thrown = await client
    .readContract({ address: REGISTRY, abi: registryUnsealAbi, functionName: "getPassport", args: [PASSPORT] })
    .then(
      () => null,
      (error: unknown) => error as Error,
    );
  vi.unstubAllGlobals();
  if (thrown === null) {
    throw new Error("the stubbed read was expected to fail");
  }
  return thrown;
}

function recordingLog(): SweepLog & { lines: { fields: Record<string, unknown>; message: string }[] } {
  const lines: { fields: Record<string, unknown>; message: string }[] = [];
  const at = (fields: unknown, message?: unknown): void => {
    lines.push({ fields: fields as Record<string, unknown>, message: String(message) });
  };
  return { lines, info: at, warn: at, error: at } as unknown as SweepLog & { lines: typeof lines };
}

describe("a failed chain read in a log line (V66)", () => {
  it("builds a viem error that carries the endpoint's token, the thing a log must not keep", async () => {
    const error = await viemError();

    expect(error.name).toBe("ContractFunctionExecutionError");
    expect(error.message).toContain(`URL: ${ENDPOINT}`);
  });

  it("logs the sweep's failed chain read without the endpoint's path", async () => {
    const error = await viemError();
    const log = recordingLog();
    const sweep = privateSweep({
      mode: "dry",
      log,
      deps: {
        list: async () => ({
          files: [{ id: "file-1", name: `sealed-thumb-${PASSPORT}.jpg`, cid: "bafy", createdAt: "2026-09-20T12:00:00Z" }],
          next: undefined,
        }),
        registered: async () => {
          throw error;
        },
        now: () => NOW,
        cursor: memoryCursorStore(),
      },
    });

    const run = await sweep.runOnce();

    expect(run?.outcome).toBe("stopped");
    const line = log.lines.find((one) => one.message.includes("the chain did not answer"));
    expect(line).toBeDefined();
    const reason = String(line?.fields.reason);
    expect(reason).toContain("HTTP request failed.");
    expect(reason).not.toContain(TOKEN);
    expect(JSON.stringify(log.lines)).not.toContain(TOKEN);
  });
});

describe("safeReason", () => {
  it("tells a viem error by its name and short message", async () => {
    expect(safeReason(await viemError())).toBe("ContractFunctionExecutionError: HTTP request failed.");
  });

  it("cuts every address in any other error to its origin, credentials and query included", () => {
    const error = new Error(
      "could not fetch https://user:pass@rpc.example/TOKEN123?key=abc then http://spare.example:8545/TOKEN123/",
    );

    expect(safeReason(error)).toBe("could not fetch https://rpc.example then http://spare.example:8545");
  });

  it("drops every URL: and Request body: line, wherever an error copied them", () => {
    const error = new Error(
      ["the chain did not answer: HTTP request failed.", "", "URL: rpc.example/TOKEN123", 'Request body: {"id":1}'].join("\n"),
    );

    expect(safeReason(error)).toBe("the chain did not answer: HTTP request failed.\n");
    expect(safeReason(error)).not.toContain(TOKEN);
  });

  it("reads a thrown value that is not an error, and leaves text with no address as it was", () => {
    expect(safeReason("the RPC timed out")).toBe("the RPC timed out");
    expect(safeReason(new Error("thumbnail too large"))).toBe("thumbnail too large");
  });
});
