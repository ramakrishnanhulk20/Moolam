/**
 * Everything the runner needs, read from the environment and nowhere else.
 *
 * No value read here is ever logged. The startup line prints the names that were set and the
 * numbers that bound the run, because an operator has to be able to see which file the CRE CLI
 * was pointed at without the file's contents reaching a log.
 */
export interface Config {
  /** The verify service that holds the request queue, with no trailing slash. */
  verifyServiceUrl: string;
  runnerToken: string;
  envioUrl: string;
  /** A public Monad RPC is enough: the runner only reads balances and receipts. */
  rpcUrl: string;
  /** Where an ipfs:// metadata address is fetched from, with a trailing slash. */
  gatewayUrl: string;
  registry: string;
  /** The folder holding workflow.yaml, passed to the CLI as its last path segment. */
  workflowDir: string;
  /**
   * The sealed workflow's folder, for a passport whose document asks for a private re-check. By
   * default the moolam-sealed-verifier folder beside workflowDir, so the CLI runs both from the
   * same packages/workflow project.
   */
  sealedWorkflowDir: string;
  /**
   * The env file the CLI reads for itself. The runner opens it for one thing only: to check, by
   * name, that it carries CRE_SEALED_LINK_TOKEN before a sealed run, and to strip that value out of
   * any reason it posts. No value from it is ever logged.
   */
  envFile: string;
  target: string;
  /** The wallet that pays for every report, watched against the floor below. */
  creWallet: string;
  statePath: string;
  intervalSeconds: number;
  /** How long a registration must have settled before the sweep picks it up. */
  settleSeconds: number;
  maxPerPass: number;
  maxReportsPerDay: number;
  minMonWei: bigint;
  /** How long a passport is left alone after the runner last finished with it. */
  cooldownSeconds: number;
  simulateTimeoutMs: number;
  failuresBeforeBackoff: number;
  backoffMinutes: number;
  dryRun: boolean;
}

/** The registry the workflow's own config.json names, so the two cannot drift apart silently. */
const REGISTRY = "0xa19188801E5DC93CD925884d73e4DaFc2bcb80C0";

/** The gateway in packages/workflow/moolam-verifier/config.json, which is what the workflow reads. */
const GATEWAY = "https://lavender-personal-grasshopper-978.mypinata.cloud/ipfs/";

const REQUIRED = [
  "VERIFY_SERVICE_URL",
  "RUNNER_TOKEN",
  "ENVIO_GRAPHQL_URL",
  "MONAD_RPC_URL",
  "CRE_WORKFLOW_DIR",
  "CRE_ENV_FILE",
  "CRE_WALLET_ADDRESS",
] as const;

export class ConfigError extends Error {
  readonly names: string[];

  constructor(names: string[]) {
    super(`these environment variables are missing or empty: ${names.join(", ")}`);
    this.name = "ConfigError";
    this.names = names;
  }
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const missing = REQUIRED.filter((name) => (env[name] ?? "").trim() === "");
  if (missing.length > 0) {
    throw new ConfigError([...missing]);
  }

  return {
    verifyServiceUrl: trimEnd(text(env, "VERIFY_SERVICE_URL")),
    runnerToken: text(env, "RUNNER_TOKEN"),
    envioUrl: text(env, "ENVIO_GRAPHQL_URL"),
    rpcUrl: text(env, "MONAD_RPC_URL"),
    gatewayUrl: withSlash(env.PINATA_GATEWAY_URL?.trim() || GATEWAY),
    registry: (env.MOOLAM_REGISTRY_ADDRESS?.trim() || REGISTRY).toLowerCase(),
    workflowDir: text(env, "CRE_WORKFLOW_DIR"),
    sealedWorkflowDir: env.CRE_SEALED_WORKFLOW_DIR?.trim() || besideWorkflow(text(env, "CRE_WORKFLOW_DIR")),
    envFile: text(env, "CRE_ENV_FILE"),
    target: env.CRE_WORKFLOW_TARGET?.trim() || "monad-mainnet",
    creWallet: text(env, "CRE_WALLET_ADDRESS").toLowerCase(),
    statePath: env.RUNNER_STATE_PATH?.trim() || "runner-state.json",
    intervalSeconds: count(env, "RUNNER_INTERVAL_SECONDS", 120, 10),
    settleSeconds: count(env, "RUNNER_SETTLE_SECONDS", 120, 0),
    maxPerPass: count(env, "RUNNER_MAX_PER_PASS", 5, 1),
    maxReportsPerDay: count(env, "RUNNER_MAX_REPORTS_PER_DAY", 40, 0),
    minMonWei: monToWei(env.RUNNER_MIN_MON?.trim() || "1.5"),
    cooldownSeconds: count(env, "RUNNER_COOLDOWN_SECONDS", 6 * 60 * 60, 0),
    simulateTimeoutMs: count(env, "RUNNER_SIMULATE_TIMEOUT_SECONDS", 600, 30) * 1000,
    failuresBeforeBackoff: count(env, "RUNNER_FAILURES_BEFORE_BACKOFF", 3, 1),
    backoffMinutes: count(env, "RUNNER_BACKOFF_MINUTES", 30, 1),
    dryRun: (env.RUNNER_DRY_RUN?.trim() ?? "") === "1",
  };
}

function text(env: NodeJS.ProcessEnv, name: string): string {
  return (env[name] ?? "").trim();
}

function trimEnd(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

/** The sealed workflow's folder beside the public one, by string so it keeps the caller's slashes. */
function besideWorkflow(workflowDir: string): string {
  return workflowDir.replace(/[\\/]+$/, "").replace(/[^\\/]+$/, "moolam-sealed-verifier");
}

function withSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function count(env: NodeJS.ProcessEnv, name: string, fallback: number, floor: number): number {
  const raw = (env[name] ?? "").trim();
  if (raw === "") {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < floor) {
    throw new Error(`${name} must be a whole number of at least ${floor}`);
  }
  return parsed;
}

/**
 * A MON amount written the way a person writes it, as wei.
 *
 * Done by hand on the decimal string rather than through a float, because 1.5 MON through
 * Number would come out a few wei off and a floor is a comparison that should be exact.
 */
export function monToWei(amount: string): bigint {
  const clean = amount.trim();
  if (!/^\d+(\.\d+)?$/.test(clean)) {
    throw new Error("RUNNER_MIN_MON must be a positive decimal number of MON");
  }
  const [whole = "0", fraction = ""] = clean.split(".");
  return BigInt(whole) * 10n ** 18n + BigInt(fraction.padEnd(18, "0").slice(0, 18));
}

/** Wei as MON with three decimal places, for a log line. */
export function formatMon(wei: bigint): string {
  const whole = wei / 10n ** 18n;
  const milli = (wei % 10n ** 18n) / 10n ** 15n;
  return `${whole}.${milli.toString().padStart(3, "0")}`;
}
