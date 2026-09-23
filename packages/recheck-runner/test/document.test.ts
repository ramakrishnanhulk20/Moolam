import { describe, expect, it } from "vitest";
import {
  describe as describeDocument,
  isRealPicture,
  isTestCard,
  readDocument,
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
    expect(document).toEqual({ title: "A lighthouse in fog", sealed: false, unsealed: false, readable: true, privateRecheck: false });
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
    expect(document).toEqual({ title: null, sealed: false, unsealed: false, readable: false, privateRecheck: false });
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
    expect(record).toEqual({ kind: "found" });
    expect(urls).toEqual([`${SERVICE}/unseal/${PASSPORT.toLowerCase()}`]);

    const document = withRecord(describeDocument(SEALED_DOCUMENT), record);
    expect(document).toEqual({ title: "A kept picture", sealed: false, unsealed: true, readable: true, privateRecheck: false });
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
