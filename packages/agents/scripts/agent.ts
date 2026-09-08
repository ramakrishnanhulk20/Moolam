import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runAgent } from "../src/agent/run.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..", "..");
const TRANSCRIPT_FILE = join(REPO_ROOT, "kitchen", "reports", "WO-7-transcript.txt");

const USAGE = [
  "Usage:",
  '  npm run agent -- "a cinematic poster of a lighthouse in a storm, film grain"',
  "  npm run agent -- --verify path/to/file.jpg",
].join("\n");

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === "--help") {
    console.log(USAGE);
    return;
  }

  const verifying = argv[0] === "--verify";
  const rest = verifying ? argv.slice(1) : argv;
  const value = rest.join(" ").trim();
  if (value.length === 0) {
    throw new Error(verifying ? `--verify needs a file path.\n${USAGE}` : USAGE);
  }

  const started = new Date().toISOString();
  const run = await runAgent(verifying ? { verifyFile: value } : { prompt: value });

  await mkdir(dirname(TRANSCRIPT_FILE), { recursive: true });
  const header = `=== ${verifying ? "verify" : "generate"} run, ${started} ===`;
  await appendFile(TRANSCRIPT_FILE, `${[header, ...run.transcript, ""].join("\n")}\n`, "utf8");
  console.log();
  console.log(`Transcript appended to ${TRANSCRIPT_FILE}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
