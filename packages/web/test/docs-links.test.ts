import { describe, expect, it } from "vitest";
import { resolveDocsFile } from "@/lib/docs/files";
import { pageHref, resolveLink, segmentsFromSlug, slugFromSegments } from "@/lib/docs/links";

describe("where a link in a page goes", () => {
  it("follows a sibling page", () => {
    expect(resolveLink("guides/disputes", "verify-a-copy")).toEqual({
      kind: "page",
      href: "/docs/guides/verify-a-copy",
      slug: "guides/verify-a-copy",
      hash: "",
    });
  });

  it("follows a sibling written with its extension, the way it reads on GitHub", () => {
    expect(resolveLink("concepts/how-it-works", "trust-model.md").href).toBe("/docs/concepts/trust-model");
  });

  it("climbs to another folder", () => {
    expect(resolveLink("developers/architecture", "../api/registry").href).toBe("/docs/api/registry");
  });

  it("keeps an anchor on the page it was written on", () => {
    expect(resolveLink("faq", "#who-pays-the-gas")).toEqual({ kind: "anchor", href: "#who-pays-the-gas" });
  });

  it("carries an anchor across to another page", () => {
    const link = resolveLink("security/overview", "threat-model#what-moolam-promises");
    expect(link.href).toBe("/docs/security/threat-model#what-moolam-promises");
  });

  it("sends a transcript to the files route", () => {
    expect(resolveLink("security/threat-model", "attacks/passkey-replay.txt")).toEqual({
      kind: "file",
      href: "/docs-files/docs/security/attacks/passkey-replay.txt",
      file: "docs/security/attacks/passkey-replay.txt",
    });
  });

  it("sends a proof run outside the docs folder to the same route", () => {
    expect(resolveLink("developers/prove-it", "../../proofs/gas.txt").href).toBe("/docs-files/proofs/gas.txt");
  });

  it("leaves a link with a scheme on it alone", () => {
    expect(resolveLink("intro", "https://www.monad.xyz")).toEqual({
      kind: "external",
      href: "https://www.monad.xyz",
    });
  });

  it("puts the first page at the root of the docs and carries no language", () => {
    expect(pageHref("intro")).toBe("/docs");
    expect(pageHref("api/events")).toBe("/docs/api/events");
    expect(slugFromSegments(undefined)).toBe("intro");
    expect(slugFromSegments(["api", "events"])).toBe("api/events");
    expect(segmentsFromSlug("intro")).toEqual([]);
    expect(segmentsFromSlug("api/events")).toEqual(["api", "events"]);
  });
});

describe("what the files route will serve", () => {
  it("serves a transcript that is really there", () => {
    expect(resolveDocsFile(["docs", "security", "attacks", "passkey-replay.txt"])).not.toBeNull();
    expect(resolveDocsFile(["proofs", "gas.txt"])).not.toBeNull();
  });

  it("refuses a path with a climb in it", () => {
    expect(resolveDocsFile(["docs", "..", "package.json"])).toBeNull();
    expect(resolveDocsFile(["..", "package.json"])).toBeNull();
    expect(resolveDocsFile(["docs", "security", "..", "..", ".env"])).toBeNull();
    expect(resolveDocsFile(["docs", "security/../../.env"])).toBeNull();
  });

  it("refuses anything outside the two folders the docs link into", () => {
    expect(resolveDocsFile(["packages", "web", "package.json"])).toBeNull();
    expect(resolveDocsFile([".env"])).toBeNull();
  });

  it("refuses a page, a dotfile and a file that is not there", () => {
    expect(resolveDocsFile(["docs", "intro.md"])).toBeNull();
    expect(resolveDocsFile(["docs", ".gitignore"])).toBeNull();
    expect(resolveDocsFile(["proofs", "nothing-here.txt"])).toBeNull();
  });
});
