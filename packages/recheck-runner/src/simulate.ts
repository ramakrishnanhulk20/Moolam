import { spawn } from "node:child_process";
import path from "node:path";
import { cut } from "./net.js";

export interface SimulateRequest {
  /** The folder holding workflow.yaml. Its parent is the working directory the CLI is run from. */
  workflowDir: string;
  envFile: string;
  target: string;
  txHash: string;
  eventIndex: number;
  /** False in dry-run mode, which is the only thing that keeps --broadcast off the command line. */
  broadcast: boolean;
  timeoutMs: number;
}

export interface Command {
  command: string;
  args: string[];
  cwd: string;
  /** The command as one line, for a log. It names the env file's path and never its contents. */
  printed: string;
}

export interface ExecResult {
  output: string;
  code: number | null;
  timedOut: boolean;
}

export type Exec = (command: Command, timeoutMs: number) => Promise<ExecResult>;

export interface SimulateResult {
  ok: boolean;
  /** Present only on a broadcast run that wrote a report. */
  reportTx?: string;
  recomputed?: string;
  distance?: number;
  matched?: boolean;
  reason?: string;
  printed: string;
}

/** The all-zero hash a run with no --broadcast prints where a report transaction would be. */
const NO_TX = `0x${"0".repeat(64)}`;

const REPORT_TX = /report tx (0x[0-9a-fA-F]{64})/g;
const VERDICT = /recomputed (0x[0-9a-fA-F]{16}) distance (\d+) matched (true|false)/g;
const TROUBLE = /(^✗.*$)|(^.*\b(panic|revert(ed)?|error|failed)\b.*$)/gim;

/**
 * The exact command the launch scripts run, built rather than pasted together.
 *
 * The CLI takes the workflow folder as a path relative to its working directory, which is what the
 * runbook means by running it from packages/workflow. In dry-run mode --broadcast is absent, and
 * that single difference is the whole of the safety: the simulator then prepares the write and
 * prints the zero hash instead of sending anything.
 */
export function simulateCommand(request: SimulateRequest): Command {
  const folder = path.resolve(request.workflowDir);
  const args = [
    "workflow",
    "simulate",
    path.basename(folder),
    "--target",
    request.target,
    "--non-interactive",
    "--trigger-index",
    "0",
    "--evm-tx-hash",
    request.txHash,
    "--evm-event-index",
    String(request.eventIndex),
    "-e",
    request.envFile,
  ];
  if (request.broadcast) {
    args.push("--broadcast");
  }
  const cwd = path.dirname(folder);
  return { command: "cre", args, cwd, printed: `cre ${args.join(" ")}` };
}

/**
 * What the simulator's output says happened.
 *
 * Only lines that match one of the three patterns below ever leave this function, so nothing the
 * CLI happened to print can be carried into a log by accident. The zero report hash is treated as
 * no transaction at all, which is exactly what a run without --broadcast produces.
 */
export function parseSimulation(output: string): {
  reportTx: string | null;
  recomputed?: string;
  distance?: number;
  matched?: boolean;
  trouble: string | null;
} {
  const hashes = [...output.matchAll(REPORT_TX)].map((found) => (found[1] ?? "").toLowerCase());
  const last = hashes.at(-1) ?? null;
  const verdicts = [...output.matchAll(VERDICT)];
  const verdict = verdicts.at(-1);
  const troubles = [...output.matchAll(TROUBLE)].map((found) => found[0].trim());

  return {
    reportTx: last === null || last === NO_TX ? null : last,
    ...(verdict === undefined
      ? {}
      : {
          recomputed: (verdict[1] ?? "").toLowerCase(),
          distance: Number(verdict[2]),
          matched: verdict[3] === "true",
        }),
    trouble: troubles.at(-1) ?? null,
  };
}

/**
 * One simulation run.
 *
 * A broadcast run has to end with a report transaction; a dry run has to end with the verdict and
 * the zero hash. Anything else is a failure carrying the CLI's own last complaint, cut short, so
 * the reason a judge could be shown is the machine's words rather than ours.
 */
export async function runSimulation(
  request: SimulateRequest,
  exec: Exec = spawnExec,
): Promise<SimulateResult> {
  const command = simulateCommand(request);
  const result = await exec(command, request.timeoutMs);
  const parsed = parseSimulation(result.output);

  const verdict = {
    ...(parsed.recomputed === undefined ? {} : { recomputed: parsed.recomputed }),
    ...(parsed.distance === undefined ? {} : { distance: parsed.distance }),
    ...(parsed.matched === undefined ? {} : { matched: parsed.matched }),
  };

  if (result.timedOut) {
    return {
      ok: false,
      ...verdict,
      reason: `the simulation was still running after ${Math.round(request.timeoutMs / 1000)} seconds and was stopped`,
      printed: command.printed,
    };
  }

  if (request.broadcast) {
    if (parsed.reportTx !== null) {
      return { ok: true, reportTx: parsed.reportTx, ...verdict, printed: command.printed };
    }
    return {
      ok: false,
      ...verdict,
      reason: cut(parsed.trouble ?? "the run wrote no report transaction", 200),
      printed: command.printed,
    };
  }

  if (result.code === 0 && parsed.matched !== undefined) {
    return { ok: true, ...verdict, printed: command.printed };
  }
  return {
    ok: false,
    ...verdict,
    reason: cut(parsed.trouble ?? `the CLI exited ${result.code ?? "on a signal"}`, 200),
    printed: command.printed,
  };
}

/**
 * The CLI as a child process, with the timeout that stops a run that has hung.
 *
 * Both streams are kept because the CLI writes its progress to one and its complaints to the
 * other, and the parser needs to see a failure wherever it landed.
 */
export const spawnExec: Exec = (command, timeoutMs) =>
  new Promise<ExecResult>((resolve) => {
    // No shell. The arguments carry a passport's transaction hash and a file path, and a shell
    // would be one quoting mistake away from running something else with them.
    const child = spawn(command.command, command.args, { cwd: command.cwd, windowsHide: true });

    let output = "";
    let timedOut = false;
    const keep = (chunk: Buffer): void => {
      output += chunk.toString();
    };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.on("error", (error: Error) => {
      clearTimeout(timer);
      resolve({ output: `${output}\nfailed to start the CRE CLI: ${error.message}`, code: null, timedOut });
    });

    child.on("close", (code: number | null) => {
      clearTimeout(timer);
      resolve({ output, code, timedOut });
    });
  });
