// Holds the one look-alike rule in one place (L10, L11): the verify service's lookalike-rule.ts and
// the Chainlink workflow's copy are the same bytes, the service's match thresholds are the rule's
// two constants rather than numbers of their own, and the order is strict on registeredAt.
// Does NOT cover how either side uses the rule: the candidates route, the backlog and the prepare
// warning are test/lookalike-routes.test.ts, and the workflow's own use is its own suite.

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PACKAGE_ROOT } from "../src/env.js";
import { BLOCKHASH_MATCH_THRESHOLD, PHASH_MATCH_THRESHOLD } from "../src/fingerprint.js";
import { LOOKALIKE_BLOCKHASH_BITS, LOOKALIKE_PHASH_BITS, registeredBefore } from "../src/lookalike-rule.js";
import { MATCH_LIMITS } from "../src/match.js";

const SERVICE_COPY = path.join(PACKAGE_ROOT, "src", "lookalike-rule.ts");
const WORKFLOW_COPY = path.join(PACKAGE_ROOT, "..", "workflow", "moolam-verifier", "lookalike-rule.ts");

describe("L10 and L11: one look-alike rule for the service and the workflow", () => {
  it("keeps the two lookalike-rule.ts files byte for byte the same", () => {
    const service = readFileSync(SERVICE_COPY);
    const workflow = readFileSync(WORKFLOW_COPY);

    expect(service.length).toBeGreaterThan(0);
    expect(service.equals(workflow)).toBe(true);
  });

  it("takes fingerprint.ts's thresholds, and so every match the service makes, from the shared constants", () => {
    expect(LOOKALIKE_PHASH_BITS).toBe(10);
    expect(LOOKALIKE_BLOCKHASH_BITS).toBe(40);
    expect(PHASH_MATCH_THRESHOLD).toBe(LOOKALIKE_PHASH_BITS);
    expect(BLOCKHASH_MATCH_THRESHOLD).toBe(LOOKALIKE_BLOCKHASH_BITS);
    expect(MATCH_LIMITS).toEqual({ phashMax: LOOKALIKE_PHASH_BITS, blockhashMax: LOOKALIKE_BLOCKHASH_BITS });

    const source = readFileSync(path.join(PACKAGE_ROOT, "src", "fingerprint.ts"), "utf8");
    expect(source).toContain("PHASH_MATCH_THRESHOLD = LOOKALIKE_PHASH_BITS;");
    expect(source).toContain("BLOCKHASH_MATCH_THRESHOLD = LOOKALIKE_BLOCKHASH_BITS;");
  });

  it("never calls one of two passports in the same second earlier than the other", () => {
    const first = { registeredAt: 1_790_000_000n };
    const sameSecond = { registeredAt: 1_790_000_000n };
    const nextSecond = { registeredAt: 1_790_000_001n };

    expect(registeredBefore(first, sameSecond)).toBe(false);
    expect(registeredBefore(sameSecond, first)).toBe(false);
    expect(registeredBefore(first, nextSecond)).toBe(true);
    expect(registeredBefore(nextSecond, first)).toBe(false);
  });
});
