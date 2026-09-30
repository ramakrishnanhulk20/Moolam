import path from "node:path";
import { pathToFileURL } from "node:url";

/** A setup step that stopped on purpose, before anything was spent or written. Its message is safe to print. */
export class Refusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Refusal";
  }
}

/** Whether the module at `moduleUrl` is the file tsx was asked to run, so importing a script from a test runs nothing. */
export function invokedDirectly(moduleUrl: string): boolean {
  const entry = process.argv[1];
  return entry !== undefined && pathToFileURL(path.resolve(entry)).href === moduleUrl;
}

/**
 * One line for a failure, built only from fields known to hold no secret. A viem error's full text
 * can carry the RPC address, and a paid RPC address carries its API key, so only its short message
 * is kept; the kit's errors never carry a key by its own promise.
 */
export function failureLine(error: unknown): string {
  if (error instanceof Refusal) return `Refused: ${error.message}`;
  if (typeof error === "object" && error !== null) {
    const { name, code, shortMessage, message } = error as { name?: unknown; code?: unknown; shortMessage?: unknown; message?: unknown };
    if (name === "MoolamPlatformError" && typeof code === "string" && typeof message === "string") return `Failed (${code}): ${message}`;
    if (name === "EnvError" && typeof message === "string") return `Failed: ${message}`;
    if (typeof shortMessage === "string") return `Failed: ${shortMessage}`;
    if (typeof name === "string") return `Failed with ${name}; nothing more is printed in case the details hold a secret`;
  }
  return "Failed; nothing more is printed in case the details hold a secret";
}

/** Runs a script's main and turns any failure into one safe line and a non-zero exit. */
export function runCli(main: () => Promise<void>): void {
  main().catch((error: unknown) => {
    console.error(failureLine(error));
    process.exitCode = 1;
  });
}
