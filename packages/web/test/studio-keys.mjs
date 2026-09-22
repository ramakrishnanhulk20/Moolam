import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Counts the words the studio's status band added, in every language file there
 * is.
 *
 * Run it with `node test/studio-keys.mjs` from packages/web. It prints one line
 * per key with the number of languages that say it, and exits 1 if any line is
 * not ten. The same list is asserted in test/studio-band.test.ts, so the suite
 * fails too; this is the version a person can read the output of.
 */

const MESSAGES = fileURLToPath(new URL("../messages/", import.meta.url));

const locales = readdirSync(MESSAGES)
  .filter((name) => name.endsWith(".json"))
  .map((name) => name.replace(".json", ""));

export const STUDIO_KEYS = [
  // The chip on the band, both faces of it: the sealed one was already said in
  // ten, and the band needed the other half of the pair.
  "studio.sealed.plate.public",
  "studio.sealed.plate.sealed",
];

export function valueAt(locale, path) {
  const tree = JSON.parse(readFileSync(`${MESSAGES}${locale}.json`, "utf8"));
  return path.split(".").reduce((node, key) => (node === undefined ? undefined : node[key]), tree);
}

export function saidIn(locale, path) {
  const value = valueAt(locale, path);
  return typeof value === "string" && value.trim().length > 0;
}

export function countsBySaying() {
  return STUDIO_KEYS.map((path) => ({
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
