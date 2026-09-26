// Covers review pass 9 answers #10 (V87): the reputation script appends its failure line to
// proofs/reputation.txt, a file git tracks, and a viem transport error carries the RPC endpoint,
// whose path is a dedicated endpoint's access key. The line is built by failureLine, which passes
// the error through safeReason, and the script's catch is checked to build its line that way.
// The script itself is never run here: it would read the chain and append to that file. Does NOT
// cover a real endpoint (no request leaves the machine).

import { readFileSync } from "node:fs";
import path from "node:path";
import { createPublicClient, http, parseAbi, type Hex } from "viem";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PACKAGE_ROOT } from "../src/env.js";
import { failureLine } from "../src/reputation/feedback.js";

const ENDPOINT = "https://rpc.example/TOKEN123";

afterEach(() => {
  vi.unstubAllGlobals();
});

/** The error viem raises when a path-keyed endpoint answers 500. */
async function viemError(): Promise<Error> {
  vi.stubGlobal("fetch", async () => new Response("upstream failed", { status: 500 }));
  const client = createPublicClient({ transport: http(ENDPOINT, { retryCount: 0 }) });
  const thrown = await client
    .readContract({
      address: `0x${"cd".repeat(20)}` as Hex,
      abi: parseAbi(["function getSummary(uint256) view returns (uint64)"]),
      functionName: "getSummary",
      args: [1n],
    })
    .then(
      () => null,
      (error: unknown) => error as Error,
    );
  if (thrown === null) throw new Error("the stubbed endpoint answered");
  return thrown;
}

describe("V87: a failed reputation post never writes the endpoint's key", () => {
  it("builds the failure line from safeReason, so the key in the endpoint's path never reaches it", async () => {
    const error = await viemError();
    expect(error.message).toContain("TOKEN123");

    const line = failureLine(error);

    expect(line.startsWith("FAILED: ")).toBe(true);
    expect(line).not.toContain("TOKEN123");
    expect(line).not.toMatch(/URL:|Request body:/);
  });

  it("is the only way the script writes a caught error", () => {
    const script = readFileSync(path.join(PACKAGE_ROOT, "scripts", "reputation-post.ts"), "utf8");

    expect(script).toMatch(/say\(failureLine\(error\)\)/);
    expect(script).not.toMatch(/\.message/);
  });
});
