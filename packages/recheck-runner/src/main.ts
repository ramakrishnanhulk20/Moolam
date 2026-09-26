import { ConfigError, formatMon, readConfig, type Config } from "./config.js";
import { attestationLanded, balanceWei, eventIndex, rpcCall } from "./chain.js";
import { readDocument } from "./document.js";
import { indexClient } from "./index-read.js";
import { queueClient } from "./queue.js";
import { redact, runSimulation } from "./simulate.js";
import { loadState, saveState, type RunnerState } from "./state.js";
import { message, onePass, openingState, secretValues, type Deps } from "./runner.js";

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
    ...(config.resetBreaker ? ["RUNNER_RESET_BREAKER set"] : []),
  ].join(", ");
}

function build(config: Config): Deps {
  const call = rpcCall(config.rpcUrl);
  let state: RunnerState = openingState(loadState(config.statePath, Date.now()), config, log);
  saveState(config.statePath, state);

  return {
    config,
    queue: queueClient(config.verifyServiceUrl, config.runnerToken),
    index: indexClient(config.envioUrl),
    readDocument: (metadataURI) => readDocument(metadataURI, config.gatewayUrl),
    eventIndex: (txHash, passportId) => eventIndex(call, txHash, passportId, config.registry),
    reportLanded: (reportTx, passportId) => attestationLanded(call, reportTx, passportId, config.registry),
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
  const once = process.argv.includes("--once");

  // The pass reads this between passports and before any claim, so a stop never starts new work
  // and a run already sending finishes and hands back. The unit sends the signal to this process
  // alone and waits longer than one run can take (deploy/moolam-recheck-runner.service).
  let stopping = false;
  let wake: () => void = () => {};
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      if (stopping) {
        process.exit(1);
      }
      stopping = true;
      log(`${signal} received, stopping once the passport in hand is finished`);
      wake();
    });
  }
  const deps: Deps = { ...build(config), stopping: () => stopping };

  while (!stopping) {
    try {
      const summary = await onePass(deps);
      log(
        `pass finished: ${summary.considered} considered, ${summary.ran} run, ${summary.done} done, ${summary.failed} failed, ${summary.answered} answered from memory`,
      );
    } catch (error) {
      log(`the pass failed outright: ${redact(message(error), secretValues(config))}`);
    }
    if (once || stopping) {
      break;
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, config.intervalSeconds * 1000);
      wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }

  log("stopped");
}

await main();
