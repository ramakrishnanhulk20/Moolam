/**
 * What Lighthouse sees on every judge-facing page, in one table.
 *
 * Runs the lighthouse CLI once per page per profile against a real Chrome, and
 * prints the four numbers a judge feels plus the script weight behind them:
 * the performance score, LCP, total blocking time, CLS, the JavaScript actually
 * transferred over the wire, and the three heaviest scripts on that page.
 *
 * Lighthouse is not a dependency of the app. It is fetched by npx for the run
 * and nothing is added to package.json.
 *
 *   node packages/web/scripts/perf/lighthouse.mjs --base http://localhost:3311
 *   node packages/web/scripts/perf/lighthouse.mjs --base https://moolam.site --profile desktop
 *
 * Options: --base, --profile (mobile | desktop | both), --paths (comma separated),
 * --out (write the table to a file as well as the screen), --json (keep the raw
 * reports in this directory), --port (the debugging port for the browser it
 * opens), --runs (loads per page, the middle one is reported, three by
 * default).
 */

import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PASSPORT = "0xcdb25d3755452efa3b746f168cf9cefd3a1b693ab2b81d260a2d64f13d771638";

const DEFAULT_PATHS = [
  "/en",
  "/en/verify",
  "/en/studio",
  "/en/explore",
  `/en/passport/${PASSPORT}`,
  "/en/agent/10249",
  "/en/docs",
];

const CHROMES = [
  process.env.CHROME_PATH,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "/usr/bin/google-chrome",
];

const args = readArgs(process.argv.slice(2));
const base = (args.base ?? "http://localhost:3311").replace(/\/$/, "");
const profiles = args.profile === undefined || args.profile === "both" ? ["mobile", "desktop"] : [args.profile];
const paths = args.paths === undefined || args.paths === "" ? DEFAULT_PATHS : args.paths.split(",");
const runs = Number(args.runs ?? 3);
const chrome = CHROMES.find((path) => path !== undefined && existsSync(path));

const work = await mkdtemp(join(tmpdir(), "moolam-lh-"));
if (args.json !== undefined && args.json !== "") {
  await mkdir(args.json, { recursive: true });
}

// Lighthouse would rather start its own Chrome for every page. On Windows it
// then fails to delete the profile it made and takes the run down with it, so
// one browser is opened here and every page is measured through its debugging
// port. It is also a good deal faster than thirty cold starts.
const remote = Number(args.port ?? 9455);
const browser = spawn(
  chrome ?? "chrome",
  [
    "--headless=new",
    `--remote-debugging-port=${remote}`,
    `--user-data-dir=${join(work, "profile")}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--mute-audio",
    "about:blank",
  ],
  { stdio: "ignore" },
);
await waitForPort(remote);

const lines = [];
const say = (line) => {
  lines.push(line);
  console.log(line);
};

try {
  for (const profile of profiles) {
    say("");
    say(`profile    ${profile}    base ${base}`);
    say(`${pad("page", 46)}${pad("score", 7)}${pad("LCP", 9)}${pad("TBT", 8)}${pad("CLS", 7)}${pad("JS", 9)}top scripts`);
    for (const path of paths) {
      const report = await median(`${base}${path}`, profile);
      const shown = path.length > 44 ? `${path.slice(0, 22)}...${path.slice(-19)}` : path;
      say(
        pad(shown, 46) +
          pad(report.score, 7) +
          pad(`${report.lcp} ms`, 9) +
          pad(`${report.tbt} ms`, 8) +
          pad(report.cls, 7) +
          pad(`${report.js} kB`, 9) +
          report.top.join(", "),
      );
    }
  }
  if (args.out !== undefined && args.out !== "") {
    await writeFile(args.out, `${lines.join("\n")}\n`, "utf8");
  }
} finally {
  browser.kill();
  await rm(work, { recursive: true, force: true }).catch(() => undefined);
}

/** Waits until the browser answers on its debugging port. */
async function waitForPort(on) {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    try {
      const answer = await fetch(`http://127.0.0.1:${on}/json/version`);
      if (answer.ok) {
        return;
      }
    } catch {
      // The browser has not opened its port yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("the browser never opened its debugging port");
}

/**
 * One page, measured several times, reported as the middle run.
 *
 * A single Lighthouse run on this machine swings by a factor of two between
 * loads of the same build, so a before and after taken one run each would be
 * measuring the machine's mood. The runs are sorted by score and the middle one
 * is reported whole, so the numbers on a line all belong to the same load.
 */
async function median(url, profile) {
  const reports = [];
  for (let attempt = 0; attempt < runs; attempt += 1) {
    reports.push(await measure(url, profile));
  }
  reports.sort((a, b) => a.score - b.score);
  return reports[Math.floor(reports.length / 2)];
}

async function measure(url, profile) {
  const file = join(work, `${profile}-${Math.random().toString(36).slice(2)}.json`);
  const flags = [
    "--yes",
    "lighthouse@12.8.2",
    url,
    "--only-categories=performance",
    "--output=json",
    `--output-path=${file}`,
    "--quiet",
    `--port=${remote}`,
    // A page here waits on the chain and the index, and the mobile profile puts
    // that behind a throttled connection, so the default half minute is not
    // always enough to reach a quiet network.
    "--max-wait-for-load=60000",
  ];
  if (profile === "desktop") {
    flags.push("--preset=desktop");
  }

  // On Windows the launcher often cannot delete its own temporary profile and
  // exits 1. Sometimes that happens after the report is written, sometimes
  // instead of writing it. The report on disk is the thing that decides whether
  // the run worked, and a run lost that way is worth one more try.
  const env = { ...process.env, CHROME_PATH: chrome ?? process.env.CHROME_PATH };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await run("npx", flags, env);
      break;
    } catch (problem) {
      if (existsSync(file)) {
        break;
      }
      if (attempt === 1) {
        throw problem;
      }
    }
  }

  const raw = JSON.parse(await readFile(file, "utf8"));
  if (args.json !== undefined && args.json !== "") {
    const name = `${profile}${new URL(url).pathname.replace(/\//g, "-")}.json`;
    await writeFile(join(args.json, name), JSON.stringify(raw), "utf8");
  }

  const audit = (id) => raw.audits?.[id]?.numericValue ?? 0;
  const scripts = (raw.audits?.["network-requests"]?.details?.items ?? []).filter(
    (item) => item.resourceType === "Script",
  );
  const bytes = scripts.reduce((total, item) => total + (item.transferSize ?? 0), 0);
  const top = [...scripts]
    .sort((a, b) => (b.transferSize ?? 0) - (a.transferSize ?? 0))
    .slice(0, 3)
    .map((item) => `${shortName(item.url)} ${Math.round((item.transferSize ?? 0) / 1024)}k`);

  return {
    score: Math.round((raw.categories?.performance?.score ?? 0) * 100),
    lcp: Math.round(audit("largest-contentful-paint")),
    tbt: Math.round(audit("total-blocking-time")),
    cls: audit("cumulative-layout-shift").toFixed(3),
    js: Math.round(bytes / 1024),
    top,
  };
}

function shortName(url) {
  const name = new URL(url).pathname.split("/").pop() ?? url;
  return name.length > 22 ? `${name.slice(0, 19)}...` : name;
}

function run(command, list, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, list, { stdio: ["ignore", "ignore", "inherit"], shell: true, env });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`))));
  });
}

function pad(value, width) {
  const text = String(value);
  return text.length >= width ? `${text} ` : text + " ".repeat(width - text.length);
}

function readArgs(list) {
  const out = {};
  for (let index = 0; index < list.length; index += 1) {
    if (!list[index].startsWith("--")) {
      continue;
    }
    const next = list[index + 1];
    out[list[index].slice(2)] = next === undefined || next.startsWith("--") ? "" : next;
  }
  return out;
}
