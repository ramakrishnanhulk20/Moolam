import http from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import {
  MAX_DOCUMENT_BYTES,
  MAX_PICTURE_BYTES,
  describe as describeDocument,
  isRealPicture,
  isTestCard,
  readDocument,
  readPicture,
  readUnsealRecord,
  withRecord,
} from "../src/document.js";

const GATEWAY = "https://gateway.example/ipfs/";

function answer(body: unknown, ok = true): typeof fetch {
  return (async () =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status: ok ? 200 : 502,
    })) as unknown as typeof fetch;
}

describe("telling a picture from a seed test card", () => {
  it("knows the three titles the repository's own scripts write", () => {
    expect(isTestCard("Moolam seed 4")).toBe(true);
    expect(isTestCard("Moolam prove-it 2026-09-09T11:22:33Z")).toBe(true);
    expect(isTestCard("Moolam Privy proof, the edit")).toBe(true);
    expect(isTestCard("moolam SEED 11")).toBe(true);
  });

  it("counts a document with no title as a test card, so no report is spent on it", () => {
    expect(isTestCard(null)).toBe(true);
    expect(isTestCard("  ")).toBe(true);
  });

  it("leaves a real picture alone", () => {
    expect(isTestCard("A lighthouse in fog")).toBe(false);
    expect(isTestCard("Moolam harbour at dusk")).toBe(false);
  });
});

describe("reading the pinned document", () => {
  it("reads a title and no seal from an ordinary picture", async () => {
    const document = await readDocument(
      "ipfs://bafkreiexample",
      GATEWAY,
      answer({ name: "A lighthouse in fog", thumbnail: "ipfs://bafkreithumb" }),
    );
    expect(document).toEqual({ title: "A lighthouse in fog", sealed: false, unsealed: false, readable: true, privateRecheck: false, picture: "bafkreithumb" });
    expect(isRealPicture(document)).toBe(true);
  });

  it("reads a sealed passport as sealed, and keeps it out of a sweep", async () => {
    const document = await readDocument(
      "ipfs://bafkreisealed",
      GATEWAY,
      answer({ name: "A kept picture", sealed: true, commitment: { algorithm: "sha-256", value: "0xabc" } }),
    );
    expect(document.sealed).toBe(true);
    expect(isRealPicture(document)).toBe(false);
  });

  it("reads a document that claims sealed and still names a picture as published", async () => {
    const document = await readDocument(
      "ipfs://bafkreiodd",
      GATEWAY,
      answer({ name: "Out already", sealed: true, image: "ipfs://bafkreipicture" }),
    );
    expect(document.sealed).toBe(false);
    expect(isRealPicture(document)).toBe(true);
  });

  it("reads a document carried inline as a data URI without asking any gateway", async () => {
    const inline = `data:application/json,${encodeURIComponent(JSON.stringify({ name: "Inline picture", image: "ipfs://bafkreiinline" }))}`;
    const refuse = (() => {
      throw new Error("no gateway should have been asked");
    }) as unknown as typeof fetch;

    const document = await readDocument(inline, GATEWAY, refuse);
    expect(document.title).toBe("Inline picture");
    expect(document.readable).toBe(true);
  });

  it("says unreadable rather than guessing when the gateway refuses", async () => {
    const document = await readDocument("ipfs://bafkreigone", GATEWAY, answer("nope", false));
    expect(document).toEqual({ title: null, sealed: false, unsealed: false, readable: false, privateRecheck: false, picture: null });
    expect(isRealPicture(document)).toBe(false);
  });

  it("says unreadable when the gateway answers with something that is not a document", async () => {
    const document = await readDocument("ipfs://bafkreijunk", GATEWAY, answer("<html>not json</html>"));
    expect(document.readable).toBe(false);
  });

  it("refuses a metadata address that is neither ipfs nor http", async () => {
    const document = await readDocument("who-knows", GATEWAY, answer({ name: "never read" }));
    expect(document.readable).toBe(false);
  });

  it("marks a sealed document that asks for a private re-check, and only that one", async () => {
    const asks = await readDocument(
      "ipfs://bafkreiprivate",
      GATEWAY,
      answer({ name: "Old but strong", sealed: true, privateRecheck: true }),
    );
    expect(asks).toMatchObject({ sealed: true, privateRecheck: true });
    expect(describeDocument({ name: "Plain", sealed: true }).privateRecheck).toBe(false);
    expect(describeDocument({ name: "Named", sealed: true, privateRecheck: true, image: "ipfs://x" }).privateRecheck).toBe(false);
  });

  it("does not take a picture reference that is a sentence rather than an address", () => {
    expect(describeDocument({ name: "Odd record", sealed: true, image: "the picture was lost" }).sealed).toBe(true);
  });

  it("refuses, before any spend, a document the public workflow must refuse (tally R2)", () => {
    expect(describeDocument({ name: "Harbour" }).refused).toContain("no thumbnail or image");
    expect(describeDocument({ name: "Harbour", image: "https://a.example/h.jpg" }).refused).toContain("not an IPFS content id");
    expect(describeDocument({ name: "Harbour", thumbnail: "ipfs://bafkreithumb/x" }).refused).toContain("not an IPFS content id");
    const good = describeDocument({ name: "Harbour", thumbnail: "ipfs://bafkreithumb", image: "https://a.example/h.jpg" });
    expect(good.refused).toBeUndefined();
    expect(good.picture).toBe("bafkreithumb");
  });
});

describe("fetching only pinned content (R7)", () => {
  function counting(body: unknown): { fetcher: typeof fetch; calls: { url: string; init: RequestInit | undefined }[] } {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const fetcher = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify(body), { status: 200 });
    }) as unknown as typeof fetch;
    return { fetcher, calls };
  }

  it.each([
    ["an http address", "http://example.com/metadata.json"],
    ["an https address", "https://evil.example/metadata.json"],
    ["a link-local address", "http://169.254.169.254/latest/meta-data"],
    ["a loopback address", "https://127.0.0.1:8545/"],
    ["an ipfs address with a path on it", "ipfs://bafkreimetadata/../../x"],
  ])("refuses %s before any request is made, with a plain reason", async (_name, uri) => {
    const { fetcher, calls } = counting({ name: "never read" });
    const document = await readDocument(uri, GATEWAY, fetcher);
    expect(calls).toHaveLength(0);
    expect(document.readable).toBe(false);
    expect(document.refused).toContain("not an IPFS content id");
    expect(document.refused).not.toContain("://");
  });

  it("reads a good content id through the configured gateway, with redirects refused", async () => {
    const { fetcher, calls } = counting({ name: "A lighthouse in fog" });
    const document = await readDocument("ipfs://bafkreigood", GATEWAY, fetcher);
    expect(document.readable).toBe(true);
    expect(calls.map((one) => one.url)).toEqual([`${GATEWAY}bafkreigood`]);
    expect(calls[0]?.init?.redirect).toBe("error");
  });

  it("does not follow a gateway that answers with a redirect", async () => {
    const seen: string[] = [];
    const server = http.createServer((request, response) => {
      seen.push(request.url ?? "");
      if (request.url === "/ipfs/bafkreiredirect") {
        response.writeHead(302, { location: "/ipfs/bafkreitarget" }).end();
        return;
      }
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ name: "followed" }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const port = (server.address() as AddressInfo).port;
      const document = await readDocument("ipfs://bafkreiredirect", `http://127.0.0.1:${port}/ipfs/`);
      expect(document.readable).toBe(false);
      expect(document.title).toBeNull();
      expect(seen).toEqual(["/ipfs/bafkreiredirect"]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("stops reading a body at the byte cap rather than holding all of it", async () => {
    let pulled = 0;
    const chunk = new TextEncoder().encode(`{"name":"huge","pad":"${"x".repeat(4_000)}`);
    const endless = (async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            pulled += chunk.length;
            controller.enqueue(chunk);
            if (pulled > 10_000_000) {
              controller.enqueue(new TextEncoder().encode('"}'));
              controller.close();
            }
          },
        }),
        { status: 200 },
      )) as unknown as typeof fetch;

    const document = await readDocument("ipfs://bafkreihuge", GATEWAY, endless);
    expect(document.readable).toBe(false);
    expect(document.refused).toContain("byte cap");
    expect(pulled).toBeLessThan(MAX_DOCUMENT_BYTES + 3 * chunk.length);
  });

  it("refuses a body the gateway declares too large without reading it", async () => {
    const big = JSON.stringify({ name: "declared", pad: "x".repeat(MAX_DOCUMENT_BYTES) });
    const declared = (async () =>
      new Response(big, { status: 200, headers: { "content-length": String(big.length) } })) as unknown as typeof fetch;
    const document = await readDocument("ipfs://bafkreideclared", GATEWAY, declared);
    expect(document.readable).toBe(false);
    expect(document.refused).toContain("byte cap");
  });
});

describe("the unseal record beside a sealed document", () => {
  const SERVICE = "https://verify.example";
  const PASSPORT = `0x${"9".repeat(62)}AB`;
  const SEALED_DOCUMENT = { name: "A kept picture", sealed: true };

  function service(status: number, body: unknown): { fetcher: typeof fetch; urls: string[] } {
    const urls: string[] = [];
    const fetcher = (async (url: string) => {
      urls.push(url);
      return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
    }) as unknown as typeof fetch;
    return { fetcher, urls };
  }

  it("turns a sealed document with a record into the third kind, re-checkable like a public one", async () => {
    const { fetcher, urls } = service(200, { passportId: PASSPORT.toLowerCase(), thumbnail: { uri: "ipfs://bafkreithumb" } });
    const record = await readUnsealRecord(SERVICE, PASSPORT, fetcher);
    expect(record).toEqual({ kind: "found", picture: "bafkreithumb" });
    expect(urls).toEqual([`${SERVICE}/unseal/${PASSPORT.toLowerCase()}`]);

    const document = withRecord(describeDocument(SEALED_DOCUMENT), record);
    expect(document).toEqual({ title: "A kept picture", sealed: false, unsealed: true, readable: true, privateRecheck: false, picture: "bafkreithumb" });
    expect(isRealPicture(document)).toBe(true);
  });

  it("leaves it sealed when the service answers 404", async () => {
    const record = await readUnsealRecord(SERVICE, PASSPORT, service(404, { error: "not-unsealed" }).fetcher);
    expect(record).toEqual({ kind: "none" });
    expect(withRecord(describeDocument(SEALED_DOCUMENT), record).sealed).toBe(true);
  });

  it("says failed, never sealed and never found, for a 500, a 503 or a body that is not JSON", async () => {
    for (const [status, body] of [
      [500, ""],
      [503, { error: "lookup-unavailable" }],
      [200, "<html>not json</html>"],
      [200, { thumbnail: "no passport id here" }],
    ] as const) {
      const record = await readUnsealRecord(SERVICE, PASSPORT, service(status, body).fetcher);
      expect(record.kind).toBe("failed");
      expect(record.kind === "failed" ? record.reason : "").not.toContain(SERVICE);
    }
  });

  it("says failed when the service does not answer in time", async () => {
    const slow = (async () => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    }) as unknown as typeof fetch;
    expect(await readUnsealRecord(SERVICE, PASSPORT, slow)).toEqual({
      kind: "failed",
      reason: "the unseal record lookup did not answer within 10 seconds",
    });
  });

  it("says mismatch for a record about another passport", async () => {
    const record = await readUnsealRecord(SERVICE, PASSPORT, service(200, { passportId: `0x${"1".repeat(64)}` }).fetcher);
    expect(record).toEqual({ kind: "mismatch" });
    expect(withRecord(describeDocument(SEALED_DOCUMENT), record).sealed).toBe(true);
  });

  it("never asks the service about something that is not a passport id", async () => {
    const { fetcher, urls } = service(200, {});
    expect((await readUnsealRecord(SERVICE, "../recheck/queue", fetcher)).kind).toBe("failed");
    expect(urls).toHaveLength(0);
  });
});

describe("reading the picture before a run (tally R12)", () => {
  /** The first bytes of a baseline JPEG: the start marker, then a frame header naming the size. */
  function frameHeader(width: number, height: number): Uint8Array {
    return new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03]);
  }

  function serving(status: number, body: Uint8Array | string): { fetcher: typeof fetch; calls: { url: string; init: RequestInit | undefined }[] } {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const fetcher = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return new Response(body, { status });
    }) as unknown as typeof fetch;
    return { fetcher, calls };
  }

  it("reads the size off the frame header, through the configured gateway with redirects refused", async () => {
    const { fetcher, calls } = serving(200, frameHeader(512, 29));
    expect(await readPicture("bafkreithumb", GATEWAY, fetcher)).toEqual({ kind: "ok", width: 512, height: 29 });
    expect(calls.map((one) => one.url)).toEqual([`${GATEWAY}bafkreithumb`]);
    expect(calls[0]?.init?.redirect).toBe("error");
  });

  it("refuses for good only what the workflow would refuse: over the cap, or not a JPEG", async () => {
    const big = new Uint8Array(MAX_PICTURE_BYTES + 1);
    big.set(frameHeader(512, 384));
    expect((await readPicture("bafkreibig", GATEWAY, serving(200, big).fetcher)).kind).toBe("refused");
    expect(await readPicture("bafkreipng", GATEWAY, serving(200, "\x89PNG not a jpeg").fetcher)).toMatchObject({
      kind: "refused",
      reason: expect.stringContaining("not a JPEG"),
    });
    expect((await readPicture("bafkrei/../x", GATEWAY, serving(200, frameHeader(64, 64)).fetcher)).kind).toBe("refused");
  });

  it("calls a gateway that did not hand the picture over a miss, never a refusal", async () => {
    for (const status of [404, 429, 502]) {
      expect((await readPicture("bafkreithumb", GATEWAY, serving(status, "").fetcher)).kind).toBe("missed");
    }
    const down = (async () => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    }) as unknown as typeof fetch;
    expect((await readPicture("bafkreithumb", GATEWAY, down)).kind).toBe("missed");
  });

  it("leaves a JPEG whose size it cannot find to the workflow rather than guessing", async () => {
    expect(await readPicture("bafkreiodd", GATEWAY, serving(200, new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0x00, 0x02])).fetcher)).toEqual({
      kind: "unsized",
    });
  });
});
