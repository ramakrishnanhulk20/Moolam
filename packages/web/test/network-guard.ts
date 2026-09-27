import { afterAll, afterEach } from "vitest";

/**
 * No web test may reach a live network. The studio's code reads a real RPC, Pinata, Privy and
 * Envio through fetch, so one missing stub once sent an attack test to Monad mainnet and let it
 * wait there for a minute. Every fetch a test has not stubbed lands here instead: it is refused
 * before a byte leaves the machine, and the test that made it fails, even when the code under test
 * catches the refusal and carries on. Tests that stub fetch never reach this.
 *
 * This machine's own loopback address is let through: it is not a network, and two tests use it on
 * purpose (a dead port standing in for a dead RPC, and a headless browser driven on a local port).
 */

const refused: string[] = [];

function addressOf(input: unknown): URL | undefined {
  const raw = input instanceof Request ? input.url : input instanceof URL ? input.href : String(input);
  try {
    return new URL(raw);
  } catch {
    return undefined;
  }
}

function isLoopback(address: URL): boolean {
  const host = address.hostname;
  return host === "localhost" || host === "[::1]" || /^127(\.\d{1,3}){3}$/.test(host);
}

const machineFetch = globalThis.fetch;

globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  const address = addressOf(input);
  if (address !== undefined && isLoopback(address)) {
    return await machineFetch(input, init);
  }
  // The origin only: an RPC or gateway path can carry a key.
  const origin = address?.origin ?? "an address that is not a full URL";
  refused.push(origin);
  throw new Error(`network guard: this test called ${origin} without stubbing fetch`);
}) as typeof fetch;

function failOnRefusals(): void {
  if (refused.length === 0) {
    return;
  }
  const origins = [...new Set(refused)].join(", ");
  refused.length = 0;
  throw new Error(`network guard: unstubbed fetch to ${origins}. Stub it; web tests never call out.`);
}

afterEach(failOnRefusals);
afterAll(failOnRefusals);
