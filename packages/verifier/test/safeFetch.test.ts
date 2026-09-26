// Covers the guard on server-side fetches: which addresses are refused, that
// every redirect hop is checked, and that the lookup the socket uses hands over
// only approved addresses.
// Does NOT cover a real connection to a real host. The redirect test opens real
// sockets through the live transport, but to a stub on this machine: the address
// guard approves a public address and the dial is then pointed at the stub, so no
// test here leaves the machine.

import { createServer, type Server } from "node:http";
import net from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Response } from "undici";
import {
  BlockedTarget,
  UnreachableTarget,
  guardedLookup,
  isPublicAddress,
  safeFetch,
  type ResolveAll,
} from "../src/net/safeFetch.js";

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
