import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { attestationCount, attestationLanded } from "../src/chain.js";
import { readConfig, type Config } from "../src/config.js";
import type { Document, PictureRead, RecordLookup } from "../src/document.js";
import type { PassportRow } from "../src/index-read.js";
import { HttpError } from "../src/net.js";
import type { Claim, DoneReport, Placed, QueueClient } from "../src/queue.js";
import type { CopyState } from "../src/sealed.js";
import { runSimulation, type SimulateRequest, type SimulateResult } from "../src/simulate.js";
import { emptyState, loadState, noteRecent, saveState, type RunnerState } from "../src/state.js";
import { LANDED_LOOKUP_GAP_MS, LANDED_LOOKUP_TRIES, isPassingFailure, onePass, openingState, type Deps } from "../src/runner.js";

const NOW = Date.parse("2026-09-22T12:00:00Z");

/** The chain head every stand-in pass reads before a broadcast run. */
const HEAD = 108_499_200;

const ENV = {
  VERIFY_SERVICE_URL: "https://verify.example",
  RUNNER_TOKEN: "a-token",
  ENVIO_GRAPHQL_URL: "https://index.example/v1/graphql",
  MONAD_RPC_URL: "https://rpc.monad.xyz",
  CRE_WORKFLOW_DIR: "/srv/moolam/packages/workflow/moolam-verifier",
  CRE_ENV_FILE: "/etc/moolam/runner.env",
  CRE_WALLET_ADDRESS: "0xC79620AF233a4434b03f6B57239F8A9E71B3C178",
} satisfies NodeJS.ProcessEnv;

function id(letter: string): string {
  return `0x${letter.repeat(64)}`;
}

const PICTURE = id("a");
const SEALED = id("b");
const SEED = id("c");
const ASKED = id("d");
const PRIVATE = id("e");

function row(passportId: string, extra: Partial<PassportRow> = {}): PassportRow {
  return {
    id: passportId,
    metadataURI: `ipfs://document-${passportId.slice(2, 4)}`,
    registeredAt: 1_789_629_000,
    txHash: `0x${passportId.slice(2, 10)}${"e".repeat(56)}`,
    attestationCount: 0,
    ...extra,
  };
}

const NO_PICTURE = id("7");

const DOCUMENTS: Record<string, Document> = {
  [`ipfs://document-${PICTURE.slice(2, 4)}`]: { title: "A lighthouse in fog", sealed: false, unsealed: false, readable: true, privateRecheck: false, picture: "bafkreilighthouse" },
  [`ipfs://document-${SEALED.slice(2, 4)}`]: { title: "A kept picture", sealed: true, unsealed: false, readable: true, privateRecheck: false, picture: null },
  [`ipfs://document-${SEED.slice(2, 4)}`]: { title: "Moolam seed 4", sealed: false, unsealed: false, readable: true, privateRecheck: false, picture: "bafkreiseed" },
  [`ipfs://document-${ASKED.slice(2, 4)}`]: { title: "Harbour at dusk", sealed: false, unsealed: false, readable: true, privateRecheck: false, picture: "bafkreiharbour" },
  [`ipfs://document-${PRIVATE.slice(2, 4)}`]: { title: "Old but strong", sealed: true, unsealed: false, readable: true, privateRecheck: true, picture: null },
  [`ipfs://document-${NO_PICTURE.slice(2, 4)}`]: {
    title: "Harbour",
    sealed: false,
    unsealed: false,
    readable: true,
    privateRecheck: false,
    picture: null,
    refused: "passport metadata has no thumbnail or image to check",
  },
};

const UNREADABLE: Document = { title: null, sealed: false, unsealed: false, readable: false, privateRecheck: false, picture: null };

/** What the unseal record of a published sealed passport names as its thumbnail. */
const FOUND: RecordLookup = { kind: "found", picture: "bafkreipublished" };

interface StandIns {
  deps: Deps;
  lines: string[];
  runs: SimulateRequest[];
  claims: string[];
  reports: DoneReport[];
  lookups: string[];
  /** Every queue, status and simulator call in the order it was made. */
  calls: string[];
  state: () => RunnerState;
}

const SEALED_TOKEN = "sealed-link-token-4f1b9c0e77d2a6";

/** One pass's dependencies, each a stand-in that records what the runner asked of it. */
function standIns(input: {
  env?: NodeJS.ProcessEnv;
  pending?: string[];
  sweep?: PassportRow[];
  rows?: PassportRow[];
  claim?: (passportId: string) => Claim;
  balance?: bigint;
  simulate?: (request: SimulateRequest) => SimulateResult;
  state?: RunnerState;
  queueFails?: boolean;
  record?: (passportId: string) => RecordLookup;
  copy?: CopyState;
  placed?: Placed;
  token?: string | null;
  landed?: boolean;
  picture?: (cid: string) => PictureRead;
  /** The chain's answer to "did this passport's verdict land since the head", when the CLI printed no hash. */
  found?: (passportId: string, head: number) => string | null;
}): StandIns {
  const config: Config = readConfig({ ...ENV, ...input.env });
  const lines: string[] = [];
  const runs: SimulateRequest[] = [];
  const claims: string[] = [];
  const reports: DoneReport[] = [];
  const lookups: string[] = [];
  const calls: string[] = [];
  const known = new Map<string, PassportRow>();
  for (const one of [...(input.sweep ?? []), ...(input.rows ?? [])]) {
    known.set(one.id, one);
  }
  let state = input.state ?? emptyState("2026-09-22");

  const queue: QueueClient = {
    pending: async () => {
      if (input.queueFails === true) {
        throw new Error("the re-check queue answered 500");
      }
      return input.pending ?? [];
    },
    request: async (passportId) => {
      calls.push(`request ${passportId}`);
      return input.placed ?? "placed";
    },
    claim: async (passportId) => {
      calls.push(`claim ${passportId}`);
      claims.push(passportId);
      return input.claim === undefined ? "claimed" : input.claim(passportId);
    },
    done: async (report) => {
      calls.push(`done ${report.passportId}`);
      reports.push(report);
    },
  };

  const deps: Deps = {
    config,
    queue,
    index: {
      // As the index answers: newest first, the excluded ids left out, then cut to the limit.
      unrechecked: async (_before, limit, excluding = []) =>
        (input.sweep ?? []).filter((one) => !excluding.includes(one.id)).slice(0, limit),
      byId: async (passportId) => known.get(passportId) ?? null,
    },
    readDocument: async (metadataURI) => DOCUMENTS[metadataURI] ?? UNREADABLE,
    readPicture: async (cid) => input.picture?.(cid) ?? { kind: "ok", width: 512, height: 384 },
    unsealRecord: async (passportId) => {
      lookups.push(passportId);
      return input.record?.(passportId) ?? { kind: "none" };
    },
    sealedStatus: async (passportId) => {
      calls.push(`status ${passportId}`);
      return input.copy ?? "kept";
    },
    sealedToken: () => (input.token === undefined ? SEALED_TOKEN : input.token),
    eventIndex: async (txHash) => (txHash.startsWith("0xdddd") ? 1 : 0),
    reportLanded: async () => input.landed ?? true,
    chainHead: async () => HEAD,
    findReport: async (passportId, head) => input.found?.(passportId, head) ?? null,
    sleep: async () => {},
    attestationCount: async () => 0n,
    balanceWei: async () => input.balance ?? 28_266_000_000_000_000_000n,
    simulate: async (request) => {
      calls.push(`simulate ${path.basename(request.workflowDir)}`);
      runs.push(request);
      return (
        input.simulate?.(request) ?? {
          ok: true,
          reportTx: `0x${"f".repeat(64)}`,
          recomputed: "0x63779c989c7f3121",
          distance: 0,
          matched: true,
          printed: "cre workflow simulate ...",
        }
      );
    },
    readState: () => state,
    writeState: (next) => {
      state = next;
    },
    log: (line) => lines.push(line),
    now: () => NOW,
  };

  return { deps, lines, runs, claims, reports, lookups, calls, state: () => state };
}

describe("one pass of the runner", () => {
  it("runs a request before the sweep", async () => {
    const kit = standIns({
      pending: [ASKED],
      rows: [row(ASKED)],
      sweep: [row(PICTURE)],
    });
    const summary = await onePass(kit.deps);

    expect(summary.ran).toBe(2);
    expect(kit.runs[0]?.txHash).toBe(row(ASKED).txHash);
    expect(kit.runs[1]?.txHash).toBe(row(PICTURE).txHash);
  });

  it("claims a requested passport before it runs anything", async () => {
    const kit = standIns({ pending: [ASKED], rows: [row(ASKED)] });
    await onePass(kit.deps);
    expect(kit.claims).toEqual([ASKED]);
    expect(kit.runs).toHaveLength(1);
  });

  it("leaves a request on the queue when the claim is refused, and runs nothing", async () => {
    const kit = standIns({ pending: [ASKED], rows: [row(ASKED)], claim: () => "taken" });
    await onePass(kit.deps);
    expect(kit.runs).toHaveLength(0);
    expect(kit.lines.join(" ")).toContain("could not be claimed");
  });

  it("skips a sealed passport and tells the person who asked why", async () => {
    const kit = standIns({ pending: [SEALED], rows: [row(SEALED)] });
    await onePass(kit.deps);
    expect(kit.runs).toHaveLength(0);
    expect(kit.reports[0]?.reason).toContain("sealed");
  });

  it("sweeps past a seed test card without spending a report on it", async () => {
    const kit = standIns({ sweep: [row(SEED), row(PICTURE)] });
    const summary = await onePass(kit.deps);
    expect(summary.ran).toBe(1);
    expect(kit.runs[0]?.txHash).toBe(row(PICTURE).txHash);
    expect(kit.lines.join(" ")).toContain("seed test card");
  });

  it("runs a seed card anyway when somebody asked for it by hand", async () => {
    const kit = standIns({ pending: [SEED], rows: [row(SEED)] });
    await onePass(kit.deps);
    expect(kit.runs).toHaveLength(1);
  });

  it("uses the event index the receipt gave rather than always zero", async () => {
    const kit = standIns({ sweep: [row(ASKED)] });
    await onePass(kit.deps);
    expect(kit.runs[0]?.eventIndex).toBe(1);
  });

  it("reports the transaction back to the queue when a run wrote one", async () => {
    const kit = standIns({ pending: [ASKED], rows: [row(ASKED)] });
    await onePass(kit.deps);
    expect(kit.reports[0]).toEqual({
      passportId: ASKED,
      reportTx: `0x${"f".repeat(64)}`,
      matched: true,
      distance: 0,
    });
  });

  it("reports a failure with the reason, and counts it", async () => {
    const kit = standIns({
      pending: [ASKED],
      rows: [row(ASKED)],
      simulate: () => ({ ok: false, reason: "the gateway answered 504", printed: "cre ..." }),
    });
    const summary = await onePass(kit.deps);
    expect(summary.failed).toBe(1);
    expect(kit.reports[0]).toEqual({ passportId: ASKED, reason: "the gateway answered 504" });
    expect(kit.state().failures).toBe(1);
  });

  it("leaves a passport that already carries a re-check alone", async () => {
    const kit = standIns({ pending: [ASKED], rows: [row(ASKED, { attestationCount: 1 })] });
    await onePass(kit.deps);
    expect(kit.runs).toHaveLength(0);
    expect(kit.reports[0]?.reason).toContain("already carries 1");
  });

  it("waits for an index that has not seen the passport somebody asked about, then says so", async () => {
    const kit = standIns({ pending: [id("9")] });
    for (const minutes of [0, 11, 32]) {
      kit.deps.now = () => NOW + minutes * 60_000;
      await onePass(kit.deps);
    }
    expect(kit.claims).toEqual([]);
    kit.deps.now = () => NOW + 33 * 60_000;
    await onePass(kit.deps);
    expect(kit.runs).toHaveLength(0);
    expect(kit.reports).toHaveLength(1);
    expect(kit.reports[0]?.reason).toContain("not in the index");
  });

  it("carries on with the next passport when one of them throws", async () => {
    const kit = standIns({ sweep: [row(PICTURE), row(ASKED)] });
    let first = true;
    kit.deps.readDocument = async (metadataURI) => {
      if (first) {
        first = false;
        throw new Error("the gateway closed the connection");
      }
      return DOCUMENTS[metadataURI] ?? UNREADABLE;
    };

    const summary = await onePass(kit.deps);
    expect(kit.runs).toHaveLength(1);
    expect(summary.ran).toBe(1);
    expect(kit.lines.join(" ")).toContain("could not be handled");
  });

  it("does not silence a passport that threw, and backs off after three of them", async () => {
    const kit = standIns({
      sweep: [row(PICTURE), row(ASKED), row(SEED)],
      state: { ...emptyState("2026-09-22"), failures: 2 },
    });
    kit.deps.readDocument = async () => {
      throw new Error("the gateway closed the connection");
    };

    const summary = await onePass(kit.deps);
    expect(summary.stopped).toContain("backing off for 30 minutes");
    expect(kit.state().recent[PICTURE]).toBeUndefined();
  });

  it.each([["a flag", "--broadcast"], ["a short hash", "0x40ae6d62"], ["a hash with a flag after it", `0x${"e".repeat(64)} --broadcast`]])(
    "refuses a registration transaction from the index that is %s, before any spend (R8)",
    async (_name, txHash) => {
      const kit = standIns({ pending: [ASKED], rows: [row(ASKED, { txHash })] });
      let asked = false;
      kit.deps.eventIndex = async () => {
        asked = true;
        return 0;
      };
      await onePass(kit.deps);

      expect(asked).toBe(false);
      expect(kit.runs).toHaveLength(0);
      expect(kit.state().reports).toBe(0);
      expect(kit.reports[0]?.reason).toContain("not 0x and 64 hex digits");
      expect(kit.reports[0]?.reason).not.toContain("--broadcast");
    },
  );

  it("carries on with the sweep when the queue itself is unreachable", async () => {
    const kit = standIns({ queueFails: true, sweep: [row(PICTURE)] });
    const summary = await onePass(kit.deps);
    expect(summary.ran).toBe(1);
    expect(kit.lines.join(" ")).toContain("could not read the request queue");
  });

  // redact already stripped every whole address from a pass's log lines before V66, so this passes
  // on the old code too. It holds the line clean with safeReason and redact in place together.
  it("logs a failed read with no endpoint path in it (V66)", async () => {
    const kit = standIns({ sweep: [row(PICTURE)] });
    const echoed = new HttpError("the re-check queue", 404, "no route for https://verify.example/TOKEN123/recheck");
    const deps: Deps = {
      ...kit.deps,
      queue: {
        ...kit.deps.queue,
        pending: async () => {
          throw echoed;
        },
      },
    };
    await onePass(deps);
    const logged = kit.lines.join(" ");
    expect(logged).toContain("could not read the request queue: the re-check queue answered 404: no route for");
    expect(logged).not.toContain("TOKEN123");
  });
});

describe("a passport registered sealed and published since", () => {
  it("is re-checked with the same command as a public one once its unseal record exists", async () => {
    const kit = standIns({ pending: [SEALED], rows: [row(SEALED)], record: () => FOUND });
    const summary = await onePass(kit.deps);

    expect(kit.lookups).toEqual([SEALED]);
    expect(summary.done).toBe(1);
    expect(kit.runs[0]).toMatchObject({ txHash: row(SEALED).txHash, eventIndex: 0, broadcast: true });
    expect(kit.lines.join(" ")).toContain("published the picture since");
  });

  it("is picked up by the sweep too", async () => {
    const kit = standIns({ sweep: [row(SEALED)], record: () => FOUND });
    const summary = await onePass(kit.deps);
    expect(summary.ran).toBe(1);
  });

  it("is refused as sealed when the service has no record for it", async () => {
    const kit = standIns({ pending: [SEALED], rows: [row(SEALED)], record: () => ({ kind: "none" }) });
    await onePass(kit.deps);
    expect(kit.runs).toHaveLength(0);
    expect(kit.reports[0]?.reason).toContain("is sealed, so there is no published picture");
    expect(kit.state().held[SEALED]).toBeDefined();
    expect(kit.state().closed[SEALED]).toBeUndefined();
  });

  it("is refused when the record served for it names another passport", async () => {
    const kit = standIns({ pending: [SEALED], rows: [row(SEALED)], record: () => ({ kind: "mismatch" }) });
    await onePass(kit.deps);
    expect(kit.runs).toHaveLength(0);
    expect(kit.reports[0]?.reason).toContain("names another passport");
  });

  it("is tried again later, spending nothing, when the lookup timed out or answered 500", async () => {
    for (const reason of ["the unseal record lookup did not answer within 10 seconds", "the unseal record lookup answered status 500"]) {
      const kit = standIns({ pending: [SEALED], rows: [row(SEALED)], sweep: [row(SEALED)], record: () => ({ kind: "failed", reason }) });
      const summary = await onePass(kit.deps);

      expect(kit.runs).toHaveLength(0);
      expect(summary.ran).toBe(0);
      expect(kit.reports).toHaveLength(0);
      expect(kit.state().reports).toBe(0);
      expect(kit.state().failures).toBe(0);
      expect(kit.state().recent[SEALED]).toBeUndefined();
      expect(kit.lines.join(" ")).toContain("trying again in 10 minutes");
      expect(kit.lines.join(" ")).not.toContain("is sealed, so there is no published picture");
    }
  });

  it("never asks for a record when the document is public", async () => {
    const kit = standIns({ sweep: [row(PICTURE)] });
    await onePass(kit.deps);
    expect(kit.lookups).toHaveLength(0);
  });
});

describe("the guards", () => {
  it("stops before the first run when the day's cap is used up", async () => {
    const kit = standIns({
      sweep: [row(PICTURE)],
      state: { ...emptyState("2026-09-22"), reports: 40 },
    });
    const summary = await onePass(kit.deps);
    expect(kit.runs).toHaveLength(0);
    expect(summary.stopped).toContain("daily cap");
  });

  it("counts a broadcast run against the cap before it happens", async () => {
    const kit = standIns({ sweep: [row(PICTURE)] });
    await onePass(kit.deps);
    expect(kit.state().reports).toBe(1);
  });

  it("stops halfway through a pass when the cap runs out mid-way", async () => {
    const kit = standIns({
      env: { RUNNER_MAX_REPORTS_PER_DAY: "1" },
      sweep: [row(PICTURE), row(ASKED)],
    });
    const summary = await onePass(kit.deps);
    expect(kit.runs).toHaveLength(1);
    expect(summary.stopped).toContain("daily cap");
  });

  it("stops when the CRE wallet is under the floor, and does not mark the passport handled", async () => {
    const kit = standIns({ sweep: [row(PICTURE)], balance: 1_400_000_000_000_000_000n });
    const summary = await onePass(kit.deps);
    expect(kit.runs).toHaveLength(0);
    expect(summary.stopped).toContain("under the floor");
    expect(kit.state().recent[PICTURE]).toBeUndefined();
  });

  it("backs off after three failures in a row", async () => {
    const kit = standIns({
      sweep: [row(PICTURE), row(ASKED), row(SEED)],
      state: { ...emptyState("2026-09-22"), failures: 2 },
      simulate: () => ({ ok: false, reason: "the CLI exited 1", printed: "cre ..." }),
    });
    const summary = await onePass(kit.deps);
    expect(summary.stopped).toContain("backing off for 30 minutes");
    expect(kit.state().backoffUntil).toBe(Math.floor(NOW / 1000) + 1800);
    expect(kit.runs).toHaveLength(1);
  });

  it("does nothing at all while the backoff is still on", async () => {
    const kit = standIns({
      sweep: [row(PICTURE)],
      state: { ...emptyState("2026-09-22"), failures: 3, backoffUntil: Math.floor(NOW / 1000) + 600 },
    });
    const summary = await onePass(kit.deps);
    expect(kit.runs).toHaveLength(0);
    expect(summary.stopped).toContain("backing off");
  });

  it("clears the failure count as soon as a run succeeds", async () => {
    const kit = standIns({ sweep: [row(PICTURE)], state: { ...emptyState("2026-09-22"), failures: 2 } });
    await onePass(kit.deps);
    expect(kit.state().failures).toBe(0);
  });

  it("leaves a passport it has just handled alone for the cooldown", async () => {
    const kit = standIns({
      sweep: [row(PICTURE)],
      state: noteRecent(emptyState("2026-09-22"), PICTURE, NOW - 60_000),
    });
    const summary = await onePass(kit.deps);
    expect(summary.considered).toBe(0);
    expect(kit.runs).toHaveLength(0);
  });

  it("carries the ten minute timeout into every run", async () => {
    const kit = standIns({ sweep: [row(PICTURE)] });
    await onePass(kit.deps);
    expect(kit.runs[0]?.timeoutMs).toBe(600_000);
  });

  it("writes the spend down before the simulator starts, for a queued request and a new passport alike (R9)", async () => {
    const kit = standIns({ pending: [ASKED], rows: [row(ASKED)], sweep: [row(PICTURE)] });
    const countedAtStart: number[] = [];
    const simulate = kit.deps.simulate;
    kit.deps.simulate = async (request) => {
      countedAtStart.push(kit.state().reports);
      return simulate(request);
    };
    await onePass(kit.deps);
    expect(countedAtStart).toEqual([1, 2]);
  });

  it("holds one daily cap across queued requests and new passports together (R9)", async () => {
    const kit = standIns({
      pending: [ASKED],
      rows: [row(ASKED)],
      sweep: [row(PICTURE)],
      state: { ...emptyState("2026-09-22"), reports: 39 },
    });
    const summary = await onePass(kit.deps);
    expect(kit.runs).toHaveLength(1);
    expect(kit.runs[0]?.txHash).toBe(row(ASKED).txHash);
    expect(kit.state().reports).toBe(40);
    expect(summary.stopped).toContain("daily cap");
  });

  it("holds the per-pass cap on queued requests too, claiming no more than it will run (R9)", async () => {
    const asked = ["1", "2", "3", "4", "5", "6", "7"].map((letter) => id(letter));
    const kit = standIns({
      pending: asked,
      rows: asked.map((one) => row(one, { metadataURI: row(ASKED).metadataURI })),
      env: { RUNNER_MAX_PER_PASS: "2" },
    });
    const summary = await onePass(kit.deps);
    expect(summary.considered).toBe(2);
    expect(kit.claims).toHaveLength(2);
    expect(kit.runs).toHaveLength(2);
  });

  it("stops a queued request at the balance floor before anything is counted or run (R9)", async () => {
    const kit = standIns({ pending: [ASKED], rows: [row(ASKED)], balance: 1_499_999_999_999_999_999n });
    const summary = await onePass(kit.deps);
    expect(kit.runs).toHaveLength(0);
    expect(kit.state().reports).toBe(0);
    expect(summary.stopped).toContain("under the floor");
  });

  it("spends nothing when the ledger read back from disk holds a count that is not a whole number (R9)", async () => {
    for (const reports of [Number.NaN, -5, 1.5]) {
      const kit = standIns({ sweep: [row(PICTURE)], state: { ...emptyState("2026-09-22"), reports } });
      const summary = await onePass(kit.deps);
      expect(kit.runs).toHaveLength(0);
      expect(summary.stopped).toContain("daily cap");
    }
  });

  it("never asks for more than one pass worth of passports", async () => {
    const many = ["1", "2", "3", "4", "5", "6", "7"].map((letter) => row(id(letter)));
    const kit = standIns({ sweep: many, env: { RUNNER_MAX_PER_PASS: "2" } });
    const summary = await onePass(kit.deps);
    expect(summary.considered).toBe(2);
  });
});

describe("dry-run mode", () => {
  it("runs the simulator with the broadcast flag off and reports nothing back", async () => {
    const kit = standIns({ env: { RUNNER_DRY_RUN: "1" }, pending: [ASKED], rows: [row(ASKED)] });
    const summary = await onePass(kit.deps);

    expect(kit.runs[0]?.broadcast).toBe(false);
    expect(kit.reports).toHaveLength(0);
    expect(summary.ran).toBe(1);
  });

  it("spends nothing from the day's cap", async () => {
    const kit = standIns({ env: { RUNNER_DRY_RUN: "1" }, sweep: [row(PICTURE)] });
    await onePass(kit.deps);
    expect(kit.state().reports).toBe(0);
  });

  it("says what it would have done, one passport at a time", async () => {
    const kit = standIns({ env: { RUNNER_DRY_RUN: "1" }, sweep: [row(PICTURE)] });
    await onePass(kit.deps);
    expect(kit.lines.join("\n")).toContain("dry run: passport 0xaaaaaaaaaa would be re-checked");
  });
});

describe("a passport asking for a private re-check", () => {
  const SEALED_DIR = "moolam-sealed-verifier";

  it("is routed to the sealed workflow folder, and a public passport is not", async () => {
    const kit = standIns({ sweep: [row(PRIVATE), row(PICTURE)] });
    const summary = await onePass(kit.deps);

    expect(summary.ran).toBe(2);
    expect(path.basename(kit.runs[0]?.workflowDir ?? "")).toBe(SEALED_DIR);
    expect(path.basename(kit.runs[1]?.workflowDir ?? "")).toBe("moolam-verifier");
    expect(kit.lookups).toHaveLength(0);
  });

  it("goes on when the copy is kept: a request, then a claim, then the simulator, then the release", async () => {
    const kit = standIns({ sweep: [row(PRIVATE)], copy: "kept" });
    await onePass(kit.deps);

    expect(kit.calls).toEqual([
      `status ${PRIVATE}`,
      `request ${PRIVATE}`,
      `claim ${PRIVATE}`,
      `simulate ${SEALED_DIR}`,
      `done ${PRIVATE}`,
    ]);
    expect(kit.state().reports).toBe(1);
  });

  it("does not ask for a second request when the passport came off the queue, and claims it only just before the run", async () => {
    const kit = standIns({ pending: [PRIVATE], rows: [row(PRIVATE)] });
    await onePass(kit.deps);
    expect(kit.calls).toEqual([`status ${PRIVATE}`, `claim ${PRIVATE}`, `simulate ${SEALED_DIR}`, `done ${PRIVATE}`]);
  });

  it("treats a copy that is gone exactly as a plain sealed passport: refused, nothing spent", async () => {
    const kit = standIns({ pending: [PRIVATE], rows: [row(PRIVATE)], copy: "gone" });
    const summary = await onePass(kit.deps);

    expect(kit.runs).toHaveLength(0);
    expect(summary.ran).toBe(0);
    expect(kit.lookups).toEqual([PRIVATE]);
    expect(kit.reports[0]?.reason).toContain("is sealed, so there is no published picture to re-check");
    expect(kit.state().reports).toBe(0);
    expect(kit.calls).not.toContain(`request ${PRIVATE}`);
  });

  it("re-checks a gone copy's passport publicly when its holder has published the picture since", async () => {
    const kit = standIns({ sweep: [row(PRIVATE)], copy: "gone", record: () => FOUND });
    await onePass(kit.deps);
    expect(path.basename(kit.runs[0]?.workflowDir ?? "")).toBe("moolam-verifier");
    expect(kit.calls).not.toContain(`request ${PRIVATE}`);
  });

  it("tries again later when the copy's state is unknown, spending nothing and claiming nothing", async () => {
    const kit = standIns({ sweep: [row(PRIVATE)], copy: "unknown" });
    const summary = await onePass(kit.deps);

    expect(kit.runs).toHaveLength(0);
    expect(summary.ran).toBe(0);
    expect(kit.calls).toEqual([`status ${PRIVATE}`]);
    expect(kit.state().reports).toBe(0);
    expect(kit.state().failures).toBe(0);
    expect(kit.state().recent[PRIVATE]).toBeUndefined();
    expect(kit.lines.join(" ")).toContain("trying again in 10 minutes");
  });

  it("refuses with a named reason when the env file carries no CRE_SEALED_LINK_TOKEN, before any request", async () => {
    const kit = standIns({ pending: [PRIVATE], rows: [row(PRIVATE)], token: null });
    await onePass(kit.deps);

    expect(kit.runs).toHaveLength(0);
    expect(kit.calls).not.toContain(`request ${PRIVATE}`);
    expect(kit.state().reports).toBe(0);
    expect(kit.reports[0]?.reason).toContain("has no CRE_SEALED_LINK_TOKEN");
  });

  it("refuses when the queue reads the copy as gone, and runs nothing when the claim is taken", async () => {
    const sealed = standIns({ sweep: [row(PRIVATE)], placed: "sealed" });
    await onePass(sealed.deps);
    expect(sealed.runs).toHaveLength(0);
    expect(sealed.calls).not.toContain(`claim ${PRIVATE}`);
    expect(sealed.lines.join(" ")).toContain("reads its private copy as gone");

    const taken = standIns({ sweep: [row(PRIVATE)], claim: () => "taken" });
    await onePass(taken.deps);
    expect(taken.runs).toHaveLength(0);
    expect(taken.reports).toHaveLength(0);
    expect(taken.state().reports).toBe(0);
  });

  it("releases the claim through /recheck/done when the run fails", async () => {
    const kit = standIns({
      sweep: [row(PRIVATE)],
      simulate: () => ({ ok: false, reason: "the private copy fetch returned status 403", printed: "cre ..." }),
    });
    await onePass(kit.deps);
    expect(kit.reports).toEqual([{ passportId: PRIVATE, reason: "the private copy fetch returned status 403" }]);
  });

  it("releases the claim when the simulator cannot even be started", async () => {
    const kit = standIns({ sweep: [row(PRIVATE)] });
    kit.deps.simulate = async () => {
      throw new Error("spawn cre ENOENT");
    };
    await onePass(kit.deps);
    expect(kit.reports).toEqual([{ passportId: PRIVATE, reason: "the simulation could not be run" }]);
    expect(kit.lines.join(" ")).toContain("could not be handled");
  });

  it("is named and not started in a dry run, which claims nothing, since a private link needs a claim", async () => {
    const kit = standIns({ env: { RUNNER_DRY_RUN: "1" }, pending: [PRIVATE], rows: [row(PRIVATE)], sweep: [row(PRIVATE)] });
    await onePass(kit.deps);

    expect(kit.runs).toHaveLength(0);
    expect(kit.calls).toEqual([`status ${PRIVATE}`]);
    expect(kit.reports).toEqual([]);
    expect(kit.state().reports).toBe(0);
    expect(kit.lines.join(" ")).toContain("needs a live claim");
  });

  it("posts a reason with no download link, no service address and no token in it (B5)", async () => {
    const link =
      "https://lavender-personal-grasshopper-978.mypinata.cloud/files/bafkreigwx2?X-Algorithm=PINATA1&X-Date=1790000000&X-Expires=120&X-Method=GET&X-Signature=9c1f0a";
    const line = `✗ failed: GET ${link} errored after verify.example/sealed/link answered with token ${SEALED_TOKEN}; retry X-Signature=9c1f0a against https://verify.example/sealed/link`;
    const kit = standIns({ sweep: [row(PRIVATE)] });
    kit.deps.simulate = (request) => runSimulation(request, async () => ({ output: line, code: 1, timedOut: false }));
    await onePass(kit.deps);

    const posted = kit.reports[0]?.reason ?? "";
    expect(posted).not.toBe("");
    for (const leaked of ["mypinata", "X-Signature", "X-Algorithm", "9c1f0a", "verify.example", SEALED_TOKEN]) {
      expect(posted).not.toContain(leaked);
      expect(kit.lines.join("\n")).not.toContain(leaked);
    }
    expect(kit.runs).toHaveLength(0);
  });
});

describe("a report the forwarder refused", () => {
  const REFUSED_RECEIPT = (
    JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "fixtures", "receipt-085d8500-refused.json"), "utf8")) as {
      result: unknown;
    }
  ).result;

  it("is a failure, never done, when the receipt says status 1 and ReportProcessed false", async () => {
    const kit = standIns({ pending: [ASKED], rows: [row(ASKED)] });
    const checked: string[] = [];
    kit.deps.reportLanded = async (reportTx, passportId) => {
      checked.push(reportTx);
      return attestationLanded(async () => REFUSED_RECEIPT, reportTx, passportId, kit.deps.config.registry);
    };
    const summary = await onePass(kit.deps);

    expect(checked).toEqual([`0x${"f".repeat(64)}`]);
    expect(summary).toMatchObject({ ran: 1, done: 0, failed: 1 });
    expect(kit.reports).toHaveLength(1);
    expect(kit.reports[0]?.reportTx).toBeUndefined();
    expect(kit.reports[0]?.reason).toContain("no attestation");
    expect(kit.state().reports).toBe(1);
    expect(kit.state().failures).toBe(1);
  });

  it("goes into the backoff like any other failure", async () => {
    const kit = standIns({
      sweep: [row(PICTURE), row(ASKED)],
      state: { ...emptyState("2026-09-22"), failures: 2 },
      landed: false,
    });
    const summary = await onePass(kit.deps);
    expect(summary.stopped).toContain("backing off for 30 minutes");
    expect(kit.runs).toHaveLength(1);
  });

  it("is a failure, spending nothing more, when the receipt cannot be read at all", async () => {
    const kit = standIns({ pending: [ASKED], rows: [row(ASKED)] });
    kit.deps.reportLanded = async () => {
      throw new Error("the node has no receipt");
    };
    const summary = await onePass(kit.deps);
    expect(summary).toMatchObject({ ran: 1, done: 0, failed: 1 });
    expect(kit.reports[0]?.reportTx).toBeUndefined();
    expect(kit.state().sent[ASKED]).toMatchObject({ tx: `0x${"f".repeat(64)}`, landed: null });
    expect(kit.state().waiting[ASKED]).toBeDefined();
    expect(kit.state().recent[ASKED]).toBeUndefined();
  });

  it("is never asked about in a dry run, which writes nothing", async () => {
    const kit = standIns({
      env: { RUNNER_DRY_RUN: "1" },
      sweep: [row(PICTURE)],
      simulate: () => ({ ok: true, recomputed: "0x63779c989c7f3121", distance: 0, matched: true, printed: "cre ..." }),
    });
    let asked = false;
    kit.deps.reportLanded = async () => {
      asked = true;
      return false;
    };
    const summary = await onePass(kit.deps);
    expect(asked).toBe(false);
    expect(summary.done).toBe(1);
  });
});

describe("nothing from the env file leaves the process (R11)", () => {
  it("logs and posts no env value, fed every one of them through a failing pass (R11)", async () => {
    const PRIVATE_KEY = `0x${"5eed".repeat(16)}`;
    const RUNNER_TOKEN = "runner-token-9d8c7b6a5f4e";
    const CLI_RPC = "https://example-name.monad-mainnet.quiknode.pro/5ecre7k3yvalue/";
    const RUNNER_RPC = "https://rpc.example/key-0f1e2d3c4b5a";
    const ENVIO = "https://indexer.example/abcd1234efgh/v1/graphql";
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), "moolam-runner-env-"));
    const envFile = path.join(folder, "runner.env");
    fs.writeFileSync(
      envFile,
      [
        `CRE_ETH_PRIVATE_KEY=${PRIVATE_KEY}`,
        `MONAD_MAINNET_RPC_URL="${CLI_RPC}"`,
        `export CRE_SEALED_LINK_TOKEN=${SEALED_TOKEN}`,
        `RUNNER_TOKEN=${RUNNER_TOKEN}`,
        "RUNNER_DRY_RUN=0",
      ].join("\n"),
      "utf8",
    );

    try {
      const kit = standIns({
        env: { CRE_ENV_FILE: envFile, RUNNER_TOKEN, MONAD_RPC_URL: RUNNER_RPC, ENVIO_GRAPHQL_URL: ENVIO },
        pending: [ASKED, PICTURE],
        rows: [row(ASKED), row(PICTURE)],
      });
      const everything = `key ${PRIVATE_KEY} token ${RUNNER_TOKEN} Bearer ${RUNNER_TOKEN} rpc example-name.monad-mainnet.quiknode.pro/5ecre7k3yvalue/ path 5ecre7k3yvalue runner rpc.example/key-0f1e2d3c4b5a index indexer.example/abcd1234efgh sealed ${SEALED_TOKEN}`;
      kit.deps.index.unrechecked = async () => {
        throw new Error(`the index at ${ENVIO} refused: ${everything}`);
      };
      kit.deps.eventIndex = async (txHash) => {
        if (txHash === row(ASKED).txHash) {
          throw new Error(`the node refused: ${everything}`);
        }
        return 0;
      };
      kit.deps.simulate = (request) =>
        runSimulation(request, async () => ({ output: `✗ failed: ${everything}`, code: 1, timedOut: false }));
      const done = kit.deps.queue.done;
      kit.deps.queue.done = async (report) => {
        await done(report);
        throw new Error(`the done route said: ${everything}`);
      };

      await onePass(kit.deps);

      const logged = kit.lines.join("\n");
      const posted = kit.reports.map((one) => one.reason ?? "").join("\n");
      const stored = JSON.stringify(kit.state());
      expect(logged).toContain("could not read the index");
      expect(logged).toContain("could not report back to the queue");
      // The receipt read that failed for ASKED is a passing miss: left on the queue, its reason kept
      // in the state file for a later answer. PICTURE ran and failed, and that is the one report.
      expect(kit.reports.map((one) => one.passportId)).toEqual([PICTURE]);
      expect(kit.state().waiting[ASKED]?.reason).toContain("could not be read");
      for (const leaked of [PRIVATE_KEY, RUNNER_TOKEN, "5ecre7k3yvalue", "quiknode", "key-0f1e2d3c4b5a", "abcd1234efgh", SEALED_TOKEN]) {
        expect(logged).not.toContain(leaked);
        expect(posted).not.toContain(leaked);
        expect(stored).not.toContain(leaked);
      }
    } finally {
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });
});

/**
 * The verify service's queue as packages/verifier/src/recheck/queue.ts keeps it, cut down to what the
 * runner can see: a page of the fifty oldest pending requests, a claim that answers 404 for no
 * request and 409 for a finished or running one, a done that only a running request accepts, and
 * revive, which is the service offering a claim nobody closed again once it passed its timeout.
 */
function modelQueue(ids: string[]): {
  client: QueueClient;
  status: (passportId: string) => string | undefined;
  revive: (passportId: string) => void;
} {
  const items = new Map<string, string>(ids.map((one) => [one, "pending"]));
  const client: QueueClient = {
    pending: async () =>
      [...items]
        .filter(([, status]) => status === "pending")
        .slice(0, 50)
        .map(([one]) => one),
    request: async (passportId) => {
      const status = items.get(passportId);
      if (status === undefined || status === "done" || status === "failed") {
        items.delete(passportId);
        items.set(passportId, "pending");
      }
      return "placed";
    },
    claim: async (passportId) => {
      const status = items.get(passportId);
      if (status === undefined) {
        return "not-requested";
      }
      if (status === "done" || status === "failed") {
        return "finished";
      }
      if (status === "running") {
        return "taken";
      }
      items.set(passportId, "running");
      return "claimed";
    },
    done: async (report) => {
      if (items.get(report.passportId) !== "running") {
        throw new Error("the re-check done route answered 409");
      }
      items.set(report.passportId, report.reportTx === undefined ? "failed" : "done");
    },
  };
  return {
    client,
    status: (passportId) => items.get(passportId),
    revive: (passportId) => {
      if (items.get(passportId) === "running") {
        items.set(passportId, "pending");
      }
    },
  };
}

describe("the runner review findings, each shown failing on the code before WO-175", () => {
  const HOUR = 3_600_000;

  it("hands back every request it claims, on every way a run can stop (tally R1)", async () => {
    const exits: [string, Parameters<typeof standIns>[0], ((kit: StandIns) => void)?][] = [
      ["the wallet under the floor", { pending: [ASKED], rows: [row(ASKED)], balance: 1_400_000_000_000_000_000n }],
      ["a private copy nobody can read", { pending: [PRIVATE], rows: [row(PRIVATE)], copy: "unknown" }],
      [
        "an unseal record lookup that failed",
        { pending: [SEALED], rows: [row(SEALED)], record: () => ({ kind: "failed", reason: "the unseal record lookup answered status 503" }) },
      ],
      [
        "the index failing",
        { pending: [ASKED] },
        (kit) => {
          kit.deps.index.byId = async () => {
            throw new Error("the index answered 429");
          };
        },
      ],
      [
        "a simulator that will not start",
        { pending: [ASKED], rows: [row(ASKED)] },
        (kit) => {
          kit.deps.simulate = async () => {
            throw new Error("spawn cre ENOENT");
          };
        },
      ],
    ];
    for (const [name, input, tweak] of exits) {
      const kit = standIns(input);
      tweak?.(kit);
      await onePass(kit.deps);
      const answered = kit.reports.map((one) => one.passportId);
      expect(kit.claims.filter((one) => !answered.includes(one)), name).toEqual([]);
      expect(answered.length, name).toBeLessThanOrEqual(kit.claims.length);
    }
  });

  it("claims nothing in a dry run, from the queue or from the sweep (tally R7)", async () => {
    const kit = standIns({ env: { RUNNER_DRY_RUN: "1" }, pending: [ASKED], rows: [row(ASKED)], sweep: [row(PICTURE)] });
    await onePass(kit.deps);
    expect(kit.runs.map((one) => one.broadcast)).toEqual([false, false]);
    expect(kit.claims).toEqual([]);
    expect(kit.calls.filter((one) => one.startsWith("request"))).toEqual([]);
    expect(kit.reports).toEqual([]);
  });

  it("stops between passports on a stop signal, and lets the run in hand finish and hand back (tally R10)", async () => {
    let stop = false;
    const kit = standIns({ pending: [ASKED], rows: [row(ASKED)], sweep: [row(PICTURE)] });
    const simulate = kit.deps.simulate;
    kit.deps.simulate = async (request) => {
      stop = true;
      return simulate(request);
    };
    kit.deps.stopping = () => stop;
    const summary = await onePass(kit.deps);
    expect(kit.runs).toHaveLength(1);
    expect(kit.reports).toEqual([expect.objectContaining({ passportId: ASKED, reportTx: `0x${"f".repeat(64)}` })]);
    expect(summary.stopped).toContain("stop signal");
  });

  it("settles a document the workflow must refuse once, with its reason, and never reads it again (tally R2)", async () => {
    const kit = standIns({ pending: [NO_PICTURE], rows: [row(NO_PICTURE)] });
    let reads = 0;
    const read = kit.deps.readDocument;
    kit.deps.readDocument = async (uri) => {
      reads += 1;
      return read(uri);
    };
    await onePass(kit.deps);
    kit.deps.now = () => NOW + 7 * HOUR;
    await onePass(kit.deps);

    expect(reads).toBe(1);
    expect(kit.runs).toHaveLength(0);
    expect(kit.reports.map((one) => one.reason)).toEqual([
      expect.stringContaining("no thumbnail or image"),
      expect.stringContaining("no thumbnail or image"),
    ]);
    expect(kit.state().reports).toBe(0);
    expect(kit.state().failures).toBe(0);
  });

  it("stops paying for a passport whose report the receiver refused twice (tally R4)", async () => {
    const kit = standIns({ sweep: [row(PICTURE)], landed: false });
    for (const hours of [0, 7, 14, 21]) {
      kit.deps.now = () => NOW + hours * HOUR;
      await onePass(kit.deps);
    }
    expect(kit.runs).toHaveLength(2);
    expect(kit.state().closed?.[PICTURE]?.reason).toContain("refused");
  });

  it("tries again soon after a passing miss, and never closes a request as failed for one (tally R5)", async () => {
    const sweep = standIns({ sweep: [row(PICTURE)] });
    sweep.deps.readDocument = async () => UNREADABLE;
    await onePass(sweep.deps);
    sweep.deps.readDocument = async (uri) => DOCUMENTS[uri] ?? UNREADABLE;
    sweep.deps.now = () => NOW + 11 * 60_000;
    await onePass(sweep.deps);
    expect(sweep.runs).toHaveLength(1);

    const receipt = standIns({ pending: [ASKED], rows: [row(ASKED)] });
    receipt.deps.eventIndex = async () => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    };
    await onePass(receipt.deps);
    expect(receipt.reports).toEqual([]);

    const service = modelQueue([ASKED]);
    const gateway = standIns({
      rows: [row(ASKED)],
      simulate: () => ({ ok: false, reason: "thumbnail fetch answered status 504 from [address removed]", printed: "cre ..." }),
    });
    gateway.deps.queue = service.client;
    await onePass(gateway.deps);
    expect(gateway.runs).toHaveLength(1);
    expect(service.status(ASKED)).toBe("pending");
    expect(gateway.state().recent[ASKED]).toBeUndefined();
  });

  it("tells a failure that may pass from a final one by the words the simulator and the workflows print (tally R5)", () => {
    for (const passing of [
      "thumbnail fetch answered status 504 from [address removed]",
      "the gateway answered 502",
      "unseal record lookup for passport 0xabc did not answer",
      "the simulation was still running after 600 seconds and was stopped",
      "context deadline exceeded",
      "The operation was aborted due to timeout",
      "metadata for passport 0xabc answered status 429",
    ]) {
      expect(isPassingFailure(passing), passing).toBe(true);
    }
    for (const final of [
      "thumbnail fetch answered status 404 from [address removed]",
      "the private copy fetch for passport 0xabc returned status 403",
      "the CLI exited 1",
      "image is 512x29, too small to fingerprint",
      "passport 0xabc names a picture that is not an IPFS content id, so it is not fetched",
    ]) {
      expect(isPassingFailure(final), final).toBe(false);
    }
  });

  it("answers requests for passports in cooldown, so fifty of them never hide a newer one (tally R6)", async () => {
    const cooled = Array.from({ length: 50 }, (_, index) => `0x${(index + 1).toString(16).padStart(64, "0")}`);
    let state = emptyState("2026-09-22");
    for (const one of cooled) {
      state = noteRecent(state, one, NOW - 60_000);
    }
    const service = modelQueue([...cooled, ASKED]);
    const kit = standIns({ rows: [row(ASKED)], state });
    kit.deps.queue = service.client;
    for (let pass = 0; pass < 5; pass += 1) {
      await onePass(kit.deps);
    }
    expect(kit.runs.map((one) => one.txHash)).toEqual([row(ASKED).txHash]);
    expect(cooled.filter((one) => service.status(one) !== "failed")).toEqual([]);
  });

  it("does not run a requested passport whose document could not be read, and leaves the request waiting (tally R9)", async () => {
    const kit = standIns({ pending: [ASKED], rows: [row(ASKED)] });
    kit.deps.readDocument = async () => UNREADABLE;
    await onePass(kit.deps);
    expect(kit.runs).toHaveLength(0);
    expect(kit.state().reports).toBe(0);
    expect(kit.claims).toEqual([]);
  });

  it("never sends a second report for a passport it re-checked, while the index still reads zero (tally R11)", async () => {
    const kit = standIns({ sweep: [row(PICTURE)] });
    await onePass(kit.deps);
    kit.deps.now = () => NOW + 7 * HOUR;
    kit.deps.queue.pending = async () => [PICTURE];
    await onePass(kit.deps);
    expect(kit.runs).toHaveLength(1);
    expect(kit.reports.at(-1)).toEqual({ passportId: PICTURE, reportTx: `0x${"f".repeat(64)}` });
  });

  it("settles a picture too narrow or too small to fingerprint, spending nothing on it (tally R12)", async () => {
    const kit = standIns({ pending: [ASKED], rows: [row(ASKED)], picture: () => ({ kind: "ok", width: 512, height: 29 }) });
    await onePass(kit.deps);
    expect(kit.runs).toHaveLength(0);
    expect(kit.state().reports).toBe(0);
    expect(kit.state().failures).toBe(0);
    expect(kit.reports[0]?.reason).toContain("512x29, too small to fingerprint");
  });

  it("looks past passports it has settled, so an older real picture is still swept (tally R3)", async () => {
    const newer = ["1", "2", "3", "4", "5"].map((letter) => id(letter));
    let state = emptyState("2026-09-22");
    for (const one of newer) {
      state = noteRecent(state, one, NOW - 60_000);
    }
    const kit = standIns({ sweep: [...newer.map((one) => row(one)), row(PICTURE)], state });
    await onePass(kit.deps);
    expect(kit.runs.map((one) => one.txHash)).toEqual([row(PICTURE).txHash]);
  });
});

describe("the circuit breaker on refused reports (CLAUDE.md 6f)", () => {
  const FOUR = ["1", "2", "3", "4"].map((letter) => id(letter));
  const readable = (one: string): PassportRow => row(one, { metadataURI: row(ASKED).metadataURI });
  // The backoff is set out of reach so these tests see the breaker alone.
  const ENV = { RUNNER_FAILURES_BEFORE_BACKOFF: "10" };

  it("trips on three refusals in a row across different passports, and the fourth passport spends nothing", async () => {
    const kit = standIns({ env: ENV, sweep: FOUR.map(readable), landed: false });
    const summary = await onePass(kit.deps);

    expect(kit.runs).toHaveLength(3);
    expect(kit.state().reports).toBe(3);
    expect(kit.claims).not.toContain(FOUR[3]);
    expect(kit.state().breaker.tripped?.reason).toContain("3 different passports in a row");
    expect(summary.stopped).toContain("CIRCUIT BREAKER TRIPPED");

    kit.deps.now = () => NOW + 7 * 3_600_000;
    const later = await onePass(kit.deps);
    expect(kit.runs).toHaveLength(3);
    expect(kit.state().reports).toBe(3);
    expect(later.stopped).toContain("CIRCUIT BREAKER TRIPPED");
    expect(kit.lines.filter((line) => line.includes("CIRCUIT BREAKER TRIPPED")).length).toBeGreaterThanOrEqual(2);
  });

  it("stays tripped across a restart, and runs again only after a restart with RUNNER_RESET_BREAKER=1", async () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), "moolam-runner-breaker-"));
    const file = path.join(folder, "state.json");
    try {
      const tripped = standIns({ env: ENV, sweep: FOUR.map(readable), landed: false });
      await onePass(tripped.deps);
      saveState(file, tripped.state());

      const restarted = standIns({ env: ENV, sweep: [row(PICTURE)] });
      const plain = openingState(loadState(file, NOW), restarted.deps.config, (line) => restarted.lines.push(line));
      restarted.deps.readState = () => plain;
      await onePass(restarted.deps);
      expect(restarted.runs).toHaveLength(0);
      expect(restarted.lines.join(" ")).toContain("CIRCUIT BREAKER TRIPPED");

      const reset = standIns({ env: { ...ENV, RUNNER_RESET_BREAKER: "1" }, sweep: [row(PICTURE)] });
      let state = openingState(loadState(file, NOW), reset.deps.config, (line) => reset.lines.push(line));
      reset.deps.readState = () => state;
      reset.deps.writeState = (next) => {
        state = next;
      };
      await onePass(reset.deps);
      expect(reset.runs).toHaveLength(1);
      expect(state.breaker).toEqual({ streak: [], tripped: null });
      expect(reset.lines.join(" ")).toContain("circuit breaker cleared by RUNNER_RESET_BREAKER=1");
    } finally {
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });

  it("starts the count again when a report lands between refusals", async () => {
    const kit = standIns({ env: ENV, sweep: FOUR.map(readable) });
    kit.deps.reportLanded = async (_tx, passportId) => passportId === FOUR[2];
    const summary = await onePass(kit.deps);

    expect(kit.runs).toHaveLength(4);
    expect(summary.stopped).toBeUndefined();
    expect(kit.state().breaker).toEqual({ streak: [FOUR[3]], tripped: null });
  });
});

describe("a report whose done never reached the service (verifier review pass 4, V19)", () => {
  it("answers the passport the service offers again with the report it remembers, and never pays twice", async () => {
    const service = modelQueue([ASKED]);
    const kit = standIns({ rows: [row(ASKED)] });
    const handedBack: DoneReport[] = [];
    let lose = true;
    kit.deps.queue = {
      ...service.client,
      done: async (report) => {
        if (lose) {
          lose = false;
          throw new Error("the re-check done route answered 503");
        }
        handedBack.push(report);
        await service.client.done(report);
      },
    };

    await onePass(kit.deps);
    expect(kit.runs).toHaveLength(1);
    expect(service.status(ASKED)).toBe("running");
    expect(kit.lines.join(" ")).toContain("could not report back to the queue");

    // The claim passed its thirty minutes on the service, which offers the passport again.
    service.revive(ASKED);
    kit.deps.now = () => NOW + 31 * 60_000;
    await onePass(kit.deps);

    expect(kit.runs).toHaveLength(1);
    expect(kit.state().reports).toBe(1);
    expect(handedBack).toEqual([{ passportId: ASKED, reportTx: `0x${"f".repeat(64)}` }]);
    expect(service.status(ASKED)).toBe("done");
  });
});

describe("a broadcast run the CLI printed no report hash for (WO-190)", () => {
  /** The passport and the report the droplet's CLI v1.35.0 sent on 2026-09-27 without printing its hash. */
  const OBSERVED = "0xfd09a7710088e9bdcdd630904668c29e54a4042eafdab74f25749d397eef6c98";
  const OBSERVED_TX = "0x37717b0c067afcc65bf79d036de55c2bcc1b22b08143b3ac28c3320bd3abe24b";
  const ZERO_HASH_OUTPUT = fs.readFileSync(path.join(import.meta.dirname, "fixtures", "simulate-dry-run.txt"), "utf8");

  it("is done with the chain's transaction when the output held only the zero hash and the verdict is on chain", async () => {
    const kit = standIns({
      pending: [OBSERVED],
      rows: [row(OBSERVED, { metadataURI: row(ASKED).metadataURI })],
      found: (passportId, head) => (passportId === OBSERVED && head === HEAD ? OBSERVED_TX : null),
    });
    kit.deps.simulate = (request) => runSimulation(request, async () => ({ output: ZERO_HASH_OUTPUT, code: 0, timedOut: false }));
    const summary = await onePass(kit.deps);

    expect(summary).toMatchObject({ ran: 1, done: 1, failed: 0 });
    expect(kit.reports).toEqual([{ passportId: OBSERVED, reportTx: OBSERVED_TX, matched: true, distance: 0 }]);
    expect(kit.state().sent[OBSERVED]).toMatchObject({ tx: OBSERVED_TX, landed: true });
    expect(kit.state().reports).toBe(1);
    expect(kit.state().failures).toBe(0);
    expect(kit.state().recent[OBSERVED]).toBeUndefined();
  });

  it("is a failure as today when the chain holds no verdict from this runner for it", async () => {
    const kit = standIns({ pending: [OBSERVED], rows: [row(OBSERVED, { metadataURI: row(ASKED).metadataURI })], found: () => null });
    kit.deps.simulate = (request) => runSimulation(request, async () => ({ output: ZERO_HASH_OUTPUT, code: 0, timedOut: false }));
    const summary = await onePass(kit.deps);

    expect(summary).toMatchObject({ ran: 1, done: 0, failed: 1 });
    expect(kit.reports).toEqual([{ passportId: OBSERVED, reason: "the run wrote no report transaction" }]);
    expect(kit.state().sent[OBSERVED]).toBeUndefined();
    expect(kit.state().failures).toBe(1);
    expect(kit.state().recent[OBSERVED]).toBeDefined();
  });

  it("holds the passport and sends nothing more when the chain cannot be read, and never counts it failed", async () => {
    const service = modelQueue([OBSERVED]);
    const kit = standIns({ rows: [row(OBSERVED, { metadataURI: row(ASKED).metadataURI })], sweep: [row(PICTURE)] });
    kit.deps.queue = service.client;
    const simulate = kit.deps.simulate;
    kit.deps.simulate = async (request) =>
      request.txHash === row(OBSERVED).txHash
        ? (await simulate(request), runSimulation(request, async () => ({ output: ZERO_HASH_OUTPUT, code: 0, timedOut: false })))
        : simulate(request);
    kit.deps.findReport = async () => {
      throw new Error("eth_getLogs was refused: block range too large");
    };
    const summary = await onePass(kit.deps);

    expect(summary).toMatchObject({ ran: 2, done: 1, failed: 0 });
    expect(kit.runs.filter((one) => one.txHash === row(OBSERVED).txHash)).toHaveLength(1);
    expect(kit.state().reports).toBe(2);
    expect(kit.state().failures).toBe(0);
    expect(kit.state().breaker.streak).toEqual([]);
    expect(kit.state().undecided[OBSERVED]).toBe(Math.floor(NOW / 1000));
    expect(kit.state().recent[OBSERVED]).toBeUndefined();
    expect(kit.state().waiting[OBSERVED]).toBeUndefined();
    expect(service.status(OBSERVED)).toBe("failed");
    expect(kit.lines.join(" ")).toContain("could not be read to tell whether its verdict landed");

    kit.deps.now = () => NOW + 3_600_000;
    kit.deps.index.unrechecked = async () => [row(OBSERVED, { metadataURI: row(ASKED).metadataURI })];
    await onePass(kit.deps);
    expect(kit.runs.filter((one) => one.txHash === row(OBSERVED).txHash)).toHaveLength(1);
  });

  it("starts no second run for an undecided passport on a fresh request within the cooldown, and answers it held", async () => {
    const observed = row(OBSERVED, { metadataURI: row(ASKED).metadataURI });
    const service = modelQueue([OBSERVED]);
    const kit = standIns({ rows: [observed] });
    kit.deps.queue = {
      ...service.client,
      done: async (report) => {
        kit.reports.push(report);
        await service.client.done(report);
      },
    };
    kit.deps.simulate = (request) => {
      kit.runs.push(request);
      return runSimulation(request, async () => ({ output: ZERO_HASH_OUTPUT, code: 0, timedOut: false }));
    };
    kit.deps.findReport = async () => {
      throw new Error("eth_getLogs was refused: block range too large");
    };
    await onePass(kit.deps);
    expect(kit.runs).toHaveLength(1);

    kit.deps.findReport = async () => null;
    for (const hours of [1, 3, 5.9]) {
      kit.deps.now = () => NOW + hours * 3_600_000;
      await service.client.request(OBSERVED);
      kit.deps.index.unrechecked = async () => [observed];
      await onePass(kit.deps);
      expect(kit.runs, `after ${hours} hours`).toHaveLength(1);
      expect(kit.reports.at(-1)?.reason, `after ${hours} hours`).toContain("is held");
      expect(service.status(OBSERVED)).toBe("failed");
    }
    expect(kit.state().reports).toBe(1);
    expect(kit.state().failures).toBe(0);

    // The index catching up settles it; with no verdict there, the cooldown's end lets it run again.
    const settled = standIns({ rows: [row(OBSERVED, { metadataURI: row(ASKED).metadataURI, attestationCount: 1 })], pending: [OBSERVED], state: kit.state() });
    settled.deps.now = () => NOW + 3_600_000;
    await onePass(settled.deps);
    expect(settled.runs).toHaveLength(0);
    expect(settled.state().closed[OBSERVED]?.reason).toContain("already carries 1");

    kit.deps.now = () => NOW + 6 * 3_600_000 + 60_000;
    await service.client.request(OBSERVED);
    await onePass(kit.deps);
    expect(kit.runs).toHaveLength(2);
  });

  it("still takes a printed hash as today, without asking the chain for one", async () => {
    const kit = standIns({ pending: [ASKED], rows: [row(ASKED)] });
    let asked = false;
    kit.deps.findReport = async () => {
      asked = true;
      return OBSERVED_TX;
    };
    kit.deps.simulate = (request) =>
      runSimulation(request, async () => ({ output: fs.readFileSync(path.join(import.meta.dirname, "fixtures", "simulate-broadcast.txt"), "utf8"), code: 0, timedOut: false }));
    const summary = await onePass(kit.deps);

    expect(asked).toBe(false);
    expect(summary).toMatchObject({ ran: 1, done: 1, failed: 0 });
    expect(kit.reports[0]?.reportTx).toBe("0x085d8500ab86dc1f9028d8375b92e5b4b569d83d5f3c96c32e38679e5b6a3602");
  });

  it("does not start a paid run when the chain head cannot be noted first", async () => {
    const kit = standIns({ pending: [ASKED], rows: [row(ASKED)] });
    kit.deps.chainHead = async () => {
      throw new Error("the RPC call eth_blockNumber answered 503");
    };
    await onePass(kit.deps);
    expect(kit.runs).toHaveLength(0);
    expect(kit.claims).toEqual([]);
    expect(kit.state().reports).toBe(0);
  });

  it("logs the CLI's last lines on a failed run, with no address path, and posts none of them", async () => {
    const output = [
      "RPC health check failed for https://example-name.monad-mainnet.quiknode.pro/5ecre7k3y/ (status 401)",
      "Transaction sent to https://rpc.example/key-0f1e2d3c4b5a?api=hidden",
      "the broadcast did not print a hash",
    ].join("\n");
    const kit = standIns({ pending: [ASKED], rows: [row(ASKED)], found: () => null });
    kit.deps.simulate = (request) => runSimulation(request, async () => ({ output, code: 1, timedOut: false }));
    await onePass(kit.deps);

    const logged = kit.lines.join("\n");
    const failed = kit.lines.find((line) => line.includes(" failed: ")) ?? "";
    expect(failed).toContain("The CLI's last lines:");
    expect(failed).toContain("the broadcast did not print a hash");
    for (const leaked of ["5ecre7k3y", "key-0f1e2d3c4b5a", "api=hidden", "quiknode.pro/", "rpc.example/"]) {
      expect(logged).not.toContain(leaked);
    }
    expect(logged).not.toMatch(/[a-z]+:\/\/\S*\/\S/i);
    expect(kit.reports[0]?.reason ?? "").not.toContain("last lines");
    expect(JSON.stringify(kit.state())).not.toContain("last lines");
  });
});

describe("a report still being mined, and an index that is behind the chain (WO-196)", () => {
  const LATE = "0xfd09a7710088e9bdcdd630904668c29e54a4042eafdab74f25749d397eef6c98";
  const LATE_TX = "0x37717b0c067afcc65bf79d036de55c2bcc1b22b08143b3ac28c3320bd3abe24b";
  const ZERO_HASH_OUTPUT = fs.readFileSync(path.join(import.meta.dirname, "fixtures", "simulate-dry-run.txt"), "utf8");

  /** A requested no-hash run whose chain lookup gives these answers in turn, a thrown Error for a failed read. */
  function lateRun(answers: (string | null | Error)[]): { kit: StandIns; reads: () => number; gaps: number[] } {
    const kit = standIns({ pending: [LATE], rows: [row(LATE, { metadataURI: row(ASKED).metadataURI })] });
    kit.deps.simulate = (request) => {
      kit.runs.push(request);
      return runSimulation(request, async () => ({ output: ZERO_HASH_OUTPUT, code: 0, timedOut: false }));
    };
    let reads = 0;
    kit.deps.findReport = async () => {
      const answer = answers[reads] ?? null;
      reads += 1;
      if (answer instanceof Error) {
        throw answer;
      }
      return answer;
    };
    const gaps: number[] = [];
    kit.deps.sleep = async (ms) => {
      gaps.push(ms);
    };
    return { kit, reads: () => reads, gaps };
  }

  it("is done when the lookup finds the report on the third read, not failed on the first (F3)", async () => {
    const { kit, reads } = lateRun([null, null, LATE_TX]);
    const summary = await onePass(kit.deps);

    expect(reads()).toBe(3);
    expect(summary).toMatchObject({ ran: 1, done: 1, failed: 0 });
    expect(kit.reports).toEqual([{ passportId: LATE, reportTx: LATE_TX, matched: true, distance: 0 }]);
    expect(kit.state().failures).toBe(0);
    expect(kit.state().recent[LATE]).toBeUndefined();
  });

  it("does not run a sweep candidate the index reads as unchecked when the registry already counts a verdict (F2)", async () => {
    const kit = standIns({ sweep: [row(PICTURE)] });
    const asked: string[] = [];
    kit.deps.attestationCount = async (passportId) => {
      asked.push(passportId);
      return 1n;
    };
    const summary = await onePass(kit.deps);

    expect(asked).toEqual([PICTURE]);
    expect(kit.runs).toHaveLength(0);
    expect(kit.claims).toEqual([]);
    expect(summary.ran).toBe(0);
    expect(kit.state().reports).toBe(0);
    expect(kit.state().closed[PICTURE]).toBeDefined();
    expect(kit.lines.join(" ")).toContain("the chain already holds a verdict for it");
  });

  it("is done when the lookup finds the report on the fourth read, five seconds apart", async () => {
    const { kit, reads, gaps } = lateRun([null, null, null, LATE_TX]);
    const summary = await onePass(kit.deps);

    expect(reads()).toBe(LANDED_LOOKUP_TRIES);
    expect(gaps).toEqual([LANDED_LOOKUP_GAP_MS, LANDED_LOOKUP_GAP_MS, LANDED_LOOKUP_GAP_MS]);
    expect(summary).toMatchObject({ ran: 1, done: 1, failed: 0 });
    expect(kit.state().sent[LATE]).toMatchObject({ tx: LATE_TX, landed: true });
  });

  it("is a failure as today after four empty reads, and reads no fifth time", async () => {
    const { kit, reads, gaps } = lateRun([null, null, null, null, LATE_TX]);
    const summary = await onePass(kit.deps);

    expect(reads()).toBe(4);
    expect(gaps).toHaveLength(3);
    expect(summary).toMatchObject({ ran: 1, done: 0, failed: 1 });
    expect(kit.reports).toEqual([{ passportId: LATE, reason: "the run wrote no report transaction" }]);
    expect(kit.state().failures).toBe(1);
    expect(kit.state().recent[LATE]).toBeDefined();
  });

  it("is undecided at once when the second read throws, with no third read", async () => {
    const { kit, reads } = lateRun([null, new Error("eth_getLogs was refused: block range too large"), LATE_TX]);
    const summary = await onePass(kit.deps);

    expect(reads()).toBe(2);
    expect(summary).toMatchObject({ ran: 1, done: 0, failed: 0 });
    expect(kit.state().undecided[LATE]).toBe(Math.floor(NOW / 1000));
    expect(kit.state().recent[LATE]).toBeUndefined();
    expect(kit.state().failures).toBe(0);
  });

  it("runs a sweep candidate as today when the registry counts no verdict, asking it in one eth_call", async () => {
    const kit = standIns({ sweep: [row(PICTURE)] });
    const calls: [string, unknown[]][] = [];
    kit.deps.attestationCount = (passportId) =>
      attestationCount(
        async (method, params) => {
          calls.push([method, params]);
          return `0x${"0".repeat(64)}`;
        },
        kit.deps.config.registry,
        passportId,
      );
    const summary = await onePass(kit.deps);

    expect(calls).toEqual([["eth_call", [{ to: kit.deps.config.registry, data: `0xd65ddd52${PICTURE.slice(2)}` }, "latest"]]]);
    expect(summary).toMatchObject({ ran: 1, done: 1 });
    expect(kit.runs).toHaveLength(1);
  });

  it("never runs a sweep candidate blind when the count cannot be read: no run, no spend, no failure", async () => {
    for (const answer of [new Error("eth_call answered 503"), "0x", null]) {
      const kit = standIns({ sweep: [row(PICTURE)] });
      kit.deps.attestationCount = (passportId) =>
        attestationCount(
          async () => {
            if (answer instanceof Error) {
              throw answer;
            }
            return answer;
          },
          kit.deps.config.registry,
          passportId,
        );
      const summary = await onePass(kit.deps);

      expect(kit.runs, String(answer)).toHaveLength(0);
      expect(kit.claims, String(answer)).toEqual([]);
      expect(summary.ran, String(answer)).toBe(0);
      expect(kit.state().reports, String(answer)).toBe(0);
      expect(kit.state().failures, String(answer)).toBe(0);
      expect(kit.state().closed[PICTURE], String(answer)).toBeUndefined();
      expect(kit.state().waiting[PICTURE]?.misses, String(answer)).toBe(1);
      expect(kit.lines.join(" "), String(answer)).toContain("trying again in 10 minutes");
    }
  });
});
