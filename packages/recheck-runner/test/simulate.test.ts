import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  lastLines,
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

describe("the shape of every value handed to the CLI (R8)", () => {
  const malformed: [string, Partial<SimulateRequest>][] = [
    ["a flag in place of the tx hash", { txHash: "--broadcast" }],
    ["a short tx hash", { txHash: "0x40ae6d62" }],
    ["a tx hash with a flag after it", { txHash: `${request.txHash} --broadcast` }],
    ["a tx hash with no 0x", { txHash: request.txHash.slice(2) }],
    ["a negative event index", { eventIndex: -1 }],
    ["a fractional event index", { eventIndex: 1.5 }],
    ["an event index that is not a number", { eventIndex: Number.NaN }],
    ["an event index no transaction has", { eventIndex: 1_000_000 }],
    ["a flag as the target", { target: "--broadcast" }],
    ["a flag as the env file", { envFile: "--broadcast" }],
    ["a line break in the env file", { envFile: "/etc/moolam/runner.env\n--broadcast" }],
    ["a workflow folder named like a flag", { workflowDir: "/srv/moolam/packages/workflow/--broadcast" }],
  ];

  it.each(malformed)("refuses %s without starting the CLI", async (_name, change) => {
    let started = false;
    const result = await runSimulation({ ...request, broadcast: false, ...change }, async () => {
      started = true;
      return { output: DRY_RUN, code: 0, timedOut: false };
    });
    expect(started).toBe(false);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("was not run");
  });

  it("still starts the CLI for well formed values", async () => {
    let started = false;
    const result = await runSimulation({ ...request, broadcast: false, eventIndex: 1 }, async () => {
      started = true;
      return { output: DRY_RUN, code: 0, timedOut: false };
    });
    expect(started).toBe(true);
    expect(result.ok).toBe(true);
  });
});

describe("the gas limit every report is sent with", () => {
  // The mock forwarder calls the receiver with whatever gas is left, so a limit estimated by the
  // node starves the receiver and the report is refused inside a transaction that still succeeds.
  // The real reports 0x085d8500... and 0xdc1834ea... were both sent with a limit of exactly
  // 1,000,000. The CLI's simulate command has no flag that changes it, and the runner adds none.
  it.each(["moolam-verifier", "moolam-sealed-verifier"])("is written into %s as an explicit 1,000,000 on every write", (folder) => {
    const source = fs.readFileSync(path.resolve(HERE, "../../workflow", folder, "workflow.ts"), "utf8");
    expect(source).toContain('const GAS_LIMIT = "1000000";');
    const writes = source.split(".writeReport(").length - 1;
    expect(writes).toBeGreaterThan(0);
    expect(source.split("gasConfig: { gasLimit: GAS_LIMIT }").length - 1).toBe(writes);
  });

  it("is never replaced by anything on the command line the runner builds", () => {
    const command = simulateCommand(request);
    expect(command.args.join(" ")).not.toMatch(/gas|estimate/i);
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

  it("never carries an endpoint address or a bearer value into the reason it hands on", () => {
    const parsed = parseSimulation(
      [
        "RPC health check failed for https://example-name.monad-mainnet.quiknode.pro/5ecre7k3y/ (status 401)",
        "fetch error: GET https://gw.mypinata.cloud/files/bafy?X-Algorithm=PINATA1&X-Signature=abc failed with Bearer eyJhbGciOi.secret",
      ].join("\n"),
    );
    expect(parsed.trouble).toContain("failed with Bearer [removed]");
    expect(parsed.trouble).toContain("[address removed]");
    for (const leaked of ["quiknode", "5ecre7k3y", "mypinata", "X-Signature", "eyJhbGciOi"]) {
      expect(parsed.trouble).not.toContain(leaked);
    }
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

describe("the CLI's last lines on a failed broadcast run", () => {
  const OUTPUT = [
    "\u001b[32m✓ Workflow compiled\u001b[0m",
    "RPC health check failed for https://user:pa55word@example-name.monad-mainnet.quiknode.pro/5ecre7k3y/path?key=abc (status 401)",
    "sending to wss://example-name.monad-mainnet.quiknode.pro/5ecre7k3y/ws with Bearer eyJhbGciOi.secret",
    "╰──────────╯",
    "",
    "fetch ipfs://bafkreiharbour answered X-Signature=9c1f0a and token sealed-link-token-4f1b9c0e77d2a6",
    "✗ failed to broadcast the report",
  ].join("\r\n");

  it("keeps the last lines that say something, with every address cut to its origin and every secret removed", () => {
    const lines = lastLines(OUTPUT, ["sealed-link-token-4f1b9c0e77d2a6"]);
    expect(lines).toHaveLength(5);
    expect(lines[0]).toBe("✓ Workflow compiled");
    expect(lines.at(-1)).toBe("✗ failed to broadcast the report");
    expect(lines[1]).toContain("https://example-name.monad-mainnet.quiknode.pro (status 401)");
    expect(lines[2]).toContain("wss://example-name.monad-mainnet.quiknode.pro with Bearer [removed]");
    const joined = lines.join("\n");
    for (const leaked of ["5ecre7k3y", "pa55word", "key=abc", "eyJhbGciOi", "9c1f0a", "sealed-link-token", "bafkreiharbour", "\u001b"]) {
      expect(joined).not.toContain(leaked);
    }
  });

  it("rides on a failed broadcast run and never on its reason", async () => {
    const result = await runSimulation({ ...request, scrub: ["sealed-link-token-4f1b9c0e77d2a6"] }, exec({ output: OUTPUT, code: 1 }));
    expect(result.ok).toBe(false);
    expect(result.lastLines?.at(-1)).toBe("✗ failed to broadcast the report");
    expect(result.reason).toBe("✗ failed to broadcast the report");
  });

  it("is not there when a run wrote its report", async () => {
    const result = await runSimulation(request, exec({ output: BROADCAST }));
    expect(result.lastLines).toBeUndefined();
  });
});
