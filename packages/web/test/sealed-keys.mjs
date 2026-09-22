import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Counts every string this order added, in every language file there is.
 *
 * Run it with `node test/sealed-keys.mjs` from packages/web. It prints one line
 * per key with the number of languages that say it, and exits 1 if any line is
 * not ten. The same list is asserted in test/sealed-copy.test.ts, so the suite
 * fails too; this is the version a person can read the output of.
 */

const MESSAGES = fileURLToPath(new URL("../messages/", import.meta.url));

const locales = readdirSync(MESSAGES)
  .filter((name) => name.endsWith(".json"))
  .map((name) => name.replace(".json", ""));

const FIELDS = [
  "commitment",
  "fingerprint",
  "name",
  "description",
  "creator",
  "generator",
  "createdAt",
  "training",
  "sealed",
  "model",
  "prompt",
];

export const SEALED_KEYS = [
  ...[
    "label",
    "note",
    "panelHeading",
    "panelLine",
    "sketchCaption",
    "inFile",
    "onChain",
    "leftOut",
    "promptLabel",
    "promptNote",
  ].map((key) => `studio.sealed.switch.${key}`),
  ...FIELDS.flatMap((field) => [
    `studio.sealed.fields.${field}.label`,
    `studio.sealed.fields.${field}.line`,
  ]),
  ...["sealed", "untitled", "line", "registered"].map((key) => `studio.sealed.plate.${key}`),
  ...["kicker", "heading", "body", "save", "saved", "only"].map((key) => `studio.sealed.handback.${key}`),
  ...["label", "body"].map((key) => `studio.sealed.done.${key}`),
  ...["label", "detail", "fingerprintDetail"].map((key) => `studio.sealed.receipt.${key}`),
  ...["sealedMismatch", "sealedNotHeld", "sealedRecordRefused", "sealedFileRefused"].map(
    (key) => `studio.failure.${key}`,
  ),
];

export function said(locale, path) {
  const tree = JSON.parse(readFileSync(`${MESSAGES}${locale}.json`, "utf8"));
  const value = path.split(".").reduce((node, key) => (node === undefined ? undefined : node[key]), tree);
  return typeof value === "string" && value.trim().length > 0;
}

export function countsBySaying() {
  return SEALED_KEYS.map((path) => ({
    path,
    count: locales.filter((locale) => said(locale, path)).length,
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
