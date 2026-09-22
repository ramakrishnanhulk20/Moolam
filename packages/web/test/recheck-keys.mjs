import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Counts every string this order added, in every language file there is.
 *
 * Run it with `node test/recheck-keys.mjs` from packages/web. It prints one
 * line per key with the number of languages that say it, and exits 1 if any
 * line is not ten. The same list is asserted in test/recheck-copy.test.ts, so
 * the suite fails too; this is the version a person can read the output of.
 */

const MESSAGES = fileURLToPath(new URL("../messages/", import.meta.url));

const locales = readdirSync(MESSAGES)
  .filter((name) => name.endsWith(".json"))
  .map((name) => name.replace(".json", ""));

const CONTROL = [
  "button",
  "again",
  "checkNow",
  "note",
  "sending",
  "queued",
  "queuedWaiting",
  "already",
  "alreadyWaiting",
  "running",
  "done",
  "doneNoTime",
  "openTx",
  "failed",
  "failedNoReason",
  "stopped",
];

const STAMP = ["sending", "queued", "running", "done", "failed"];

const FAILURE = ["noPassport", "sealed", "queueFull", "rateLimited", "notAnswering", "unknown"];

export const RECHECK_KEYS = [
  ...CONTROL.map((key) => `recheck.${key}`),
  ...STAMP.map((key) => `recheck.stamp.${key}`),
  ...FAILURE.map((key) => `recheck.failure.${key}`),
];

/** The placeholders a sentence cannot be translated without. */
export const RECHECK_PLACEHOLDERS = {
  "recheck.queued": ["{at}", "{position}"],
  "recheck.queuedWaiting": ["{at}"],
  "recheck.already": ["{at}", "{position}"],
  "recheck.alreadyWaiting": ["{at}"],
  "recheck.done": ["{at}"],
  "recheck.openTx": ["{hash}"],
  "recheck.failed": ["{reason}"],
};

export function saidIn(locale, path) {
  const value = valueAt(locale, path);
  return typeof value === "string" && value.trim().length > 0;
}

export function valueAt(locale, path) {
  const tree = JSON.parse(readFileSync(`${MESSAGES}${locale}.json`, "utf8"));
  return path.split(".").reduce((node, key) => (node === undefined ? undefined : node[key]), tree);
}

export function countsBySaying() {
  return RECHECK_KEYS.map((path) => ({
    path,
    count: locales.filter((locale) => saidIn(locale, path)).length,
  }));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const counts = countsBySaying();
  for (const { path, count } of counts) {
    console.log(`${count}  ${path}`);
  }
  const short = counts.filter((row) => row.count !== 10);
  console.log(`\n${counts.length} keys, ${locales.length} languages: ${locales.join(" ")}`);
  if (short.length > 0) {
    console.log(`not said in ten: ${short.map((row) => row.path).join(", ")}`);
    process.exit(1);
  }
  console.log("every key is said ten times");
}
