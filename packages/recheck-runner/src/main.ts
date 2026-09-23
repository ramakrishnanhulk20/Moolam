import { ConfigError, formatMon, readConfig, type Config } from "./config.js";
import { balanceWei, eventIndex, rpcCall } from "./chain.js";
import { readDocument } from "./document.js";
import { indexClient } from "./index-read.js";
import { queueClient } from "./queue.js";
import { runSimulation } from "./simulate.js";
import { loadState, saveState, type RunnerState } from "./state.js";
import { message, onePass, type Deps } from "./runner.js";

function log(line: string): void {
  process.stdout.write(`${new Date().toISOString()} ${line}\n`);
}

/**
 * What the runner is holding, by name only.
 *
 * An operator has to be able to see which env file the CRE CLI was pointed at and which caps are
 * in force without any value from that file reaching journald. The token, the CRE wallet's key and
 * everything in the env file stay where they are.
 */
function opening(config: Config): string {
  return [
    `interval ${config.intervalSeconds}s`,
    `at most ${config.maxPerPass} a pass`,
    `daily cap ${config.maxReportsPerDay}`,
    `MON floor ${formatMon(config.minMonWei)}`,
    `workflow ${config.workflowDir}`,
    `sealed workflow ${config.sealedWorkflowDir}`,
    `env file ${config.envFile}`,
    `target ${config.target}`,
    `state ${config.statePath}`,
    config.dryRun ? "DRY RUN, nothing will be broadcast" : "live, reports will be broadcast",
  ].join(", ");
}

function build(config: Config): Deps {
  const call = rpcCall(config.rpcUrl);
  let state: RunnerState = loadState(config.statePath, Date.now());

  return {
    config,
    queue: queueClient(config.verifyServiceUrl, config.runnerToken),
    index: indexClient(config.envioUrl),
    readDocument: (metadataURI) => readDocument(metadataURI, config.gatewayUrl),
    eventIndex: (txHash, passportId) => eventIndex(call, txHash, passportId, config.registry),
    balanceWei: () => balanceWei(call, config.creWallet),
    simulate: (request) => runSimulation(request),
    readState: () => state,
    writeState: (next) => {
      state = next;
      saveState(config.statePath, next);
    },
    log,
    now: () => Date.now(),
  };
}

async function main(): Promise<void> {
  let config: Config;
  try {
    config = readConfig();
  } catch (error) {
    log(error instanceof ConfigError ? error.message : `the configuration is wrong: ${message(error)}`);
    process.exitCode = 1;
    return;
  }

  log(`moolam re-check runner starting: ${opening(config)}`);
  const deps = build(config);
  const once = process.argv.includes("--once");

  let stopping = false;
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      if (stopping) {
        process.exit(1);
      }
      stopping = true;
      log(`${signal} received, stopping after this pass`);
    });
  }

  while (!stopping) {
    try {
      const summary = await onePass(deps);
      log(
        `pass finished: ${summary.considered} considered, ${summary.ran} run, ${summary.done} done, ${summary.failed} failed`,
      );
    } catch (error) {
      log(`the pass failed outright: ${message(error)}`);
    }
    if (once || stopping) {
      break;
    }
    await sleep(config.intervalSeconds * 1000);
  }

  log("stopped");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

await main();
