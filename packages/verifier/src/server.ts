import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import multipart from "@fastify/multipart";
import type { x402HTTPResourceServer } from "@x402/core/server";
import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import type { PrivyKeys } from "./auth/privy.js";
import { MAX_UPLOAD_BYTES, PACKAGE_ROOT, env } from "./env.js";
import { HammingIndex } from "./index.js";
import { matchImage, type MatchResult } from "./match.js";
import { healthRoutes } from "./routes/health.js";
import { prepareRoutes } from "./routes/prepare.js";
import { verifyRoutes } from "./routes/verify.js";
import { verifyPaidRoutes } from "./routes/verifyPaid.js";
import { paymentServerFromEnv } from "./x402/plugin.js";
import { EnvioSource } from "./source/EnvioSource.js";
import { JsonFileSource } from "./source/JsonFileSource.js";
import type { PassportSource } from "./source/PassportSource.js";
import type { Hex, PassportRecord } from "./types.js";

const RATE_LIMIT_PER_MINUTE = 60;

/**
 * How many images may be matched at the same time.
 *
 * Matching decodes the picture nine times over, so the rate limit alone does
 * not bound memory: sixty large uploads inside one minute would all decode at
 * once. Two runs in flight keeps the peak to roughly two decodes while queued
 * callers simply wait their turn.
 */
const MAX_CONCURRENT_MATCHES = 2;

export interface Verifier {
  index: HammingIndex;
  lookupExact: (sha256: Hex) => PassportRecord | undefined;
  version: string;
  /** Matches an image, waiting for a free slot so heavy uploads cannot pile up. */
  runMatch: (bytes: Buffer) => Promise<MatchResult>;
  runPrepare: <T>(task: () => Promise<T>) => Promise<T>;
}

/**
 * A first come, first served gate that lets `limit` tasks run at once.
 *
 * A caller that arrives while the gate is full parks on a promise and is woken
 * by whichever task finishes next, so nothing spins and nothing is dropped.
 */
export function concurrencyGate(limit: number): <T>(task: () => Promise<T>) => Promise<T> {
  let running = 0;
  const waiting: (() => void)[] = [];

  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (running >= limit || waiting.length > 0) {
      await new Promise<void>((resolve) => waiting.push(resolve));
    }
    running += 1;
    try {
      return await task();
    } finally {
      running -= 1;
      waiting.shift()?.();
    }
  };
}

declare module "fastify" {
  interface FastifyInstance {
    verifier: Verifier;
  }
}

const version = (
  JSON.parse(readFileSync(path.join(PACKAGE_ROOT, "package.json"), "utf8")) as { version: string }
).version;

/**
 * Picks the passport source named in the environment.
 *
 * Throws when "envio" is chosen without an endpoint. Failing loudly beats
 * booting with an empty index and telling every caller their image is
 * unregistered.
 */
export function sourceFromEnv(): PassportSource {
  if (env.PASSPORT_SOURCE === "json") {
    return new JsonFileSource(env.PASSPORT_SOURCE_PATH);
  }
  if (env.ENVIO_GRAPHQL_URL === undefined) {
    throw new Error('PASSPORT_SOURCE "envio" needs ENVIO_GRAPHQL_URL');
  }
  return new EnvioSource({ url: env.ENVIO_GRAPHQL_URL });
}

/**
 * Builds the verify service and loads the passport index once at boot.
 *
 * The index is read into memory rather than queried per request because a
 * Hamming search is a full scan by design, and rebuilding it per call would put
 * a file read in front of every verification.
 *
 * The passport id is the sha256 of the registered bytes, which is what makes
 * the exact lookup a plain map hit.
 *
 * The prepare route is mounted only when this host has both a Pinata token to
 * pin with and a Privy app id to check creators against, or when a caller hands
 * in its own key set. A host without them still verifies images; it just cannot
 * be the studio's backend, and it says so once at boot instead of failing.
 *
 * The paid route is mounted only when the environment enables it, or when a
 * caller hands in its own payment server. Everything else about the service is
 * the same either way, so switching payment on adds a route and changes nothing
 * that already works.
 *
 * Throws when the source cannot be read or holds malformed records.
 */
export async function buildServer(
  options: {
    source?: PassportSource;
    logger?: boolean;
    payments?: x402HTTPResourceServer;
    prepare?: { keys?: PrivyKeys };
  } = {},
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger ?? true,
    bodyLimit: MAX_UPLOAD_BYTES,
    // req.ip must come from the socket. Trusting a proxy header here would let
    // any caller pick their own rate-limit bucket.
    trustProxy: false,
  });

  const source = options.source ?? sourceFromEnv();
  const records = await source.load();
  const byId = new Map<Hex, PassportRecord>(records.map((record) => [record.id, record]));

  const index = new HammingIndex(records);
  const lookupExact = (sha256: Hex): PassportRecord | undefined => byId.get(sha256.toLowerCase() as Hex);
  const gate = concurrencyGate(MAX_CONCURRENT_MATCHES);

  app.decorate("verifier", {
    index,
    lookupExact,
    version,
    runMatch: (bytes: Buffer) => gate(() => matchImage(bytes, index, lookupExact)),
    runPrepare: <T>(task: () => Promise<T>) => gate(task),
  });

  // The studio uploads straight from the browser, so the app's own origin has to
  // be allowed by name. An origin that is not on the list gets no CORS header
  // back, which the browser turns into a refusal on its side.
  await app.register(cors, {
    origin: env.CORS_ORIGINS.length === 0 ? false : env.CORS_ORIGINS,
    methods: ["GET", "POST"],
    allowedHeaders: ["Authorization", "Content-Type"],
  });

  await app.register(multipart, {
    limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 4 },
  });

  await app.register(rateLimit, {
    max: RATE_LIMIT_PER_MINUTE,
    timeWindow: "1 minute",
    keyGenerator: (request) => request.ip,
    onExceeded: (request) => {
      request.log.warn({ ip: request.ip, url: request.url }, "rejected: rate limit exceeded");
    },
  });

  await app.register(healthRoutes);
  await app.register(verifyRoutes);

  const canPrepare = env.PINATA_JWT !== undefined && env.PRIVY_APP_ID !== undefined;
  if (options.prepare !== undefined || canPrepare) {
    await app.register(prepareRoutes, options.prepare ?? {});
  } else {
    app.log.info(
      "prepare route off: it needs PINATA_JWT to pin and PRIVY_APP_ID to check creators, and this host has neither or only one",
    );
  }

  const payments = options.payments ?? (env.X402_ENABLED ? paymentServerFromEnv() : undefined);
  if (payments !== undefined) {
    await app.register(verifyPaidRoutes, { payments });
  }

  app.setNotFoundHandler((request, reply) => {
    request.log.warn({ ip: request.ip, method: request.method, url: request.url }, "rejected: unknown route");
    return reply.code(404).type("application/json").send({ error: `no route for ${request.method} ${request.url}` });
  });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    const status = error.statusCode ?? 500;
    request.log.warn({ ip: request.ip, url: request.url, status, reason: error.message }, "rejected: request failed");
    return reply.code(status).send({ error: status >= 500 ? "verifier failed to handle the request" : error.message });
  });

  app.log.info(
    { records: records.length, source: env.PASSPORT_SOURCE, corsOrigins: env.CORS_ORIGINS.length },
    "passport index loaded",
  );
  return app;
}

async function start(): Promise<void> {
  const app = await buildServer();
  await app.listen({ port: env.VERIFIER_PORT, host: "0.0.0.0" });
}

// Only listen when this file is the entry point, so tests can build the server
// without binding a port.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  start().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
