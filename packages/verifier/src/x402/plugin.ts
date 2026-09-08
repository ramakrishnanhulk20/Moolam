import {
  HTTPFacilitatorClient,
  x402HTTPResourceServer,
  x402ResourceServer,
  type FacilitatorClient,
  type HTTPAdapter,
  type HTTPRequestContext,
} from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import type { FastifyRequest } from "fastify";
import { env } from "../env.js";

/** Monad mainnet in the CAIP-2 form x402 uses. The facilitator settles USDC here. */
export const X402_NETWORK = "eip155:143";

/** The one paid route. The pattern is the key x402 matches a request against. */
export const PAID_VERIFY_ROUTE = "POST /verify/paid";

/** Reads the two payment headers, v2 first, so an older client still works. */
export function paymentHeaderOf(adapter: HTTPAdapter): string | undefined {
  return adapter.getHeader("payment-signature") ?? adapter.getHeader("x-payment");
}

/** Bridges a Fastify request to the shape x402 reads. */
export class FastifyRequestAdapter implements HTTPAdapter {
  constructor(private readonly request: FastifyRequest) {}

  getHeader(name: string): string | undefined {
    const value = this.request.headers[name.toLowerCase()];
    return Array.isArray(value) ? value[0] : value;
  }

  getMethod(): string {
    return this.request.method;
  }

  getPath(): string {
    return this.request.routeOptions.url ?? new URL(this.request.url, "http://verifier.invalid").pathname;
  }

  getUrl(): string {
    const host = this.getHeader("host") ?? "verifier.invalid";
    return `${this.request.protocol}://${host}${this.request.url}`;
  }

  getAcceptHeader(): string {
    return this.getHeader("accept") ?? "";
  }

  getUserAgent(): string {
    return this.getHeader("user-agent") ?? "";
  }

  getBody(): unknown {
    return this.request.body;
  }
}

/** The request context x402 matches routes and payment headers against. */
export function contextFor(request: FastifyRequest): HTTPRequestContext {
  const adapter = new FastifyRequestAdapter(request);
  return {
    adapter,
    path: adapter.getPath(),
    method: adapter.getMethod(),
    paymentHeader: paymentHeaderOf(adapter),
  };
}

/**
 * Builds the paid side of the verify service.
 *
 * The facilitator is the piece that checks a payment signature and moves the
 * USDC, so it is injectable: tests pass a stub and never touch the real one.
 * Nothing here talks to the network until the first paid request, because
 * `initialize` is what fetches what the facilitator supports.
 */
export function buildPaymentServer(options: {
  payTo: string;
  price?: string;
  facilitator?: FacilitatorClient;
  facilitatorUrl?: string;
  resource?: string;
}): x402HTTPResourceServer {
  const facilitator =
    options.facilitator ?? new HTTPFacilitatorClient({ url: options.facilitatorUrl ?? env.X402_FACILITATOR_URL });

  const server = new x402ResourceServer(facilitator).register(X402_NETWORK, new ExactEvmScheme());

  return new x402HTTPResourceServer(server, {
    [PAID_VERIFY_ROUTE]: {
      accepts: {
        scheme: "exact",
        network: X402_NETWORK,
        payTo: options.payTo,
        price: options.price ?? env.X402_PRICE,
      },
      resource: options.resource,
      description: "Match an image against the Moolam passport registry and return its provenance",
      mimeType: "application/json",
      // The terms themselves ride in the base64 PAYMENT-REQUIRED header, which a
      // person reading a curl output cannot decode in their head. This body says
      // in words what to do next.
      unpaidResponseBody: () => ({
        contentType: "application/json",
        body: {
          error: "payment required",
          howToPay:
            "decode the PAYMENT-REQUIRED header, pay with an x402 client, then send the request again with a PAYMENT-SIGNATURE header",
          free: "POST /verify answers the same question without a payment",
        },
      }),
    },
  });
}

/**
 * The paid route as the environment describes it.
 *
 * Throws when X402_PAY_TO_ADDRESS is missing, which the environment schema
 * already refuses when X402_ENABLED is true. This is the second lock on the
 * same door: a payment route with no recipient must never mount.
 */
export function paymentServerFromEnv(): x402HTTPResourceServer {
  if (env.X402_PAY_TO_ADDRESS === undefined) {
    throw new Error("X402_ENABLED is true but X402_PAY_TO_ADDRESS is not set");
  }
  const base = env.VERIFIER_BASE_URL;
  return buildPaymentServer({
    payTo: env.X402_PAY_TO_ADDRESS,
    price: env.X402_PRICE,
    facilitatorUrl: env.X402_FACILITATOR_URL,
    resource: base.length === 0 ? undefined : `${base.replace(/\/$/, "")}/verify/paid`,
  });
}
