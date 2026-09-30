import { AsyncLocalStorage } from "node:async_hooks";
import type { IncomingMessage } from "node:http";
import { finished } from "node:stream/promises";
import type { FastifyCorsOptions } from "@fastify/cors";
import { createMcpHandler, isJsonContentType, validateOriginHeader } from "@modelcontextprotocol/server";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { env } from "../env.js";
import { liveCardReader, offlineCardReader, type CardAnswer, type CardReader } from "../mcp/agentCard.js";
import { heldChain, liveMcpChain, offlineMcpChain, type McpChain } from "../mcp/chain.js";
import type { McpDeps } from "../mcp/facts.js";
import { MAX_BASE64_CHARS } from "../mcp/inputs.js";
import { heldReads } from "../mcp/memory.js";
import { envioRecentReader, unavailableRecentReader, type RecentReader } from "../mcp/recent.js";
import { moolamMcpServer } from "../mcp/serverFactory.js";
import { safeReason } from "../net/errorText.js";
import { LOOKUP_TIMEOUT_MS } from "../net/safeFetch.js";
import { loadPlatforms } from "../platforms/platforms.js";
import { readMetadataDocument, type DocumentReader } from "../unseal.js";
import { CallerGone, UploadsBusy, giveBackUploads, underUploadCeiling } from "./shared.js";

declare module "fastify" {
  interface FastifyContextConfig {
    cors?: FastifyCorsOptions | false;
  }
}

export const MCP_PATH = "/mcp";

/**
 * The most a POST to /mcp may carry: a picture at the upload cap written as base64, plus 64 KB for
 * the JSON-RPC envelope around it. The service's own JSON limit is 16 KB, which no picture fits.
 */
export const MCP_BODY_LIMIT = MAX_BASE64_CHARS + 64 * 1024;

/** The headers an MCP client sends. A browser client's preflight must be told each one is allowed. */
export const MCP_ALLOWED_HEADERS = [
  "Content-Type",
  "Accept",
  "MCP-Protocol-Version",
  "Mcp-Method",
  "Mcp-Name",
  "Mcp-Session-Id",
  "Last-Event-ID",
];

/** Headers that describe the connection or the body this route has already read, never passed on. */
const NOT_FORWARDED = new Set(["host", "connection", "keep-alive", "transfer-encoding", "content-length", "upgrade", "expect"]);

/** Metadata documents are addressed by their content, so a read one never changes. */
const DOCUMENT_HOLD_MS = 60 * 60_000;
const CARD_HOLD_MS = 60_000;

/** Readers a test hands in, each replacing the live one; left out under a test runner, none reaches a network. */
export interface McpRouteOptions {
  chain?: McpChain;
  readDocument?: DocumentReader;
  readCard?: CardReader;
  recent?: RecentReader;
  /** A platform list document in place of the bundled one, loaded and checked the same way. */
  platforms?: unknown;
}

class EnvelopeTooLarge extends Error {
  readonly statusCode = 413;
}

class EnvelopeCut extends Error {
  readonly statusCode = 400;
}

function heldDocuments(read: DocumentReader): DocumentReader {
  const held = heldReads<unknown>({ ttlMs: DOCUMENT_HOLD_MS, maxEntries: 500 });
  return async (uri) => await held.read(uri, async () => await read(uri));
}

/** Cards are held a minute; a card host that did not answer is asked again next time. */
function heldCards(read: CardReader): CardReader {
  const held = heldReads<CardAnswer>({ ttlMs: CARD_HOLD_MS, maxEntries: 500 });
  return async (uri) => {
    try {
      return await held.read(uri, async () => {
        const answer = await read(uri);
        if (answer.status === "none" && answer.reason === "unreadable") {
          throw answer;
        }
        return answer;
      });
    } catch (unheld) {
      return unheld as CardAnswer;
    }
  };
}

function liveRecent(): RecentReader {
  return env.PASSPORT_SOURCE === "envio" && env.ENVIO_GRAPHQL_URL !== undefined
    ? envioRecentReader(env.ENVIO_GRAPHQL_URL)
    : unavailableRecentReader();
}

/** The hostnames a browser Origin may carry: the sites CORS_ORIGINS already names, and no others. */
function allowedOriginHosts(): string[] {
  return env.CORS_ORIGINS.map((origin) => new URL(origin).hostname);
}

/**
 * Reads the request body, at most `limit` bytes, while readCounted in shared.ts counts each chunk
 * against the upload ceilings. `dropped` turns true once the ceiling has refused the body, and the
 * chunks still arriving after that are read off the wire and not kept.
 */
function drain(raw: IncomingMessage, limit: number, dropped: () => boolean): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    if (raw.readableEnded) {
      resolve(Buffer.alloc(0));
      return;
    }
    const chunks: Buffer[] = [];
    let total = 0;
    const stop = (): void => {
      raw.removeListener("data", onData);
      raw.removeListener("end", onEnd);
      raw.removeListener("error", onError);
      raw.removeListener("close", onClose);
    };
    const onData = (chunk: Buffer): void => {
      if (dropped()) {
        return;
      }
      total += chunk.length;
      if (total > limit) {
        stop();
        raw.resume();
        reject(new EnvelopeTooLarge("the request body is over the limit for /mcp"));
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = (): void => {
      stop();
      resolve(Buffer.concat(chunks));
    };
    const onError = (error: Error): void => {
      stop();
      reject(error);
    };
    const onClose = (): void => {
      if (!raw.readableEnded) {
        stop();
        reject(new EnvelopeCut("the request body ended before it was complete"));
      }
    };
    raw.on("data", onData);
    raw.once("end", onEnd);
    raw.once("error", onError);
    raw.once("close", onClose);
  });
}

/**
 * The JSON-RPC envelope, read under the same upload ceilings a /verify upload is (M5). A declared
 * length over the limit is refused before a byte is read, and a body that runs past it without
 * declaring one is refused the moment it does.
 */
async function readEnvelope(request: FastifyRequest): Promise<Buffer> {
  const declared = Number(request.headers["content-length"] ?? "");
  if (Number.isFinite(declared) && declared > MCP_BODY_LIMIT) {
    throw new EnvelopeTooLarge("the request body is over the limit for /mcp");
  }
  let refused = false;
  try {
    const upload = await underUploadCeiling(request, async () => ({
      bytes: await drain(request.raw, MCP_BODY_LIMIT, () => refused),
    }));
    return upload.bytes;
  } catch (error) {
    refused = true;
    throw error;
  }
}

function rpcError(reply: FastifyReply, status: number, code: number, message: string): FastifyReply {
  return reply.code(status).type("application/json").send({ jsonrpc: "2.0", error: { code, message }, id: null });
}

function forwardedHeaders(request: FastifyRequest): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined || NOT_FORWARDED.has(name)) {
      continue;
    }
    for (const item of Array.isArray(value) ? value : [value]) {
      headers.append(name, item);
    }
  }
  return headers;
}

/**
 * POST /mcp: the Model Context Protocol server, stateless, serving 2026-07-28 clients and 2025-era
 * clients from one handler. It only reads: six tools and two resources over the passport registry,
 * the AI-use register, the index and the ERC-8004 identity registry. There is no sign-in and the
 * tool list is the same for every caller.
 *
 * In front of the SDK's handler, this route: refuses a present Origin that is not one of the sites
 * CORS_ORIGINS names with 403 through the SDK's own validateOriginHeader, and lets a request with
 * no Origin through, as a server-side client sends none (M5); answers a browser's preflight with
 * the MCP header set; refuses a body that is not JSON (415) or is over MCP_BODY_LIMIT (413) before
 * buffering it, and counts the body it reads against the upload ceilings, so a flood of large
 * envelopes is turned away busy (503) as uploads are. The answer goes out through Fastify's reply,
 * so the service's security headers are on it too, with no-store.
 *
 * The caller's rate-limit bucket is the service's per-address one. Claude connects from Anthropic's
 * cloud, so every Claude user shares that one address and one bucket.
 */
export async function mcpRoutes(app: FastifyInstance, options: McpRouteOptions): Promise<void> {
  const offline = env.NODE_ENV === "test";
  const deps: McpDeps = {
    app,
    chain: heldChain(options.chain ?? (offline ? offlineMcpChain() : liveMcpChain())),
    readDocument: heldDocuments(
      options.readDocument ??
        (offline
          ? async () => {
              throw new Error("this host makes no gateway reads under a test runner");
            }
          : async (uri) => await readMetadataDocument(uri, { timeoutMs: LOOKUP_TIMEOUT_MS })),
    ),
    readCard: heldCards(options.readCard ?? (offline ? offlineCardReader() : liveCardReader())),
    recent: options.recent ?? (offline ? unavailableRecentReader() : liveRecent()),
    platforms: await loadPlatforms(options.platforms),
  };
  if (!deps.platforms.ok) {
    app.log.warn({ reason: deps.platforms.reason }, "mcp: the platform list was refused, so no answer carries a platform label");
  }

  // The request each MCP server instance answers. The SDK builds a fresh server inside the handler
  // call for every request, of either era, so the store set around that call is the one it sees.
  const caller = new AsyncLocalStorage<FastifyRequest>();
  const handler = createMcpHandler(
    () => {
      const request = caller.getStore();
      if (request === undefined) {
        throw new Error("an MCP server was asked for outside a request");
      }
      return moolamMcpServer(deps, request);
    },
    {
      onerror: (error) => {
        app.log.info({ reason: safeReason(error) }, "mcp: the protocol handler refused or failed a request");
      },
    },
  );
  app.addHook("onClose", async () => {
    await handler.close();
  });

  const allowed = allowedOriginHosts();
  app.addHook("onRequest", async (request, reply) => {
    const origin = validateOriginHeader(request.headers.origin, allowed);
    if (!origin.ok) {
      request.log.warn({ ip: request.ip }, "rejected: /mcp from an origin that is not allowed");
      return rpcError(reply, 403, -32000, "this origin may not call this server");
    }
  });

  // This scope reads its own body, so the service's 16 KB JSON parser never buffers it first.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser("*", (_request, _payload, done) => {
    done(null, undefined);
  });

  const cors: FastifyCorsOptions = { methods: ["POST"], allowedHeaders: MCP_ALLOWED_HEADERS };

  app.options(MCP_PATH, { config: { cors } }, async (request, reply) => {
    if ((request as { corsPreflightEnabled?: boolean }).corsPreflightEnabled !== true) {
      return reply.callNotFound();
    }
    return reply.send();
  });

  app.post(MCP_PATH, { config: { cors } }, async (request, reply) => {
    try {
      if (!isJsonContentType(request.headers["content-type"] ?? null)) {
        return rpcError(reply, 415, -32000, "Content-Type must be application/json");
      }
      let body: unknown;
      try {
        body = JSON.parse((await readEnvelope(request)).toString("utf8")) as unknown;
      } catch (error) {
        if (error instanceof SyntaxError) {
          return rpcError(reply, 400, -32700, "the request body is not JSON");
        }
        throw error;
      }

      const abort = new AbortController();
      reply.raw.once("close", () => {
        abort.abort();
      });
      const forwarded = new Request(new URL(MCP_PATH, "http://localhost"), {
        method: "POST",
        headers: forwardedHeaders(request),
        signal: abort.signal,
      });
      const response = await caller.run(request, async () => await handler.fetch(forwarded, { parsedBody: body }));
      // The SDK marks an event stream no-cache, which still lets a store keep it. An answer here can
      // carry text a registrant wrote and facts that change with the next block, so nothing keeps it;
      // no-transform stays so no proxy buffers a stream.
      const headers = new Headers(response.headers);
      headers.set("cache-control", "no-store, no-transform");
      reply.send(new Response(response.body, { status: response.status, headers }));
      // The upload account is given back when this handler returns, so it waits for the answer,
      // which a 2025-era client can be sent as a stream after the handler call has resolved.
      await finished(reply.raw).catch(() => undefined);
      return reply;
    } catch (error) {
      if (error instanceof CallerGone) {
        return rpcError(reply, 499, -32000, "client-gone");
      }
      if (error instanceof UploadsBusy) {
        return rpcError(reply, 503, -32000, "busy");
      }
      if (error instanceof EnvelopeTooLarge) {
        return rpcError(reply, 413, -32000, `the request body is over the ${MCP_BODY_LIMIT} byte limit for /mcp`);
      }
      if (error instanceof EnvelopeCut) {
        return rpcError(reply, 400, -32700, "the request body ended before it was complete");
      }
      request.log.warn({ ip: request.ip, reason: safeReason(error) }, "rejected: /mcp failed");
      return rpcError(reply, 500, -32603, "the MCP server failed to handle the request");
    } finally {
      giveBackUploads(request);
    }
  });
}
