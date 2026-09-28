// Covers two changes to the paid route. /verify/paid now gives its upload share back in
// its own handler, as /verify does, rather than through the handler-end backstop in shared.ts: the
// share is already back when the handler's promise settles, before the backstop's asyncEnd runs. And
// a payer who hangs up while their turn waits at the decode gate is skipped at the gate, never
// matched, never settled, and the authorisation is cancelled.
// Over a real connection on this machine for the hang-up, because only a real socket can hang up.
// The facilitator is a stub, so nothing leaves the machine. Does NOT cover a real facilitator's
// cancel, nor /edit, /prepare and /unseal, whose turns skip through the same studioTurn check.

import { tracingChannel } from "node:diagnostics_channel";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { decodePaymentSignatureHeader } from "@x402/core/http";
import type { HTTPRequestContext, x402HTTPResourceServer } from "@x402/core/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { heldUploads } from "../src/routes/shared.js";
import { verifyPaidRoutes } from "../src/routes/verifyPaid.js";
import { buildServer } from "../src/server.js";
import { makeImage, multipartBody } from "./helpers.js";

const HEADER = Buffer.from(
  JSON.stringify({
    x402Version: 2,
    accepted: {},
    payload: {
      signature: `0x${"5a".repeat(65)}`,
      authorization: {
        from: "0x3333333333333333333333333333333333333333",
        to: "0xC5ead1E4E5C6d56E87e02317f3fB3731cB0b6Ef7",
        value: "50000",
        validAfter: "0",
        validBefore: "1790051150",
        nonce: `0x${"c4".repeat(32)}`,
      },
    },
  }),
  "utf8",
).toString("base64");

function payments(options: { refuse: boolean; cancel: () => Promise<void>; settle: () => Promise<unknown> }): x402HTTPResourceServer {
  return {
    initialize: async () => undefined,
    processHTTPRequest: async (context: HTTPRequestContext) =>
      options.refuse
        ? { type: "payment-error", response: { status: 402, headers: {}, body: { error: "insufficient_funds" } } }
        : {
            type: "payment-verified",
            paymentPayload: decodePaymentSignatureHeader(context.adapter.getHeader("payment-signature") ?? ""),
            paymentRequirements: {},
            declaredExtensions: [],
            cancellationDispatcher: { cancel: options.cancel },
          },
    processSettlement: options.settle,
  } as unknown as x402HTTPResourceServer;
}

async function until(check: () => boolean, what: string, ms = 5_000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) {
      throw new Error(`still not ${what} after ${ms} ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const handlerEnds = tracingChannel<{ request: { url: string } }>("fastify.request.handler");

describe("/verify/paid gives its upload share back itself", () => {
  let heldAtSettle: number[] = [];
  const onSettle = {
    start: () => undefined,
    end: () => undefined,
    asyncEnd: () => undefined,
    error: () => undefined,
    // Published when the handler's promise settles, before any asyncEnd subscriber, the backstop
    // included, runs. A share still counted here is one only the backstop would have given back.
    asyncStart: (store: { request: { url: string } }) => {
      if (store.request.url === "/verify/paid") {
        heldAtSettle.push(heldUploads.held);
      }
    },
  };

  afterEach(() => {
    handlerEnds.unsubscribe(onSettle as never);
  });

  it("has the share back by the time its handler settles, on a refused payment after the upload", async () => {
    const app = await buildServer({ source: { load: async () => [] }, logger: false });
    await app.register(verifyPaidRoutes, {
      payments: payments({ refuse: true, cancel: async () => undefined, settle: async () => ({ success: true }) }),
    });
    await app.ready();
    heldAtSettle = [];
    handlerEnds.subscribe(onSettle as never);
    try {
      const { payload, headers } = multipartBody("file", "a.jpg", "image/jpeg", await makeImage(151));
      const response = await app.inject({ method: "POST", url: "/verify/paid", payload, headers: { ...headers, "payment-signature": HEADER } });

      expect(response.statusCode).toBe(402);
      expect(heldAtSettle).toEqual([0]);
    } finally {
      await app.close();
    }
  });
});

describe("a payer who hangs up while their turn waits at the gate", () => {
  it("is skipped at the gate, never matched or settled, has the payment cancelled and the share back", async () => {
    const cancel = vi.fn(async () => undefined);
    const settle = vi.fn(async () => ({ success: true, headers: {}, transaction: "" }));
    const app = await buildServer({ source: { load: async () => [] }, logger: false });
    await app.register(verifyPaidRoutes, { payments: payments({ refuse: false, cancel, settle }) });

    // Every verify turn this test's HTTP caller would run is recorded, so a skipped one shows as absent.
    const realVerify = app.verifier.runVerify;
    const realMatch = app.verifier.runMatch;
    const ran: string[] = [];
    app.verifier.runVerify = ((task, caller, gone) =>
      realVerify(async () => {
        ran.push(`verify:${caller}`);
        return await task();
      }, caller, gone)) as typeof app.verifier.runVerify;
    app.verifier.runMatch = ((bytes, caller, gone) => {
      ran.push(`match:${caller}`);
      return realMatch(bytes, caller, gone);
    }) as typeof app.verifier.runMatch;

    await app.listen({ port: 0, host: "127.0.0.1" });
    const { port } = app.server.address() as AddressInfo;

    // Both verify slots held by two other callers, so the payer's first turn has to wait.
    const releases: (() => void)[] = [];
    const holders = ["holder-1", "holder-2"].map((caller) =>
      realVerify(() => new Promise<void>((resolve) => releases.push(resolve)), caller),
    );

    try {
      const { payload, headers } = multipartBody("file", "a.jpg", "image/jpeg", await makeImage(152));
      const client = httpRequest({
        host: "127.0.0.1",
        port,
        method: "POST",
        path: "/verify/paid",
        headers: { ...headers, "content-length": String(payload.length), "payment-signature": HEADER },
      });
      client.on("error", () => undefined);
      client.end(payload);

      await until(() => heldUploads.held > 0, "holding the upload");
      // Long enough for the handler to reach the gate and queue behind the two holders.
      await new Promise((resolve) => setTimeout(resolve, 300));
      client.destroy();
      await new Promise((resolve) => setTimeout(resolve, 300));

      for (const release of releases) release();
      await Promise.all(holders);
      await until(() => heldUploads.held === 0, "given back");

      expect(ran).toEqual([]);
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(settle).not.toHaveBeenCalled();
    } finally {
      for (const release of releases) release();
      await app.close();
    }
  }, 30_000);
});
