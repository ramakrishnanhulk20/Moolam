import path from "node:path";
import { describe, expect, it } from "vitest";
import { readConfig, type Config } from "../src/config.js";
import type { Document, RecordLookup } from "../src/document.js";
import type { PassportRow } from "../src/index-read.js";
import type { Claim, DoneReport, Placed, QueueClient } from "../src/queue.js";
import type { CopyState } from "../src/sealed.js";
import { runSimulation, type SimulateRequest, type SimulateResult } from "../src/simulate.js";
import { emptyState, noteRecent, type RunnerState } from "../src/state.js";
import { onePass, type Deps } from "../src/runner.js";

const NOW = Date.parse("2026-09-22T12:00:00Z");

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

const DOCUMENTS: Record<string, Document> = {
  [`ipfs://document-${PICTURE.slice(2, 4)}`]: { title: "A lighthouse in fog", sealed: false, unsealed: false, readable: true, privateRecheck: false },
  [`ipfs://document-${SEALED.slice(2, 4)}`]: { title: "A kept picture", sealed: true, unsealed: false, readable: true, privateRecheck: false },
  [`ipfs://document-${SEED.slice(2, 4)}`]: { title: "Moolam seed 4", sealed: false, unsealed: false, readable: true, privateRecheck: false },
  [`ipfs://document-${ASKED.slice(2, 4)}`]: { title: "Harbour at dusk", sealed: false, unsealed: false, readable: true, privateRecheck: false },
  [`ipfs://document-${PRIVATE.slice(2, 4)}`]: { title: "Old but strong", sealed: true, unsealed: false, readable: true, privateRecheck: true },
};

const UNREADABLE: Document = { title: null, sealed: false, unsealed: false, readable: false, privateRecheck: false };

interface Kitchen {
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

function kitchen(input: {
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
}): Kitchen {
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
      unrechecked: async () => input.sweep ?? [],
      byId: async (passportId) => known.get(passportId) ?? null,
    },
    readDocument: async (metadataURI) => DOCUMENTS[metadataURI] ?? UNREADABLE,
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
    const kit = kitchen({
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
    const kit = kitchen({ pending: [ASKED], rows: [row(ASKED)] });
    await onePass(kit.deps);
    expect(kit.claims).toEqual([ASKED]);
    expect(kit.runs).toHaveLength(1);
  });

  it("leaves a request on the queue when the claim is refused, and runs nothing", async () => {
    const kit = kitchen({ pending: [ASKED], rows: [row(ASKED)], claim: () => "taken" });
    await onePass(kit.deps);
    expect(kit.runs).toHaveLength(0);
    expect(kit.lines.join(" ")).toContain("could not be claimed");
  });

  it("skips a sealed passport and tells the person who asked why", async () => {
    const kit = kitchen({ pending: [SEALED], rows: [row(SEALED)] });
    await onePass(kit.deps);
    expect(kit.runs).toHaveLength(0);
    expect(kit.reports[0]?.reason).toContain("sealed");
  });

  it("sweeps past a seed test card without spending a report on it", async () => {
    const kit = kitchen({ sweep: [row(SEED), row(PICTURE)] });
    const summary = await onePass(kit.deps);
    expect(summary.ran).toBe(1);
    expect(kit.runs[0]?.txHash).toBe(row(PICTURE).txHash);
    expect(kit.lines.join(" ")).toContain("seed test card");
  });

  it("runs a seed card anyway when somebody asked for it by hand", async () => {
    const kit = kitchen({ pending: [SEED], rows: [row(SEED)] });
    await onePass(kit.deps);
    expect(kit.runs).toHaveLength(1);
  });

  it("uses the event index the receipt gave rather than always zero", async () => {
    const kit = kitchen({ sweep: [row(ASKED)] });
    await onePass(kit.deps);
    expect(kit.runs[0]?.eventIndex).toBe(1);
  });

  it("reports the transaction back to the queue when a run wrote one", async () => {
    const kit = kitchen({ pending: [ASKED], rows: [row(ASKED)] });
    await onePass(kit.deps);
    expect(kit.reports[0]).toEqual({
      passportId: ASKED,
      reportTx: `0x${"f".repeat(64)}`,
      matched: true,
      distance: 0,
    });
  });

  it("reports a failure with the reason, and counts it", async () => {
    const kit = kitchen({
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
    const kit = kitchen({ pending: [ASKED], rows: [row(ASKED, { attestationCount: 1 })] });
    await onePass(kit.deps);
    expect(kit.runs).toHaveLength(0);
    expect(kit.reports[0]?.reason).toContain("already carries 1");
  });

  it("says so when the index has never seen the passport somebody asked about", async () => {
    const kit = kitchen({ pending: [id("9")] });
    await onePass(kit.deps);
    expect(kit.runs).toHaveLength(0);
    expect(kit.reports[0]?.reason).toContain("not in the index");
  });

  it("carries on with the next passport when one of them throws", async () => {
    const kit = kitchen({ sweep: [row(PICTURE), row(ASKED)] });
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
    const kit = kitchen({
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

  it("carries on with the sweep when the queue itself is unreachable", async () => {
    const kit = kitchen({ queueFails: true, sweep: [row(PICTURE)] });
    const summary = await onePass(kit.deps);
    expect(summary.ran).toBe(1);
    expect(kit.lines.join(" ")).toContain("could not read the request queue");
  });
});

describe("a passport registered sealed and published since", () => {
  it("is re-checked with the same command as a public one once its unseal record exists", async () => {
    const kit = kitchen({ pending: [SEALED], rows: [row(SEALED)], record: () => ({ kind: "found" }) });
    const summary = await onePass(kit.deps);

    expect(kit.lookups).toEqual([SEALED]);
    expect(summary.done).toBe(1);
    expect(kit.runs[0]).toMatchObject({ txHash: row(SEALED).txHash, eventIndex: 0, broadcast: true });
    expect(kit.lines.join(" ")).toContain("published the picture since");
  });

  it("is picked up by the sweep too", async () => {
    const kit = kitchen({ sweep: [row(SEALED)], record: () => ({ kind: "found" }) });
    const summary = await onePass(kit.deps);
    expect(summary.ran).toBe(1);
  });

  it("is refused as sealed when the service has no record for it", async () => {
    const kit = kitchen({ pending: [SEALED], rows: [row(SEALED)], record: () => ({ kind: "none" }) });
    await onePass(kit.deps);
    expect(kit.runs).toHaveLength(0);
    expect(kit.reports[0]?.reason).toContain("is sealed, so there is no published picture");
    expect(kit.state().recent[SEALED]).toBeDefined();
  });

  it("is refused when the record served for it names another passport", async () => {
    const kit = kitchen({ pending: [SEALED], rows: [row(SEALED)], record: () => ({ kind: "mismatch" }) });
    await onePass(kit.deps);
    expect(kit.runs).toHaveLength(0);
    expect(kit.reports[0]?.reason).toContain("names another passport");
  });

  it("is tried again later, spending nothing, when the lookup timed out or answered 500", async () => {
    for (const reason of ["the unseal record lookup did not answer within 10 seconds", "the unseal record lookup answered status 500"]) {
      const kit = kitchen({ pending: [SEALED], rows: [row(SEALED)], sweep: [row(SEALED)], record: () => ({ kind: "failed", reason }) });
      const summary = await onePass(kit.deps);

      expect(kit.runs).toHaveLength(0);
      expect(summary.ran).toBe(0);
      expect(kit.reports).toHaveLength(0);
      expect(kit.state().reports).toBe(0);
      expect(kit.state().failures).toBe(0);
      expect(kit.state().recent[SEALED]).toBeUndefined();
      expect(kit.lines.join(" ")).toContain("trying again next pass");
      expect(kit.lines.join(" ")).not.toContain("is sealed, so there is no published picture");
    }
  });

  it("never asks for a record when the document is public", async () => {
    const kit = kitchen({ sweep: [row(PICTURE)] });
    await onePass(kit.deps);
    expect(kit.lookups).toHaveLength(0);
  });
});

describe("the guards", () => {
  it("stops before the first run when the day's cap is used up", async () => {
    const kit = kitchen({
      sweep: [row(PICTURE)],
      state: { ...emptyState("2026-09-22"), reports: 40 },
    });
    const summary = await onePass(kit.deps);
    expect(kit.runs).toHaveLength(0);
    expect(summary.stopped).toContain("daily cap");
  });

  it("counts a broadcast run against the cap before it happens", async () => {
    const kit = kitchen({ sweep: [row(PICTURE)] });
    await onePass(kit.deps);
    expect(kit.state().reports).toBe(1);
  });

  it("stops halfway through a pass when the cap runs out mid-way", async () => {
    const kit = kitchen({
      env: { RUNNER_MAX_REPORTS_PER_DAY: "1" },
      sweep: [row(PICTURE), row(ASKED)],
    });
    const summary = await onePass(kit.deps);
    expect(kit.runs).toHaveLength(1);
    expect(summary.stopped).toContain("daily cap");
  });

  it("stops when the CRE wallet is under the floor, and does not mark the passport handled", async () => {
    const kit = kitchen({ sweep: [row(PICTURE)], balance: 1_400_000_000_000_000_000n });
    const summary = await onePass(kit.deps);
    expect(kit.runs).toHaveLength(0);
    expect(summary.stopped).toContain("under the floor");
    expect(kit.state().recent[PICTURE]).toBeUndefined();
  });

  it("backs off after three failures in a row", async () => {
    const kit = kitchen({
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
    const kit = kitchen({
      sweep: [row(PICTURE)],
      state: { ...emptyState("2026-09-22"), failures: 3, backoffUntil: Math.floor(NOW / 1000) + 600 },
    });
    const summary = await onePass(kit.deps);
    expect(kit.runs).toHaveLength(0);
    expect(summary.stopped).toContain("backing off");
  });

  it("clears the failure count as soon as a run succeeds", async () => {
    const kit = kitchen({ sweep: [row(PICTURE)], state: { ...emptyState("2026-09-22"), failures: 2 } });
    await onePass(kit.deps);
    expect(kit.state().failures).toBe(0);
  });

  it("leaves a passport it has just handled alone for the cooldown", async () => {
    const kit = kitchen({
      sweep: [row(PICTURE)],
      state: noteRecent(emptyState("2026-09-22"), PICTURE, NOW - 60_000),
    });
    const summary = await onePass(kit.deps);
    expect(summary.considered).toBe(0);
    expect(kit.runs).toHaveLength(0);
  });

  it("carries the ten minute timeout into every run", async () => {
    const kit = kitchen({ sweep: [row(PICTURE)] });
    await onePass(kit.deps);
    expect(kit.runs[0]?.timeoutMs).toBe(600_000);
  });

  it("never asks for more than one pass worth of passports", async () => {
    const many = ["1", "2", "3", "4", "5", "6", "7"].map((letter) => row(id(letter)));
    const kit = kitchen({ sweep: many, env: { RUNNER_MAX_PER_PASS: "2" } });
    const summary = await onePass(kit.deps);
    expect(summary.considered).toBe(2);
  });
});

describe("dry-run mode", () => {
  it("runs the simulator with the broadcast flag off and reports nothing back", async () => {
    const kit = kitchen({ env: { RUNNER_DRY_RUN: "1" }, pending: [ASKED], rows: [row(ASKED)] });
    const summary = await onePass(kit.deps);

    expect(kit.runs[0]?.broadcast).toBe(false);
    expect(kit.reports).toHaveLength(0);
    expect(summary.ran).toBe(1);
  });

  it("spends nothing from the day's cap", async () => {
    const kit = kitchen({ env: { RUNNER_DRY_RUN: "1" }, sweep: [row(PICTURE)] });
    await onePass(kit.deps);
    expect(kit.state().reports).toBe(0);
  });

  it("says what it would have done, one passport at a time", async () => {
    const kit = kitchen({ env: { RUNNER_DRY_RUN: "1" }, sweep: [row(PICTURE)] });
    await onePass(kit.deps);
    expect(kit.lines.join("\n")).toContain("dry run: passport 0xaaaaaaaaaa would be re-checked");
  });
});

describe("a passport asking for a private re-check", () => {
  const SEALED_DIR = "moolam-sealed-verifier";

  it("is routed to the sealed workflow folder, and a public passport is not", async () => {
    const kit = kitchen({ sweep: [row(PRIVATE), row(PICTURE)] });
    const summary = await onePass(kit.deps);

    expect(summary.ran).toBe(2);
    expect(path.basename(kit.runs[0]?.workflowDir ?? "")).toBe(SEALED_DIR);
    expect(path.basename(kit.runs[1]?.workflowDir ?? "")).toBe("moolam-verifier");
    expect(kit.lookups).toHaveLength(0);
  });

  it("goes on when the copy is kept: a request, then a claim, then the simulator, then the release", async () => {
    const kit = kitchen({ sweep: [row(PRIVATE)], copy: "kept" });
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

  it("does not ask for a second request when the passport came off the queue already claimed", async () => {
    const kit = kitchen({ pending: [PRIVATE], rows: [row(PRIVATE)] });
    await onePass(kit.deps);
    expect(kit.calls).toEqual([`claim ${PRIVATE}`, `status ${PRIVATE}`, `simulate ${SEALED_DIR}`, `done ${PRIVATE}`]);
  });

  it("treats a copy that is gone exactly as a plain sealed passport: refused, nothing spent", async () => {
    const kit = kitchen({ pending: [PRIVATE], rows: [row(PRIVATE)], copy: "gone" });
    const summary = await onePass(kit.deps);

    expect(kit.runs).toHaveLength(0);
    expect(summary.ran).toBe(0);
    expect(kit.lookups).toEqual([PRIVATE]);
    expect(kit.reports[0]?.reason).toContain("is sealed, so there is no published picture to re-check");
    expect(kit.state().reports).toBe(0);
    expect(kit.calls).not.toContain(`request ${PRIVATE}`);
  });

  it("re-checks a gone copy's passport publicly when its holder has published the picture since", async () => {
    const kit = kitchen({ sweep: [row(PRIVATE)], copy: "gone", record: () => ({ kind: "found" }) });
    await onePass(kit.deps);
    expect(path.basename(kit.runs[0]?.workflowDir ?? "")).toBe("moolam-verifier");
    expect(kit.calls).not.toContain(`request ${PRIVATE}`);
  });

  it("tries again later when the copy's state is unknown, spending nothing and claiming nothing", async () => {
    const kit = kitchen({ sweep: [row(PRIVATE)], copy: "unknown" });
    const summary = await onePass(kit.deps);

    expect(kit.runs).toHaveLength(0);
    expect(summary.ran).toBe(0);
    expect(kit.calls).toEqual([`status ${PRIVATE}`]);
    expect(kit.state().reports).toBe(0);
    expect(kit.state().failures).toBe(0);
    expect(kit.state().recent[PRIVATE]).toBeUndefined();
    expect(kit.lines.join(" ")).toContain("trying again next pass");
  });

  it("refuses with a named reason when the env file carries no CRE_SEALED_LINK_TOKEN, before any request", async () => {
    const kit = kitchen({ pending: [PRIVATE], rows: [row(PRIVATE)], token: null });
    await onePass(kit.deps);

    expect(kit.runs).toHaveLength(0);
    expect(kit.calls).not.toContain(`request ${PRIVATE}`);
    expect(kit.state().reports).toBe(0);
    expect(kit.reports[0]?.reason).toContain("has no CRE_SEALED_LINK_TOKEN");
  });

  it("refuses when the queue reads the copy as gone, and runs nothing when the claim is taken", async () => {
    const sealed = kitchen({ sweep: [row(PRIVATE)], placed: "sealed" });
    await onePass(sealed.deps);
    expect(sealed.runs).toHaveLength(0);
    expect(sealed.calls).not.toContain(`claim ${PRIVATE}`);
    expect(sealed.lines.join(" ")).toContain("reads its private copy as gone");

    const taken = kitchen({ sweep: [row(PRIVATE)], claim: () => "taken" });
    await onePass(taken.deps);
    expect(taken.runs).toHaveLength(0);
    expect(taken.reports).toHaveLength(0);
    expect(taken.state().reports).toBe(0);
  });

  it("releases the claim through /recheck/done when the run fails", async () => {
    const kit = kitchen({
      sweep: [row(PRIVATE)],
      simulate: () => ({ ok: false, reason: "the private copy fetch returned status 403", printed: "cre ..." }),
    });
    await onePass(kit.deps);
    expect(kit.reports).toEqual([{ passportId: PRIVATE, reason: "the private copy fetch returned status 403" }]);
  });

  it("releases the claim when the simulator cannot even be started", async () => {
    const kit = kitchen({ sweep: [row(PRIVATE)] });
    kit.deps.simulate = async () => {
      throw new Error("spawn cre ENOENT");
    };
    await onePass(kit.deps);
    expect(kit.reports).toEqual([{ passportId: PRIVATE, reason: "the simulation could not be run" }]);
    expect(kit.lines.join(" ")).toContain("could not be handled");
  });

  it("releases the claim in a dry run too, and spends nothing", async () => {
    const kit = kitchen({
      env: { RUNNER_DRY_RUN: "1" },
      sweep: [row(PRIVATE)],
      simulate: () => ({ ok: true, recomputed: "0x1f1bc103fbef6f47", distance: 2, matched: true, printed: "cre ..." }),
    });
    await onePass(kit.deps);

    expect(kit.runs[0]?.broadcast).toBe(false);
    expect(kit.reports).toEqual([{ passportId: PRIVATE, reason: "a dry run, so nothing was written", matched: true, distance: 2 }]);
    expect(kit.state().reports).toBe(0);
  });

  it("posts a reason with no download link, no service address and no token in it (B5)", async () => {
    const link =
      "https://lavender-personal-grasshopper-978.mypinata.cloud/files/bafkreigwx2?X-Algorithm=PINATA1&X-Date=1790000000&X-Expires=120&X-Method=GET&X-Signature=9c1f0a";
    const line = `✗ failed: GET ${link} errored after verify.example/sealed/link answered with token ${SEALED_TOKEN}; retry X-Signature=9c1f0a against https://verify.example/sealed/link`;
    const kit = kitchen({ sweep: [row(PRIVATE)] });
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
