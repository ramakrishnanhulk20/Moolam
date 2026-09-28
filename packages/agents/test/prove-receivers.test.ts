// Covers the parts of the receiver attack rerun that need no network: reading the command line,
// turning the registry's record into the passport the attacks use, the cost check before a live
// send, and the transcript header. Does NOT cover the attacks themselves or the guard that keeps
// the dry run from sending: those run against Monad mainnet with
// `npm run prove:receivers -- --passport <id>`.

import { describe, expect, it } from "vitest";
import type { Hex } from "viem";
import type { Passport } from "../src/chain/registry.js";
import {
  attackFileText,
  choosePassport,
  enoughFor,
  liveCost,
  originalFor,
  parseArgs,
} from "../scripts/prove-receivers.js";

const ID = `0x${"3d".repeat(32)}` as Hex;
const REGISTRY = "0xa19188801E5DC93CD925884d73e4DaFc2bcb80C0" as Hex;

function record(changes: Partial<Passport> = {}): Passport {
  return {
    exactHash: ID,
    parentId: `0x${"00".repeat(32)}` as Hex,
    creator: "0xC5ead1E4E5C6d56E87e02317f3fB3731cB0b6Ef7",
    generatorAgentId: 7n,
    phash: 123n,
    blockhash256: `0x${"ab".repeat(32)}` as Hex,
    manifestHash: `0x${"cd".repeat(32)}` as Hex,
    kind: 0,
    fingerprintVersion: 1,
    registeredAt: 1_790_000_000n,
    disputed: false,
    metadataURI: "ipfs://meta",
    ...changes,
  };
}

describe("parseArgs", () => {
  it("reads the passport, lowercased, and stays a dry run without --live", () => {
    expect(parseArgs(["--passport", ID.toUpperCase().replace("0X", "0x")])).toEqual({
      passport: ID,
      live: false,
    });
    expect(parseArgs(["--live", "--passport", ID])).toEqual({ passport: ID, live: true });
  });

  it("refuses a missing, malformed or repeated passport and any unknown option", () => {
    expect(() => parseArgs([])).toThrow(/Say which passport/);
    expect(() => parseArgs(["--passport"])).toThrow(/64 hex digits/);
    expect(() => parseArgs(["--passport", ID.slice(2)])).toThrow(/64 hex digits/);
    expect(() => parseArgs(["--passport", REGISTRY])).toThrow(/64 hex digits/);
    expect(() => parseArgs(["--passport", ID, "--passport", ID])).toThrow(/once/);
    expect(() => parseArgs(["--passport", ID, "--send"])).toThrow(/--send/);
  });

  it("answers help without a passport", () => {
    expect(parseArgs(["--help"])).toBeUndefined();
  });
});

describe("choosePassport", () => {
  it("builds the attack input from the chain record", () => {
    const chosen = choosePassport(ID, record());
    expect(chosen.passportId).toBe(ID);
    expect(chosen.input.blockhash256).toBe(record().blockhash256);
    expect(chosen.input.creator).toBe(record().creator);
  });

  it("stops with a plain sentence when the passport is not registered", () => {
    expect(() => choosePassport(ID, undefined)).toThrow(/is not registered/);
    expect(() => choosePassport(ID, record({ registeredAt: 0n }))).toThrow(/is not registered/);
  });

  it("stops when the registry answered for a different passport", () => {
    expect(() => choosePassport(ID, record({ exactHash: `0x${"11".repeat(32)}` }))).toThrow(
      /wrong record/,
    );
  });
});

describe("originalFor", () => {
  it("hands over the id and record and refuses every other field", () => {
    const original = originalFor(choosePassport(ID, record()));
    expect(original.passportId).toBe(ID);
    expect(original.input.exactHash).toBe(ID);
    expect(() => original.signed).toThrow(/original\.signed/);
  });
});

describe("the cost check before a live send", () => {
  it("prices every send at its full gas limit and wants twice that in the wallet", () => {
    const cost = liveCost([150_000n, 150_000n], 102_000_000_000n);
    expect(cost).toBe(30_600_000_000_000_000n);
    expect(enoughFor(2n * cost, cost)).toBe(true);
    expect(enoughFor(2n * cost - 1n, cost)).toBe(false);
  });
});

describe("attackFileText", () => {
  it("writes prove.ts's header with this command's name", () => {
    const text = attackFileText(
      { name: "attest-from-stranger", refused: true, evidence: "NotReceiver: first line\nmore" },
      { startedAt: new Date("2026-09-28T10:00:00.000Z"), chainId: 143, registry: REGISTRY },
    );
    expect(text).toBe(
      [
        "Moolam attack: attest-from-stranger",
        "REFUSED",
        "",
        "run         2026-09-28T10:00:00.000Z",
        "command     npm run prove:receivers",
        "network     Monad mainnet, chain 143",
        `registry    ${REGISTRY}`,
        "",
        "NotReceiver: first line",
        "more",
        "",
      ].join("\n"),
    );
  });
});
