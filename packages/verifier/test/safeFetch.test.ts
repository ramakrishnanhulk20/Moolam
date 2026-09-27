// Covers the guard on server-side fetches: which addresses are refused, that
// every redirect hop is checked, and that the lookup the socket uses hands over
// only approved addresses. From review pass 5: names are resolved once per hop
// through the c-ares resolver with a hard timeout, and a remote that fails after
// its headers, or redirects to a Location that does not parse, is a 502. From review pass 11 (V119):
// one deadline holds the whole fetch, every hop and lookup included.
// Does NOT cover a real connection to a real host. The redirect test opens real
// sockets through the live transport, but to a stub on this machine: the address
// guard approves a public address and the dial is then pointed at the stub, so no
// test here leaves the machine.

import { IncomingMessage, ServerResponse, createServer, type Server } from "node:http";
import net from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyRequest } from "fastify";
import { Response } from "undici";
import {
  BlockedTarget,
  UnreachableTarget,
  guardedLookup,
  isPublicAddress,
  resolveWith,
  safeFetch,
  type ResolveAll,
} from "../src/net/safeFetch.js";
import { BadRequest, readFromUrl } from "../src/routes/shared.js";

const PUBLIC_ADDRESS = "93.184.216.34";

/** A transport that fails the test if it is ever reached. */
function neverCalled(): NonNullable<Parameters<typeof safeFetch>[1]>["transport"] {
  return async (url) => {
    throw new Error(`the fetch guard let ${url} through`);
  };
}

function redirectingTransport(hops: Record<string, string>): NonNullable<
  Parameters<typeof safeFetch>[1]
>["transport"] {
  return async (url) => {
    const location = hops[url];
    if (location === undefined) {
      return new Response("bytes", { status: 200 });
    }
    return new Response(null, { status: 302, headers: { location } });
  };
}

describe("isPublicAddress", () => {
  it("refuses every form of an address inside our own network", () => {
    for (const address of [
      "127.0.0.1",
      "::1",
      "::ffff:127.0.0.1",
      "::ffff:7f00:1",
      "::ffff:a9fe:a9fe",
      "169.254.169.254",
      "10.0.0.8",
      "192.168.1.20",
      "172.16.5.4",
      "100.64.0.1",
      "255.255.255.255",
      "::",
      "fd00::1",
      "fe80::1",
      "224.0.0.1",
      "not an address",
    ]) {
      expect(isPublicAddress(address), address).toBe(false);
    }
  });

  it("allows ordinary public addresses", () => {
    for (const address of ["8.8.8.8", "93.184.216.34", "2606:4700:4700::1111"]) {
      expect(isPublicAddress(address), address).toBe(true);
    }
  });
});

describe("safeFetch", () => {
  it("refuses loopback and the metadata address however they are spelled", async () => {
    const urls = [
      "http://[::ffff:127.0.0.1]/x.jpg",
      "http://[::ffff:a9fe:a9fe]/x.jpg",
      "http://0x7f000001/x.jpg",
      "http://2130706433/x.jpg",
      "http://017700000001/x.jpg",
      "http://169.254.169.254/latest/meta-data/",
      "http://localhost:4010/x.jpg",
      "http://[::1]/x.jpg",
    ];

    for (const url of urls) {
      const attempt = safeFetch(new URL(url), { transport: neverCalled() });
      await expect(attempt, url).rejects.toBeInstanceOf(BlockedTarget);
      await expect(attempt, url).rejects.toThrow(/not a public address/);
    }
  });

  it("refuses a name that resolves to a private address", async () => {
    const resolve: ResolveAll = async () => ["10.1.2.3"];
    const attempt = safeFetch(new URL("http://images.example.test/x.jpg"), {
      resolve,
      transport: neverCalled(),
    });

    await expect(attempt).rejects.toBeInstanceOf(BlockedTarget);
    await expect(attempt).rejects.toThrow(/images.example.test/);
  });

  it("refuses a name that resolves to a public and a private address at once", async () => {
    const resolve: ResolveAll = async () => [PUBLIC_ADDRESS, "127.0.0.1"];
    const attempt = safeFetch(new URL("http://images.example.test/x.jpg"), {
      resolve,
      transport: neverCalled(),
    });

    await expect(attempt).rejects.toBeInstanceOf(BlockedTarget);
  });

  it("refuses a redirect from a public host to a private one", async () => {
    const resolve: ResolveAll = async (hostname) =>
      hostname === "images.example.test" ? [PUBLIC_ADDRESS] : ["10.0.0.5"];
    const attempt = safeFetch(new URL("http://images.example.test/x.jpg"), {
      resolve,
      transport: redirectingTransport({ "http://images.example.test/x.jpg": "http://internal.example.test/x.jpg" }),
    });

    await expect(attempt).rejects.toBeInstanceOf(BlockedTarget);
    await expect(attempt).rejects.toThrow(/internal.example.test/);
  });

  it("follows a redirect between public hosts and returns the last answer", async () => {
    const resolve: ResolveAll = async () => [PUBLIC_ADDRESS];
    const response = await safeFetch(new URL("http://images.example.test/x.jpg"), {
      resolve,
      transport: redirectingTransport({ "http://images.example.test/x.jpg": "http://cdn.example.test/x.jpg" }),
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("bytes");
  });

  it("gives up when the redirects never end", async () => {
    const resolve: ResolveAll = async () => [PUBLIC_ADDRESS];
    const attempt = safeFetch(new URL("http://images.example.test/0"), {
      resolve,
      maxRedirects: 2,
      transport: async (url) =>
        new Response(null, { status: 302, headers: { location: `${url}0` } }),
    });

    await expect(attempt).rejects.toBeInstanceOf(UnreachableTarget);
    await expect(attempt).rejects.toThrow(/redirected more than 2 times/);
  });

  // Review pass 11, answers #7 (V119): each hop had a fresh timeout of its own, so four slow hops
  // held one request for four times the limit the route states.
  it("stops four slow redirects at the one limit for the whole fetch, lookups included", async () => {
    const HOP_MS = 250;
    const LIMIT_MS = 500;
    const next: Record<string, string> = {
      "http://slow.example.test/a": "/b",
      "http://slow.example.test/b": "/c",
      "http://slow.example.test/c": "/d",
    };
    const resolve: ResolveAll = async () => {
      await new Promise((settle) => setTimeout(settle, 20));
      return [PUBLIC_ADDRESS];
    };
    const transport: NonNullable<Parameters<typeof safeFetch>[1]>["transport"] = (url, init) =>
      new Promise((answer, fail) => {
        const timer = setTimeout(() => {
          const location = next[url];
          answer(location === undefined ? new Response("bytes") : new Response(null, { status: 302, headers: { location } }));
        }, HOP_MS);
        init.signal.addEventListener("abort", () => {
          clearTimeout(timer);
          fail(init.signal.reason);
        });
      });

    const started = Date.now();
    const attempt = safeFetch(new URL("http://slow.example.test/a"), { resolve, transport, timeoutMs: LIMIT_MS });

    await expect(attempt).rejects.toBeInstanceOf(UnreachableTarget);
    expect(Date.now() - started).toBeLessThan(LIMIT_MS + HOP_MS);
  });
});

describe("safeFetch through the live transport", () => {
  let stub: Server | undefined;

  afterEach(async () => {
    vi.restoreAllMocks();
    if (stub !== undefined) {
      await new Promise<void>((resolve) => stub?.close(() => resolve()));
      stub = undefined;
    }
  });

  it("follows a two-hop redirect to a public host, checking every hop", async () => {
    const seen: string[] = [];
    stub = createServer((request, reply) => {
      seen.push(`${request.headers.host}${request.url}`);
      if (request.url === "/start") {
        reply.writeHead(301, { location: "/middle" }).end();
      } else if (request.url === "/middle") {
        reply.writeHead(302, { location: `http://cdn.example.test:${port}/image.jpg` }).end();
      } else {
        reply.writeHead(200, { "content-type": "image/jpeg" }).end("bytes");
      }
    });
    await new Promise<void>((resolve) => stub?.listen(0, "127.0.0.1", resolve));
    const port = (stub.address() as { port: number }).port;

    // The guard's own lookup still runs and still has to approve the public address. Only the
    // dial that follows is sent to the stub, which is the one thing a test cannot reach for real.
    const realConnect = net.connect;
    vi.spyOn(net, "connect").mockImplementation(((options: net.NetConnectOpts) => {
      const guarded = (options as { lookup?: net.LookupFunction }).lookup;
      return realConnect({
        ...options,
        lookup: (hostname, lookupOptions, callback) => {
          if (guarded === undefined) {
            callback(new Error("the live transport dialled without the guarded lookup"), "", 0);
            return;
          }
          guarded(hostname, lookupOptions, (error, address, family) => {
            if (error !== null) {
              callback(error, "", 0);
            } else if (Array.isArray(address)) {
              callback(null, [{ address: "127.0.0.1", family: 4 }] as never);
            } else {
              callback(null, "127.0.0.1", family ?? 4);
            }
          });
        },
      } as net.NetConnectOpts);
    }) as typeof net.connect);

    const resolved: string[] = [];
    const resolve: ResolveAll = async (hostname) => {
      resolved.push(hostname);
      return [PUBLIC_ADDRESS];
    };
    const response = await safeFetch(new URL(`http://images.example.test:${port}/start`), { resolve });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("bytes");
    expect(seen).toEqual([
      `images.example.test:${port}/start`,
      `images.example.test:${port}/middle`,
      `cdn.example.test:${port}/image.jpg`,
    ]);
    expect(resolved).toContain("cdn.example.test");
    // Review pass 5, answers #3: one lookup per hop, and the socket dials what that lookup found.
    expect(resolved).toEqual(["images.example.test", "images.example.test", "cdn.example.test"]);
  });

  // Review pass 5, answers #5: a remote that fails after its headers is a remote failure.
  it("answers 502 when the remote drops the connection in the middle of the body", async () => {
    stub = createServer((_request, reply) => {
      reply.writeHead(200, { "content-type": "image/jpeg", "content-length": "100000" });
      reply.write(Buffer.alloc(1_000, 7));
      setTimeout(() => reply.socket?.destroy(), 20);
    });
    await new Promise<void>((resolve) => stub?.listen(0, "127.0.0.1", resolve));
    const port = (stub.address() as { port: number }).port;

    // The URL names a public address literal, so the guard passes it without a lookup, and only the
    // dial is pointed at the stub on this machine.
    const realConnect = net.connect;
    vi.spyOn(net, "connect").mockImplementation(((options: net.NetConnectOpts) =>
      realConnect({ ...options, host: "127.0.0.1" } as net.NetConnectOpts)) as typeof net.connect);

    // readFromUrl holds the body against the upload ceiling until this request's response closes,
    // so the request it is handed needs a response Node has made for it.
    const raw = new IncomingMessage(new net.Socket());
    new ServerResponse(raw);
    const request = { body: { url: `http://${PUBLIC_ADDRESS}:${port}/half.jpg` }, raw } as unknown as FastifyRequest;
    const failure = await readFromUrl(request).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(BadRequest);
    expect((failure as BadRequest).statusCode).toBe(502);
  });
});

describe("the name lookup", () => {
  it("resolves through the c-ares resolver, both families, and keeps what either found", async () => {
    const asked: string[] = [];
    const resolver = {
      resolve4: async (host: string) => {
        asked.push(`4:${host}`);
        return [PUBLIC_ADDRESS];
      },
      resolve6: async (host: string) => {
        asked.push(`6:${host}`);
        throw Object.assign(new Error("no AAAA record"), { code: "ENODATA" });
      },
    };

    expect(await resolveWith(resolver)("images.example.test")).toEqual([PUBLIC_ADDRESS]);
    expect(asked.sort()).toEqual(["4:images.example.test", "6:images.example.test"]);
    expect(await resolveWith(resolver)("93.184.216.34")).toEqual(["93.184.216.34"]);
  });

  it("still refuses a name the resolver points at a private address", async () => {
    const resolver = { resolve4: async () => ["10.1.2.3"], resolve6: async () => ["fd00::1"] };
    const attempt = safeFetch(new URL("http://images.example.test/x.jpg"), {
      resolve: resolveWith(resolver),
      transport: neverCalled(),
    });

    await expect(attempt).rejects.toBeInstanceOf(BlockedTarget);
  });

  it("gives up on a lookup that never answers, as an unreachable host", async () => {
    const started = Date.now();
    const attempt = safeFetch(new URL("http://slow.example.test/x.jpg"), {
      resolve: () => new Promise<string[]>(() => undefined),
      lookupTimeoutMs: 50,
      transport: neverCalled(),
    });

    await expect(attempt).rejects.toBeInstanceOf(UnreachableTarget);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("answers a redirect whose Location does not parse as an unreachable host", async () => {
    const attempt = safeFetch(new URL("http://images.example.test/x.jpg"), {
      resolve: async () => [PUBLIC_ADDRESS],
      transport: async () => new Response(null, { status: 302, headers: { location: "http://[not an address/" } }),
    });

    await expect(attempt).rejects.toBeInstanceOf(UnreachableTarget);
  });
});

describe("guardedLookup", () => {
  it("hands the socket the approved addresses, in the canonical form", async () => {
    const lookup = guardedLookup(async () => ["::ffff:93.184.216.34", "2606:4700:4700::1111"]);
    const answer = await new Promise<unknown>((resolve, reject) => {
      lookup("images.example.test", { all: true }, (error, addresses) => {
        if (error !== null) reject(error);
        else resolve(addresses);
      });
    });

    expect(answer).toEqual([
      { address: PUBLIC_ADDRESS, family: 4 },
      { address: "2606:4700:4700::1111", family: 6 },
    ]);
  });

  it("fails the connection when the name resolves to a private address", async () => {
    const lookup = guardedLookup(async () => ["::ffff:127.0.0.1"]);
    const error = await new Promise<Error | null>((resolve) => {
      lookup("rebind.example.test", { all: true }, (failure) => resolve(failure));
    });

    expect(error).toBeInstanceOf(BlockedTarget);
    expect(error?.message).toMatch(/not a public address/);
  });
});
