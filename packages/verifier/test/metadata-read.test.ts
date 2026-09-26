// Covers how the verify service reads a passport's metadata document (V1): only a bare pinned
// content id, through the configured gateway, with no redirect followed and at most 64 KB of body
// counted after decompression, before any JSON is parsed. An http(s) address a registrant wrote on
// chain is refused before a request is made. The gzip test opens a real socket to a stub on this
// machine and lets undici inflate the body for real, which is the path a hostile host would use.
// Also holds the service's copy of the pinned-content predicate to the workflows' text, byte for
// byte, the same way the runner's copy is held.
// Does NOT cover a real gateway, the unseal record lookup on Pinata, or the routes that read the
// document: those treat every throw here as "could not tell" and are tested in their own files.

import fs from "node:fs";
import { createServer, type Server } from "node:http";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { fetch as undiciFetch, Response } from "undici";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as pinned from "../../workflow/moolam-verifier/pinned.js";

vi.hoisted(() => {
  process.env.PINATA_GATEWAY_URL = "https://moolam-test.mypinata.cloud/ipfs/";
});

const unseal = await import("../src/unseal.js");

const PUBLIC_ADDRESS = "93.184.216.34";
const GATEWAY = "https://moolam-test.mypinata.cloud/ipfs/";
const CID = "bafkreihcqcy7esv4kx4t7yei2sdkxu5o4tqctc6sgztti7i5oinf3wyxai";
const PINNED_FILE = path.resolve(import.meta.dirname, "../../workflow/moolam-verifier/pinned.ts");
const UNSEAL_FILE = path.resolve(import.meta.dirname, "../src/unseal.ts");

type Transport = NonNullable<Parameters<typeof unseal.readMetadataDocument>[1]>["transport"];

let server: Server | undefined;

afterEach(async () => {
  if (server !== undefined) {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;
  }
});

/** A transport that records every URL it was asked for and answers with `answer`. */
function recording(answer: () => Response): { transport: Transport; asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    transport: (async (url: string) => {
      asked.push(url);
      return answer();
    }) as Transport,
  };
}

describe("reading a passport's metadata document (V1)", () => {
  it("refuses an http or https address a registrant wrote, before any request", async () => {
    for (const uri of [
      "https://attacker.example/m.json",
      "http://attacker.example/m.json",
      `ipfs://${CID}/../../v3/files`,
      `ipfs://${CID}?x=1`,
      `IPFS://${CID}`,
      CID,
      "data:application/json,{}",
    ]) {
      const { transport, asked } = recording(() => new Response("{}", { status: 200 }));
      await expect(
        unseal.readMetadataDocument(uri, { transport, resolve: async () => [PUBLIC_ADDRESS] }),
        uri,
      ).rejects.toThrow(/pinned content id/);
      expect(asked, uri).toEqual([]);
    }
  });

  it("reads a good content id through the configured gateway and parses it", async () => {
    const { transport, asked } = recording(
      () => new Response(JSON.stringify({ name: "Monsoon nets", sealed: true }), { status: 200 }),
    );

    const document = await unseal.readMetadataDocument(`ipfs://${CID}`, {
      transport,
      resolve: async () => [PUBLIC_ADDRESS],
    });

    expect(document).toEqual({ name: "Monsoon nets", sealed: true });
    expect(asked).toEqual([`${GATEWAY}${CID}`]);
  });

  it("follows no redirect, even one to another public address", async () => {
    const { transport, asked } = recording(
      () => new Response(null, { status: 302, headers: { location: "https://elsewhere.example/m.json" } }),
    );

    await expect(
      unseal.readMetadataDocument(`ipfs://${CID}`, { transport, resolve: async () => [PUBLIC_ADDRESS] }),
    ).rejects.toThrow();
    expect(asked).toHaveLength(1);
  });

  it("stops a gzip bomb at 64 KB counted after decompression, before any JSON is parsed", async () => {
    // Twenty megabytes of padding inside one JSON string: about twenty kilobytes on the wire.
    const inflated = Buffer.concat([
      Buffer.from('{"sealed":true,"pad":"'),
      Buffer.alloc(20 * 1024 * 1024, 0x61),
      Buffer.from('"}'),
    ]);
    const onTheWire = gzipSync(inflated);
    expect(onTheWire.length).toBeLessThan(64 * 1024);

    let served = 0;
    server = createServer((_request, response) => {
      served += 1;
      response.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip" });
      response.end(onTheWire);
    });
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", () => resolve()));
    const port = (server.address() as { port: number }).port;
    // The address guard approves a public address; the dial is then pointed at the stub, so undici
    // really inflates the body and nothing leaves the machine.
    const transport = (async (_url: string, init: { signal: AbortSignal; redirect: "manual" }) =>
      await undiciFetch(`http://127.0.0.1:${port}/`, init)) as Transport;

    await expect(
      unseal.readMetadataDocument(`ipfs://${CID}`, { transport, resolve: async () => [PUBLIC_ADDRESS] }),
    ).rejects.toThrow(/65536 byte cap/);
    expect(served).toBe(1);
  }, 30_000);

  it("refuses a body that declares more than the cap without reading it", async () => {
    const { transport } = recording(
      () =>
        new Response("{}", {
          status: 200,
          headers: { "content-length": String(10 * 1024 * 1024) },
        }),
    );

    await expect(
      unseal.readMetadataDocument(`ipfs://${CID}`, { transport, resolve: async () => [PUBLIC_ADDRESS] }),
    ).rejects.toThrow(/65536 byte cap/);
  });
});

describe("the pinned-content predicate", () => {
  it("is one predicate: the service's copy is the workflows' text byte for byte", () => {
    const text = (file: string): string => {
      const source = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
      const start = source.indexOf("export function pinnedContentId(");
      expect(start, file).toBeGreaterThan(-1);
      return source.slice(start, source.indexOf("\n}\n", start) + 2);
    };
    expect(text(UNSEAL_FILE)).toBe(text(PINNED_FILE));
  });

  it("answers the same as the workflows' copy for every address shape", () => {
    for (const reference of [
      `ipfs://${CID}`,
      `ipfs://${CID}/x`,
      "ipfs://",
      "https://example.com/a.json",
      CID,
      42,
      null,
    ]) {
      expect(unseal.pinnedContentId(reference), String(reference)).toBe(pinned.pinnedContentId(reference));
    }
  });
});
