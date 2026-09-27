// Covers review pass 10 V99: the index's word on how current it is must hold when the indexer itself
// stops or re-syncs while its GraphQL endpoint keeps answering. Each load reads Envio's own
// chain_metadata beside the first passport page, and the time of the block the indexer reached is
// read from the chain, so an index an hour behind the chain head, or one still syncing, reads stale
// although the load that brought it just succeeded. A chain that cannot be read is no proof of
// anything, so it reads stale too.
// Does NOT cover the live Envio endpoint or a real RPC: the index is a local mock GraphQL server and
// the chain is a stub that answers block times. The five-period rule for a load that fails is
// test/stale-index.test.ts.

import { createServer, type Server } from "node:http";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/server.js";
import { EnvioSource } from "../src/source/EnvioSource.js";

const PERIOD_MS = 60_000;
/** The chain head the stub answers with, and its time in unix seconds. */
const HEAD = 108_000_000n;
const HEAD_TIME = 1_790_000_000n;
/** Monad makes a block about every 0.4 seconds, so the stub's block n was mined at this time. */
const timeOf = (block: bigint): bigint => HEAD_TIME - ((HEAD - block) * 2n) / 5n;
const CAUGHT_UP = "2026-09-20T10:00:00.000Z";

let running: Server | undefined;
let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
  if (running !== undefined) {
    await new Promise<void>((resolve) => running?.close(() => resolve()));
    running = undefined;
  }
});

/** A mock Envio endpoint whose chain_metadata row says what `meta` holds when it is asked. */
async function envio(meta: { block: bigint; caughtUp: string | null }): Promise<string> {
  const server = createServer((request, reply) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = {
        data: {
          Passport: [],
          chain_metadata: [
            {
              chain_id: 143,
              latest_processed_block: Number(meta.block),
              timestamp_caught_up_to_head_or_endblock: meta.caughtUp,
            },
          ],
        },
      };
      reply.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  running = server;
  const address = server.address() as { port: number };
  return `http://127.0.0.1:${address.port}/v1/graphql`;
}

/** The chain as the source reads it: the newest block with no argument, any block by its number. */
function chainStub(state: { readable: boolean }) {
  return {
    getBlock: async (args?: { blockNumber: bigint }) => {
      if (!state.readable) {
        throw new Error("HTTP request failed");
      }
      const number = args?.blockNumber ?? HEAD;
      return { number, timestamp: timeOf(number) };
    },
  };
}

async function indexNow(url: string, chain: ReturnType<typeof chainStub>): Promise<Record<string, unknown>> {
  app = await buildServer({
    source: new EnvioSource({ url, chain } as ConstructorParameters<typeof EnvioSource>[0]),
    logger: false,
    index: { refreshMs: PERIOD_MS, clock: () => Number(HEAD_TIME) * 1000 },
  });
  await app.ready();
  const health = await app.inject({ method: "GET", url: "/health" });
  expect(health.statusCode).toBe(200);
  return health.json().index as Record<string, unknown>;
}

describe("V99: an index whose indexer has fallen behind says so", () => {
  it("reads stale when the indexer's newest block is an hour behind the chain head, although the load just succeeded", async () => {
    const behind = HEAD - 9_000n;
    const url = await envio({ block: behind, caughtUp: CAUGHT_UP });

    const index = await indexNow(url, chainStub({ readable: true }));

    expect(Number(timeOf(behind))).toBe(Number(HEAD_TIME) - 3_600);
    expect(index).toEqual({
      loadedAt: Number(HEAD_TIME),
      stale: true,
      indexedTo: Number(behind),
      indexedAt: Number(HEAD_TIME) - 3_600,
    });
  });

  it("reads current when the indexer is half a minute behind the head and has caught up", async () => {
    const near = HEAD - 75n;
    const url = await envio({ block: near, caughtUp: CAUGHT_UP });

    const index = await indexNow(url, chainStub({ readable: true }));

    expect(index).toEqual({
      loadedAt: Number(HEAD_TIME),
      stale: false,
      indexedTo: Number(near),
      indexedAt: Number(HEAD_TIME) - 30,
    });
  });

  it("reads stale while the indexer says it is still syncing, as after a redeploy that replays from its start block", async () => {
    const url = await envio({ block: HEAD - 75n, caughtUp: null });

    const index = await indexNow(url, chainStub({ readable: true }));

    expect(index.stale).toBe(true);
  });

  it("reads stale when the chain cannot be read, because nothing then shows the indexer is current", async () => {
    const url = await envio({ block: HEAD - 75n, caughtUp: CAUGHT_UP });

    const index = await indexNow(url, chainStub({ readable: false }));

    expect(index).toMatchObject({ stale: true, indexedTo: Number(HEAD - 75n), indexedAt: null });
  });
});
