import { spawn } from "node:child_process";
import path from "node:path";
import { cut } from "./net.js";
import { isTxHash } from "./queue.js";

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
  /** Values that must not survive into a reason, the sealed link token among them. Never printed. */
  scrub?: string[];
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
// A failed run's reason is posted to the verify service, which serves it on a public status route.
// The CLI prints whole endpoint addresses in some lines, the RPC health check with its provider key
// among them, so no address and no bearer value leaves this process inside a reason.
const ADDRESS = /\b[a-z][a-z0-9+.-]*:\/\/\S+/gi;
const BEARER = /\bbearer\s+\S+/gi;
// The parameters of a signed private download link, caught even where a line carries the query
// without the address in front of it.
const SIGNED_QUERY = /\bX-(Algorithm|Date|Expires|Method|Signature)=[^\s&]*/gi;

/**
 * A line with every address, bearer value and signed link parameter taken out, and every value in
 * `scrub` too: the sealed link token, and the verify service's host where it appears without a
 * scheme. Used on every reason before it is logged or posted to the queue's public status.
 */
export function redact(line: string, scrub: readonly string[] = []): string {
  let clean = line
    .replace(ADDRESS, "[address removed]")
    .replace(BEARER, "Bearer [removed]")
    .replace(SIGNED_QUERY, "[signature removed]");
  // Longest first, so a value is removed whole before a shorter one inside it can split it.
  for (const value of [...scrub].sort((left, right) => right.length - left.length)) {
    if (value !== "") {
      clean = clean.split(value).join("[removed]");
    }
  }
  return clean;
}

/**
 * A value shorter than this is a number, a switch or a short word, never a key or a token, and
 * scrubbing it would eat ordinary words and numbers out of every reason.
 */
const SHORTEST_SECRET = 8;

/**
 * Every form in which one of these values could turn up in a line, for redact to remove (R11).
 *
 * The value itself, and for an address also the address without its scheme, its host, and every
 * path segment, query value, user and password of eight characters or more, which is where RPC
 * providers put their keys. It does not cover a value shorter than eight characters, or a value
 * printed in another encoding, such as base64 or split across two lines.
 */
export function scrubList(values: readonly string[]): string[] {
  const forms = new Set<string>();
  for (const raw of values) {
    const value = raw.trim();
    forms.add(value);
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
      continue;
    }
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      continue;
    }
    forms.add(value.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").replace(/\/+$/, ""));
    forms.add(url.host);
    for (const part of [...url.pathname.split("/"), ...url.searchParams.values(), url.username, url.password]) {
      forms.add(decodeSafely(part));
    }
  }
  return [...forms].filter((form) => form.length >= SHORTEST_SECRET);
}

function decodeSafely(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}

/**
 * The highest event index handed to the CLI. A registration's log sits at 0, or at 1 when it went
 * through the ERC-4337 entry point (chain.ts), so a thousand is far past any real registration and
 * still keeps the value a small whole number.
 */
export const MAX_EVENT_INDEX = 1_000;

/**
 * No leading dash, so the CLI's flag parser cannot read the value as a flag of its own, and no
 * control character, so a line break cannot smuggle a second value into a log or a reason. Spaces
 * are allowed: the argv goes to spawn with no shell, and a path may hold one.
 */
const PLAIN_ARGUMENT = /^[^-\x00-\x1f\x7f][^\x00-\x1f\x7f]*$/;

/**
 * Why this request must not reach the CLI, or null when every argv value has its shape (R8). The
 * tx hash goes through the queue's own predicate, the event index must be a small whole number,
 * and the target, the env file and the workflow folder's name must be plain arguments. The reason
 * names which value failed and never repeats it.
 */
export function argvProblem(request: SimulateRequest): string | null {
  if (!isTxHash(request.txHash)) {
    return "the transaction hash is not 0x and 64 hex digits";
  }
  if (!Number.isSafeInteger(request.eventIndex) || request.eventIndex < 0 || request.eventIndex > MAX_EVENT_INDEX) {
    return `the event index is not a whole number from 0 to ${MAX_EVENT_INDEX}`;
  }
  const plain: [string, string][] = [
    ["target", request.target],
    ["env file", request.envFile],
    ["workflow folder", path.basename(path.resolve(request.workflowDir))],
  ];
  for (const [name, value] of plain) {
    if (!PLAIN_ARGUMENT.test(value)) {
      return `the ${name} is empty, starts with a dash or holds a control character`;
    }
  }
  return null;
}

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
export function parseSimulation(
  output: string,
  scrub: readonly string[] = [],
): {
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
    trouble: troubles.length === 0 ? null : redact(troubles.at(-1) ?? "", scrub),
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
  const problem = argvProblem(request);
  if (problem !== null) {
    return { ok: false, reason: `the simulation was not run: ${problem}`, printed: "" };
  }
  const command = simulateCommand(request);
  const result = await exec(command, request.timeoutMs);
  const parsed = parseSimulation(result.output, request.scrub);

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
