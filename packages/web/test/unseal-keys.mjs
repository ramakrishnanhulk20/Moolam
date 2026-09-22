import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Counts every string this order added, in every language file there is.
 *
 * Run it with `node test/unseal-keys.mjs` from packages/web. It prints one line
 * per key with the number of languages that say it, and exits 1 if any line is
 * not ten. The same list is asserted in test/unseal-copy.test.ts, so the suite
 * fails too; this is the version a person can read the output of.
 */

const MESSAGES = fileURLToPath(new URL("../messages/", import.meta.url));

const locales = readdirSync(MESSAGES)
  .filter((name) => name.endsWith(".json"))
  .map((name) => name.replace(".json", ""));

const PANEL = [
  "kicker",
  "heading",
  "body",
  "permanent",
  "choose",
  "chooseAnother",
  "checking",
  "matched",
  "matchedLine",
  "publish",
  "sending",
  "allowance",
];

const DONE = ["label", "body", "at", "image", "thumbnail", "manifest", "record", "check"];

const FAILURE = [
  "notTheFile",
  "fingerprintMismatch",
  "notHolder",
  "noPassport",
  "notSealed",
  "alreadyUnsealed",
  "thumbnailTooLarge",
  "quota",
  "todayFull",
  "pinFailed",
  "recordPinFailed",
  "dependencyDown",
  "lookupUnavailable",
  "busy",
  "signedOut",
  "notAnImage",
  "tooLarge",
  "empty",
  "unreadable",
  "rateLimited",
  "badRequest",
  "badResponse",
  "offline",
  "fileMissing",
  "unknown",
];

const ACTIONS = ["again", "chooseAgain", "later", "signIn", "showPicture"];

export const UNSEAL_KEYS = [
  ...PANEL.map((key) => `passport.unseal.${key}`),
  ...DONE.map((key) => `passport.unseal.done.${key}`),
  ...FAILURE.map((key) => `passport.unseal.failure.${key}`),
  ...ACTIONS.map((key) => `passport.unseal.actions.${key}`),
  ...["poster", "label", "line"].map((key) => `passport.unsealed.${key}`),
  "verify.unsealed.matched",
];

export function said(locale, path) {
  const tree = JSON.parse(readFileSync(`${MESSAGES}${locale}.json`, "utf8"));
  const value = path.split(".").reduce((node, key) => (node === undefined ? undefined : node[key]), tree);
  return typeof value === "string" && value.trim().length > 0;
}

export function countsBySaying() {
  return UNSEAL_KEYS.map((path) => ({
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
