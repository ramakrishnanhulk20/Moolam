// Covers review pass 9 intake #4 (V89), the send half: sendFromWallet sends every transaction under
// a privy-idempotency-key, so when the Privy SDK sends the same request again after a lost reply,
// Privy sees the same key and runs it once. The client is the real @privy-io/node client with its
// fetch stubbed, so the retry and the headers are the SDK's own and nothing leaves the machine.
// Does NOT cover Privy's server honouring the key, and does NOT cover the /edit route reading the
// chain for the child passport before it answers send-failed: that check lives in routes/edit.ts.

import { PrivyClient } from "@privy-io/node";
import { describe, expect, it } from "vitest";
import { sendFromWallet } from "../src/edit/send.js";

const HASH = `0x${"ab".repeat(32)}`;
const REGISTRY = `0x${"cd".repeat(20)}` as const;

/** A Privy client whose every request lands in `seen`, failing the first `failures` with a 500. */
function privyWith(failures: number): { client: PrivyClient; seen: (string | null)[] } {
  const seen: (string | null)[] = [];
  let left = failures;
  const fetch = async (_input: unknown, init?: RequestInit): Promise<Response> => {
    seen.push(new Headers(init?.headers).get("privy-idempotency-key"));
    if (left > 0) {
      left -= 1;
      return new Response(JSON.stringify({ error: "bad gateway" }), {
        status: 502,
        headers: { "content-type": "application/json", "retry-after-ms": "1" },
      });
    }
    return new Response(JSON.stringify({ method: "eth_sendTransaction", data: { hash: HASH, caip2: "eip155:143" } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const client = new PrivyClient({
    appId: "moolamtestapp0000189",
    appSecret: "test-secret-not-a-real-privy-secret",
    apiUrl: "https://privy.invalid",
    fetch: fetch as never,
  });
  return { client, seen };
}

const SEND = { to: REGISTRY, data: "0x1234" as const, gasLimit: 420_000n, chainId: 143, context: {} };

describe("V89: one send is one transaction, however often the SDK retries it", () => {
  it("carries the same idempotency key on the SDK's retry of a send whose reply was lost", async () => {
    const { client, seen } = privyWith(1);

    const sent = await sendFromWallet(client, "privy-wallet-1", SEND);

    expect(sent.hash).toBe(HASH);
    expect(seen).toHaveLength(2);
    expect(seen[0]).toMatch(/^.{16,}$/);
    expect(seen[1]).toBe(seen[0]);
  }, 30_000);

  it("uses the key a caller names, and gives two separate sends two different keys", async () => {
    const named = privyWith(0);
    await sendFromWallet(named.client, "privy-wallet-1", { ...SEND, idempotencyKey: `edit-${"ef".repeat(32)}` });
    expect(named.seen).toEqual([`edit-${"ef".repeat(32)}`]);

    const twice = privyWith(0);
    await sendFromWallet(twice.client, "privy-wallet-1", SEND);
    await sendFromWallet(twice.client, "privy-wallet-1", SEND);
    expect(twice.seen).toHaveLength(2);
    expect(twice.seen[0]).not.toBe(twice.seen[1]);
  }, 30_000);
});
