// Proves the server-only RPC address never reaches a browser.
//
// Build the app with a canary address in MONAD_RPC_URL, start it, then run this. It reads every
// file a browser can fetch out of the build, and every page below as the browser gets it, and
// fails if any of them holds a piece of the canary. It also prints what each page rendered, so a
// clean run cannot be a run against six empty pages.
//
// Usage:
//   node scripts/leak-check.mjs --dist .next-wo84 --base http://localhost:3419 \
//     --needle TOKEN-CANARY-7f3a --needle leak-canary
//
// This checks the text a browser receives. It does not check what the server writes to its own
// logs, and it cannot see an address that is stored somewhere and printed by a later release.

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const PAGES = [
  "/en",
  "/en/explore",
  "/en/passport/0xcdb25d3755452efa3b746f168cf9cefd3a1b693ab2b81d260a2d64f13d771638",
  "/en/agent/10249",
  "/en/resolve",
  "/en/studio",
];

function options(argv) {
  const dist = [];
  const base = [];
  const needles = [];
  for (let at = 0; at < argv.length; at += 1) {
    if (argv[at] === "--dist") dist.push(argv[at + 1]);
    if (argv[at] === "--base") base.push(argv[at + 1]);
    if (argv[at] === "--needle") needles.push(argv[at + 1]);
  }
  return {
    dist: dist[0] ?? ".next-wo84",
    base: base[0] ?? "http://localhost:3419",
    needles: needles.length > 0 ? needles : ["TOKEN-CANARY-7f3a", "leak-canary"],
  };
}

function filesUnder(root) {
  const found = [];
  const walk = (at) => {
    for (const entry of readdirSync(at)) {
      const full = path.join(at, entry);
      if (statSync(full).isDirectory()) walk(full);
      else found.push(full);
    }
  };
  try {
    walk(root);
  } catch {
    return [];
  }
  return found;
}

function hits(text, needles) {
  return needles.filter((needle) => text.includes(needle));
}

/** What a page rendered, in enough detail that an empty page cannot pass as a full one. */
function summarise(html) {
  const title = /<title>([^<]*)<\/title>/.exec(html)?.[1] ?? "no title";
  const ids = new Set(html.match(/0x[0-9a-f]{64}/g) ?? []);
  const addresses = new Set(html.match(/0x[0-9a-fA-F]{40}/g) ?? []);
  return `${(html.length / 1024).toFixed(0)} KB, title "${title}", ${ids.size} passport ids, ${addresses.size} wallet addresses`;
}

const { dist, base, needles } = options(process.argv.slice(2));
let failed = false;

const served = [...filesUnder(path.join(dist, "static")), ...filesUnder("public")];
const leakedFiles = [];
for (const file of served) {
  const found = hits(readFileSync(file, "latin1"), needles);
  if (found.length > 0) leakedFiles.push(`${file}: ${found.join(", ")}`);
}
console.log(`files a browser can fetch: ${served.length} checked under ${dist}/static and public`);
if (leakedFiles.length === 0) {
  console.log("  no hit for any needle");
} else {
  failed = true;
  for (const line of leakedFiles) console.log(`  LEAK ${line}`);
}

for (const page of PAGES) {
  const response = await fetch(`${base}${page}`, { headers: { "accept-language": "en" } });
  const body = await response.text();
  const found = hits(body, needles);
  console.log(`${page} -> ${response.status}, ${summarise(body)}`);
  if (found.length === 0) {
    console.log("  no hit for any needle");
  } else {
    failed = true;
    console.log(`  LEAK ${found.join(", ")}`);
  }
}

console.log(failed ? "FAILED: the canary reached a browser" : "PASSED: the canary reached no browser");
process.exit(failed ? 1 : 0);
