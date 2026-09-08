import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import rateLimit from "@fastify/rate-limit";
import multipart from "@fastify/multipart";
import type { x402HTTPResourceServer } from "@x402/core/server";
import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import { MAX_UPLOAD_BYTES, PACKAGE_ROOT, env } from "./env.js";
import { HammingIndex } from "./index.js";
import { healthRoutes } from "./routes/health.js";
import { verifyRoutes } from "./routes/verify.js";
import { verifyPaidRoutes } from "./routes/verifyPaid.js";
import { paymentServerFromEnv } from "./x402/plugin.js";
import { EnvioSource } from "./source/EnvioSource.js";
import { JsonFileSource } from "./source/JsonFileSource.js";
import type { PassportSource } from "./source/PassportSource.js";
import type { Hex, PassportRecord } from "./types.js";

const RATE_LIMIT_PER_MINUTE = 60;

export interface Verifier {
  index: HammingIndex;
  lookupExact: (sha256: Hex) => PassportRecord | undefined;
  version: string;
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
 * The paid route is mounted only when the environment enables it, or when a
 * caller hands in its own payment server. Everything else about the service is
 * the same either way, so switching payment on adds a route and changes nothing
 * that already works.
 *
 * Throws when the source cannot be read or holds malformed records.
 */
export async function buildServer(
  options: { source?: PassportSource; logger?: boolean; payments?: x402HTTPResourceServer } = {},
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

  app.decorate("verifier", {
    index: new HammingIndex(records),
    lookupExact: (sha256: Hex) => byId.get(sha256.toLowerCase() as Hex),
    version,
  });

  await app.register(multipart, {
    limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 4 },
  });

  await app.register(rateLimit, {
    max: RATE_LIMIT_PER_MINUTE,
    timeWindow: "1 minute",
    keyGenerator: (request) => request.ip,
    onExceeding: (request) => {
      request.log.warn({ ip: request.ip, url: request.url }, "rate limit approaching");
    },
    onExceeded: (request) => {
      request.log.warn({ ip: request.ip, url: request.url }, "rejected: rate limit exceeded");
    },
  });

  await app.register(healthRoutes);
  await app.register(verifyRoutes);

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

  app.log.info({ records: records.length, source: env.PASSPORT_SOURCE }, "passport index loaded");
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
