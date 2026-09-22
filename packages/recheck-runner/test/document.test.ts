import { describe, expect, it } from "vitest";
import { describe as describeDocument, isRealPicture, isTestCard, readDocument } from "../src/document.js";

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
    expect(document).toEqual({ title: "A lighthouse in fog", sealed: false, readable: true });
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
    expect(document).toEqual({ title: null, sealed: false, readable: false });
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

  it("does not take a picture reference that is a sentence rather than an address", () => {
    expect(describeDocument({ name: "Odd record", sealed: true, image: "the picture was lost" }).sealed).toBe(true);
  });
});
