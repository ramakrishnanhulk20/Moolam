// Holds the one trust mark in one place (L30): the site's components/mark/mark.ts and the MCP
// server's src/mcp/mark.ts are the same bytes, as lookalike-rule.ts is held for the workflow, so a
// passport page and an agent asking the MCP server can never be handed two different marks.
// Does NOT cover how either side gathers the facts it hands in: the site's reads are its own suite
// (packages/web/test/marks.test.ts).

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PACKAGE_ROOT } from "../src/env.js";
import { LOOKALIKE_PHASH_BITS } from "../src/lookalike-rule.js";
import { issueMark, MARK_STATES } from "../src/mcp/mark.js";

const SERVER_COPY = path.join(PACKAGE_ROOT, "src", "mcp", "mark.ts");
const SITE_COPY = path.join(PACKAGE_ROOT, "..", "web", "components", "mark", "mark.ts");

describe("L30: one function issues the mark for the site and the MCP server", () => {
  it("keeps the two mark.ts files byte for byte the same", () => {
    const server = readFileSync(SERVER_COPY);
    const site = readFileSync(SITE_COPY);

    expect(server.length).toBeGreaterThan(0);
    expect(server.equals(site)).toBe(true);
  });

  it("issues the eight marks worst first, and a simulator verdict lights none of them", () => {
    expect(MARK_STATES).toEqual(["upheld", "mismatch", "lookalike", "challenged", "waiting", "checked", "sealed", "nothing"]);

    const simulator = issueMark({
      dispute: "none",
      verdicts: [{ network: false, matched: true, phashBits: 0, at: 1_790_000_000 }],
      lookalike: { read: true, record: null },
      picture: "public",
      phashLimit: LOOKALIKE_PHASH_BITS,
    });
    expect(simulator.state).toBe("waiting");
  });
});
