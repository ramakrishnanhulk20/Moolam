import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Counts the first visit guide's words, in every language file there is.
 *
 * Run it with `node test/guide-keys.mjs` from packages/web. It prints one line
 * per key with the number of languages that say it, and exits 1 if any line is
 * not ten. The same list is asserted in test/guide-words.test.ts, so the suite
 * fails too; this is the version a person can read the output of.
 *
 * The key list is not repeated here. It comes from the guide itself, which is
 * the only place that knows what it asks for, so a key added to the walk cannot
 * be missed by this script.
 */

const MESSAGES = fileURLToPath(new URL("../messages/", import.meta.url));
const STEPS = ["check", "make", "find"];
const GUIDE_PARTS = ["dialog", "step", "next", "done", "skip", "again"];
const STEP_PARTS = ["title", "line", "action", "elsewhere"];

const locales = readdirSync(MESSAGES)
  .filter((name) => name.endsWith(".json"))
  .map((name) => name.replace(".json", ""));

export const GUIDE_KEYS = [
  ...GUIDE_PARTS.map((part) => `guide.${part}`),
  ...STEPS.flatMap((step) => STEP_PARTS.map((part) => `guide.steps.${step}.${part}`)),
];

export function valueAt(locale, path) {
  const tree = JSON.parse(readFileSync(`${MESSAGES}${locale}.json`, "utf8"));
  return path.split(".").reduce((node, key) => (node === undefined ? undefined : node[key]), tree);
}

export function saidIn(locale, path) {
  const value = valueAt(locale, path);
  return typeof value === "string" && value.trim().length > 0;
}

/** The languages that still carry the English word for a key, which is nobody's translation. */
export function untranslated(path) {
  const english = valueAt("en", path);
  return locales.filter((locale) => locale !== "en" && valueAt(locale, path) === english);
}

export function countsBySaying() {
  return GUIDE_KEYS.map((path) => ({
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
