import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Counts every word the phone bar says, in every language file there is.
 *
 * Run it with `node test/shell-keys.mjs` from packages/web. It prints one line
 * per key with the number of languages that say it, and exits 1 if any line is
 * not ten. The same list is asserted in test/phone-bar.test.ts, so the suite
 * fails too; this is the version a person can read the output of.
 */

const MESSAGES = fileURLToPath(new URL("../messages/", import.meta.url));

const locales = readdirSync(MESSAGES)
  .filter((name) => name.endsWith(".json"))
  .map((name) => name.replace(".json", ""));

/** The five words under the marks, and what a screen reader calls the bar. */
export const SHELL_KEYS = [
  "shell.label",
  ...["home", "explore", "make", "verify", "mine"].map((key) => `shell.tabs.${key}`),
];

/**
 * The keys the menu button owned and nothing else does. They leave the ten
 * files with the button itself.
 */
export const GONE_KEYS = ["header.menu", "header.menuClose"];

export function valueAt(locale, path) {
  const tree = JSON.parse(readFileSync(`${MESSAGES}${locale}.json`, "utf8"));
  return path.split(".").reduce((node, key) => (node === undefined ? undefined : node[key]), tree);
}

export function saidIn(locale, path) {
  const value = valueAt(locale, path);
  return typeof value === "string" && value.trim().length > 0;
}

export function countsBySaying(keys = SHELL_KEYS) {
  return keys.map((path) => ({
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
  const left = countsBySaying(GONE_KEYS).filter((row) => row.count !== 0);
  console.log(`\n${counts.length} keys, ${locales.length} languages: ${locales.join(" ")}`);
  if (short.length > 0) {
    console.log(`not said in ten: ${short.map((row) => row.path).join(", ")}`);
  }
  if (left.length > 0) {
    console.log(`the menu button's keys are still in some files: ${left.map((row) => row.path).join(", ")}`);
  }
  if (short.length > 0 || left.length > 0) {
    process.exit(1);
  }
  console.log("every word is said ten times, and the menu button's keys are gone");
}
