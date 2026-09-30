// The setup steps that need no chain: wallet.ts refusing to overwrite a key, and sign-onboarding.ts
// signing the typed data the operator's platform-add.ts message step really prints (run here as a
// child process) into signatures the verify service's own recordProblem accepts, and refusing typed
// data that names another wallet, another agent or another domain.
// What this file does not cover: the operator's add step, which writes platforms.json and is never
// run here, and the CLI wrappers that read packages/dreamloom/.env.local (never opened here). Every
// env file below is a throwaway in the system's temporary folder.

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import type { Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readTypedDataFile, signOnboarding } from "../scripts/sign-onboarding";
import { createWallet } from "../scripts/wallet";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..");
const VERIFIER = path.join(REPO, "packages", "verifier");
const TSX_CLI = path.join(REPO, "node_modules", "tsx", "dist", "cli.mjs");
const AGENT_ID = "4242";
const ORIGIN = "https://dreamloom.example.com";

let workDir: string;

beforeAll(() => {
  workDir = mkdtempSync(path.join(tmpdir(), "dreamloom-refusals-"));
});

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe("wallet.ts", () => {
  it("fills a blank line in place and keeps every other line", () => {
    const envFile = path.join(workDir, "blank.env");
    writeFileSync(envFile, "MOOLAM_SITE_URL=https://moolam.vercel.app\nDREAMLOOM_WALLET_KEY=\nMONAD_RPC_URL=http://127.0.0.1:8545\n");
    const { address } = createWallet({ envFile });
    const lines = readFileSync(envFile, "utf8").trimEnd().split("\n");
    expect(lines[0]).toBe("MOOLAM_SITE_URL=https://moolam.vercel.app");
    expect(lines[2]).toBe("MONAD_RPC_URL=http://127.0.0.1:8545");
    const key = (parseEnv(readFileSync(envFile, "utf8")) as Record<string, string>).DREAMLOOM_WALLET_KEY as Hex;
    expect(privateKeyToAccount(key).address).toBe(address);
  });

  it("refuses to overwrite a key that is already there, leaving the file byte for byte", () => {
    const envFile = path.join(workDir, "set.env");
    const before = `DREAMLOOM_WALLET_KEY=${generatePrivateKey()}\nDREAMLOOM_AGENT_ID=7\n`;
    writeFileSync(envFile, before);
    expect(() => createWallet({ envFile })).toThrow(/DREAMLOOM_WALLET_KEY is already set/);
    expect(readFileSync(envFile, "utf8")).toBe(before);
  });
});

describe("sign-onboarding.ts", () => {
  const walletKey = generatePrivateKey();
  const wallet = privateKeyToAccount(walletKey).address;
  let typedData: Record<string, unknown>;

  beforeAll(() => {
    const printed = spawnSync(
      process.execPath,
      [
        TSX_CLI,
        "scripts/platform-add.ts",
        "message",
        ...["--name", "Dreamloom", "--agent-id", AGENT_ID, "--owner", wallet, "--creator", wallet],
        ...["--valid-from", String(Math.floor(Date.now() / 1000)), "--origin", ORIGIN],
      ],
      { cwd: VERIFIER, encoding: "utf8", timeout: 120_000 },
    );
    const lines = printed.stdout.split(/\r?\n/);
    const start = lines.findIndex((line) => line.startsWith("Typed data"));
    if (printed.status !== 0 || start === -1) throw new Error(`platform-add.ts message failed: ${printed.stderr}`);
    // Only the JSON block is kept, exactly what the runbook tells the operator to save; the platform
    // key printed above it never reaches the file.
    const file = path.join(workDir, "typed-data.json");
    writeFileSync(file, lines.slice(start + 1).join("\n"));
    typedData = readTypedDataFile(file) as Record<string, unknown>;
  });

  it("signs the operator's typed data as owner and creator, and the verify service accepts both", async () => {
    const signed = await signOnboarding({ typedData, walletKey, agentId: AGENT_ID });
    const message = typedData.message as Record<string, unknown>;
    const record = {
      name: signed.name,
      agentId: signed.agentId,
      ownerAtOnboarding: wallet,
      creatorWallet: wallet,
      keyHash: signed.keyHash,
      origins: signed.origins,
      validFrom: Number(signed.validFrom),
      acceptedAt: Math.floor(Date.now() / 1000),
      ownerSignature: signed.ownerSignature,
      creatorSignature: signed.creatorSignature,
    };
    expect(record).toMatchObject({ name: "Dreamloom", agentId: AGENT_ID, origins: [ORIGIN], keyHash: message.keyHash });

    const code =
      'import { platformRecordSchema, recordProblem } from "./src/platforms/platforms.ts";' +
      "recordProblem(platformRecordSchema.parse(JSON.parse(process.env.RECORD))).then((problem) => console.log(JSON.stringify({ problem })));";
    const checked = spawnSync(process.execPath, [TSX_CLI, "--eval", code], {
      cwd: VERIFIER,
      env: { ...process.env, RECORD: JSON.stringify(record) },
      encoding: "utf8",
      timeout: 120_000,
    });
    expect(JSON.parse(checked.stdout.trim().split("\n").at(-1) ?? "null")).toEqual({ problem: null });
  });

  it("refuses typed data that names another wallet in either role", async () => {
    const other = privateKeyToAccount(generatePrivateKey()).address;
    const message = typedData.message as Record<string, unknown>;
    for (const [field, pattern] of [
      ["agentOwner", /agentOwner is/],
      ["creatorWallet", /creatorWallet is/],
    ] as const) {
      await expect(signOnboarding({ typedData: { ...typedData, message: { ...message, [field]: other } }, walletKey, agentId: AGENT_ID })).rejects.toThrow(pattern);
    }
  });

  it("refuses another agent, another domain, other types and anything that is not the printed JSON", async () => {
    const message = typedData.message as Record<string, unknown>;
    const domain = typedData.domain as Record<string, unknown>;
    const refused: [unknown, RegExp][] = [
      [{ ...typedData, message: { ...message, agentId: "1" } }, /agentId is 1/],
      [{ ...typedData, domain: { ...domain, chainId: 1 } }, /domain\.chainId/],
      [{ ...typedData, domain: { ...domain, verifyingContract: wallet } }, /domain/],
      [{ ...typedData, types: { PlatformOnboarding: [{ name: "name", type: "string" }] } }, /types/],
      [{ ...typedData, message: { ...message, extra: "1" } }, /message/],
    ];
    for (const [candidate, pattern] of refused) {
      await expect(signOnboarding({ typedData: candidate, walletKey, agentId: AGENT_ID })).rejects.toThrow(pattern);
    }
    const whole = path.join(workDir, "whole-output.txt");
    writeFileSync(whole, `Platform key, shown once.\n  ${"ab".repeat(32)}\n${JSON.stringify(typedData)}`);
    expect(() => readTypedDataFile(whole)).toThrow(/not JSON/);
  });
});
