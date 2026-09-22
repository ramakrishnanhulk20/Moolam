import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  parseSimulation,
  runSimulation,
  simulateCommand,
  spawnExec,
  type Exec,
  type SimulateRequest,
} from "../src/simulate.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

function fixture(name: string): string {
  return fs.readFileSync(path.join(HERE, "fixtures", name), "utf8");
}

/** The real output of a run with no --broadcast, captured on this machine on 2026-09-22. */
const DRY_RUN = fixture("simulate-dry-run.txt");
/** The lines a broadcast run printed on 2026-09-17, as the launch script recorded them. */
const BROADCAST = fixture("simulate-broadcast.txt");
/** A real failure: the trigger pointed at the wrong log of a four-log transaction. */
const FAILED = fixture("simulate-failed.txt");

const request: SimulateRequest = {
  workflowDir: "/srv/moolam/packages/workflow/moolam-verifier",
  envFile: "/etc/moolam/runner.env",
  target: "monad-mainnet",
  txHash: "0x40ae6d620c35eeb6e36b68d188d9960294bb210abadca86fd58c71209b7b05e3",
  eventIndex: 0,
  broadcast: true,
  timeoutMs: 600_000,
};

function exec(result: { output: string; code?: number | null; timedOut?: boolean }): Exec {
  return async () => ({ output: result.output, code: result.code ?? 0, timedOut: result.timedOut ?? false });
}

describe("the command the runner builds", () => {
  it("is the one the launch scripts run, from the workflow's parent folder", () => {
    const command = simulateCommand(request);
    expect(command.command).toBe("cre");
    expect(command.args).toEqual([
      "workflow",
      "simulate",
      "moolam-verifier",
      "--target",
      "monad-mainnet",
      "--non-interactive",
      "--trigger-index",
      "0",
      "--evm-tx-hash",
      request.txHash,
      "--evm-event-index",
      "0",
      "-e",
      "/etc/moolam/runner.env",
      "--broadcast",
    ]);
    expect(path.basename(command.cwd)).toBe("workflow");
  });

  it("never carries --broadcast in dry-run mode", () => {
    const command = simulateCommand({ ...request, broadcast: false });
    expect(command.args).not.toContain("--broadcast");
    expect(command.printed).not.toContain("--broadcast");
  });

  it("passes the event index the receipt gave, not always zero", () => {
    expect(simulateCommand({ ...request, eventIndex: 1 }).args).toContain("1");
  });
});

describe("reading what the simulator printed", () => {
  it("takes the report transaction and the verdict out of a broadcast run", () => {
    const parsed = parseSimulation(BROADCAST);
    expect(parsed.reportTx).toBe("0x085d8500ab86dc1f9028d8375b92e5b4b569d83d5f3c96c32e38679e5b6a3602");
    expect(parsed.recomputed).toBe("0x63779c989c7f3121");
    expect(parsed.distance).toBe(0);
    expect(parsed.matched).toBe(true);
  });

  it("reads the zero hash a dry run prints as no transaction at all", () => {
    const parsed = parseSimulation(DRY_RUN);
    expect(parsed.reportTx).toBeNull();
    expect(parsed.recomputed).toBe("0x63779c989c7f3121");
    expect(parsed.distance).toBe(0);
    expect(parsed.matched).toBe(true);
  });

  it("finds the CLI's own complaint when a run failed", () => {
    const parsed = parseSimulation(FAILED);
    expect(parsed.reportTx).toBeNull();
    expect(parsed.matched).toBeUndefined();
    expect(parsed.trouble).toContain("log does not match registered filter");
  });
});

describe("one run", () => {
  it("is done when a broadcast run wrote a report", async () => {
    const result = await runSimulation(request, exec({ output: BROADCAST }));
    expect(result.ok).toBe(true);
    expect(result.reportTx).toBe("0x085d8500ab86dc1f9028d8375b92e5b4b569d83d5f3c96c32e38679e5b6a3602");
    expect(result.distance).toBe(0);
  });

  it("is a failure when a broadcast run produced only the zero hash", async () => {
    const result = await runSimulation(request, exec({ output: DRY_RUN }));
    expect(result.ok).toBe(false);
    expect(result.reportTx).toBeUndefined();
    expect(result.reason).toBeDefined();
  });

  it("is done when a dry run reached a verdict, even with nothing written", async () => {
    const result = await runSimulation({ ...request, broadcast: false }, exec({ output: DRY_RUN }));
    expect(result.ok).toBe(true);
    expect(result.reportTx).toBeUndefined();
    expect(result.matched).toBe(true);
  });

  it("carries the CLI's own words as the reason, cut short", async () => {
    const result = await runSimulation(request, exec({ output: FAILED, code: 1 }));
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("log does not match registered filter");
    expect((result.reason ?? "").length).toBeLessThanOrEqual(200);
  });

  it("says so when a run was stopped for running too long", async () => {
    const result = await runSimulation(
      { ...request, timeoutMs: 600_000 },
      exec({ output: "", code: null, timedOut: true }),
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("600 seconds");
  });

  it("only ever reports lines it recognised, never the whole output", async () => {
    const noisy = `${FAILED}\nCRE_ETH_PRIVATE_KEY=0x${"c".repeat(64)}\n`;
    const result = await runSimulation({ ...request, broadcast: false }, exec({ output: noisy, code: 1 }));
    expect(result.reason ?? "").not.toContain("c".repeat(64));
  });
});

describe("the timeout, against a real child process", () => {
  it("kills a command that outlives it", async () => {
    const started = Date.now();
    const result = await spawnExec(
      {
        command: process.execPath,
        args: ["-e", "setTimeout(() => {}, 30000)"],
        cwd: HERE,
        printed: "a command that will not finish",
      },
      1_500,
    );
    expect(result.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(15_000);
  }, 20_000);

  it("reports a CLI that is not on the PATH rather than hanging", async () => {
    const result = await spawnExec(
      {
        command: "moolam-no-such-binary",
        args: [],
        cwd: HERE,
        printed: "a command that does not exist",
      },
      5_000,
    );
    expect(result.timedOut).toBe(false);
    expect(result.output).toContain("failed to start the CRE CLI");
  }, 20_000);
});
