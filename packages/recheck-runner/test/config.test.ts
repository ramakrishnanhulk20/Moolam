import { describe, expect, it } from "vitest";
import { ConfigError, formatMon, monToWei, readConfig } from "../src/config.js";

const complete = {
  VERIFY_SERVICE_URL: "https://verify.example/",
  RUNNER_TOKEN: "a-token",
  ENVIO_GRAPHQL_URL: "https://index.example/v1/graphql",
  MONAD_RPC_URL: "https://rpc.monad.xyz",
  CRE_WORKFLOW_DIR: "/srv/moolam/packages/workflow/moolam-verifier",
  CRE_ENV_FILE: "/etc/moolam/runner.env",
  CRE_WALLET_ADDRESS: "0xC79620AF233a4434b03f6B57239F8A9E71B3C178",
} satisfies NodeJS.ProcessEnv;

describe("the runner's configuration", () => {
  it("names every variable that is missing, and nothing else", () => {
    const { VERIFY_SERVICE_URL, RUNNER_TOKEN, ...rest } = complete;
    expect(VERIFY_SERVICE_URL).not.toBe("");
    expect(RUNNER_TOKEN).not.toBe("");

    try {
      readConfig(rest);
      expect.unreachable("a configuration missing two variables should not be read");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).names).toEqual(["VERIFY_SERVICE_URL", "RUNNER_TOKEN"]);
    }
  });

  it("treats an empty variable as a missing one", () => {
    expect(() => readConfig({ ...complete, RUNNER_TOKEN: "   " })).toThrowError(/RUNNER_TOKEN/);
  });

  it("carries its documented defaults", () => {
    const config = readConfig(complete);
    expect(config.intervalSeconds).toBe(120);
    expect(config.maxReportsPerDay).toBe(40);
    expect(config.minMonWei).toBe(1_500_000_000_000_000_000n);
    expect(config.settleSeconds).toBe(120);
    expect(config.simulateTimeoutMs).toBe(600_000);
    expect(config.backoffMinutes).toBe(30);
    expect(config.failuresBeforeBackoff).toBe(3);
    expect(config.dryRun).toBe(false);
    expect(config.target).toBe("monad-mainnet");
  });

  it("finds the sealed workflow beside the public one unless told otherwise", () => {
    expect(readConfig(complete).sealedWorkflowDir).toBe("/srv/moolam/packages/workflow/moolam-sealed-verifier");
    expect(readConfig({ ...complete, CRE_WORKFLOW_DIR: "D:\\Projects\\Monad\\packages\\workflow\\moolam-verifier\\" }).sealedWorkflowDir).toBe(
      "D:\\Projects\\Monad\\packages\\workflow\\moolam-sealed-verifier",
    );
    expect(readConfig({ ...complete, CRE_SEALED_WORKFLOW_DIR: "/opt/sealed" }).sealedWorkflowDir).toBe("/opt/sealed");
  });

  it("drops a trailing slash from the service address so no route is built with two", () => {
    expect(readConfig(complete).verifyServiceUrl).toBe("https://verify.example");
  });

  it("turns dry-run mode on only for the exact value 1", () => {
    expect(readConfig({ ...complete, RUNNER_DRY_RUN: "1" }).dryRun).toBe(true);
    expect(readConfig({ ...complete, RUNNER_DRY_RUN: "true" }).dryRun).toBe(false);
    expect(readConfig({ ...complete, RUNNER_DRY_RUN: "0" }).dryRun).toBe(false);
  });

  it("refuses a cap that is not a whole number", () => {
    expect(() => readConfig({ ...complete, RUNNER_MAX_REPORTS_PER_DAY: "forty" })).toThrowError(
      /RUNNER_MAX_REPORTS_PER_DAY/,
    );
    expect(() => readConfig({ ...complete, RUNNER_INTERVAL_SECONDS: "2" })).toThrowError(/at least 10/);
  });

  it("reads a MON floor exactly, without going through a float", () => {
    expect(monToWei("1.5")).toBe(1_500_000_000_000_000_000n);
    expect(monToWei("0.102")).toBe(102_000_000_000_000_000n);
    expect(monToWei("3")).toBe(3_000_000_000_000_000_000n);
    expect(() => monToWei("-1")).toThrowError(/positive decimal/);
  });

  it("prints a balance the way a log line should read", () => {
    expect(formatMon(28_266_000_000_000_000_000n)).toBe("28.266");
    expect(formatMon(0n)).toBe("0.000");
  });
});
