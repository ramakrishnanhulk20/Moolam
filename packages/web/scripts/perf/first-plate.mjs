/**
 * How long a visitor waits for the first picture on the home page, measured.
 *
 * The film draws a field of registered pictures. Nothing on the page can honestly
 * say when one of them arrived except the renderer itself, so each plate reports
 * from its own onAfterRender the first frame it was drawn with a picture on it
 * (components/story/scene/drawn.ts) and leaves two performance marks behind:
 * moolam:first-plate and moolam:half-plates. This opens the page in a headless
 * Chrome, waits for those marks, and prints the median of several runs together
 * with what the wait was actually spent on: when the canvas existed, what the
 * adaptive tier decided and when, and every picture request the optimizer
 * answered, in the order they went out, with their sizes and how many were ever
 * in flight at once.
 *
 * Run it against a production build. The dev server parses unminified React and
 * optimizes every picture on demand, so its numbers belong to the dev server.
 *
 *   NEXT_DIST_DIR=.next-check npx next build
 *   NEXT_DIST_DIR=.next-check npx next start -p 3389
 *   node packages/web/scripts/perf/first-plate.mjs --url http://localhost:3389/en
 *
 * Two profiles: desktop is unthrottled at 1440x900, mobile is 375x667 with the
 * CPU slowed four times and the network held to Lighthouse's slow 4G. The
 * browser cache is off on every run, so each one is a first visit as far as the
 * browser is concerned. The optimizer's own cache on the server is not: the
 * first run of a session pays for the gateway reads and is printed on its own.
 *
 * Options: --url, --runs, --profile (desktop | mobile | both), --port,
 * --browser, --gpu, --wait (seconds to wait for the marks).
 */

import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let nextId = 1;
const waiting = new Map();

const args = readArgs(process.argv.slice(2));
const url = args.url ?? "http://localhost:3389/en";
const runs = Number(args.runs ?? 5);
const port = Number(args.port ?? 9377);
const patience = Number(args.wait ?? 45) * 1000;
const profiles = args.profile === undefined || args.profile === "" || args.profile === "both" ? ["desktop", "mobile"] : [args.profile];

/** Lighthouse's own slow 4G, with the same 0.9 and 3.75 it applies before handing it to the browser. */
const SLOW_4G = {
  latency: 150 * 3.75,
  downloadThroughput: Math.floor((1638.4 * 0.9 * 1024) / 8),
  uploadThroughput: Math.floor((675 * 0.9 * 1024) / 8),
};

const SHAPES = {
  desktop: { width: 1440, height: 900, dpr: 1, mobile: false, cpu: 1, network: null },
  mobile: { width: 375, height: 667, dpr: 2, mobile: true, cpu: 4, network: SLOW_4G },
};

const CHROMES = [
  process.env.CHROME,
  "chrome-headless-shell",
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
];

const browser =
  args.browser ?? CHROMES.find((path) => path !== undefined && (path.includes("/") ? existsSync(path) : onPath(path)));
if (browser === undefined) {
  throw new Error("no browser found: pass --browser with the path to chrome-headless-shell or Chrome");
}

const profileDir = await mkdtemp(join(tmpdir(), "moolam-plate-"));
const flags = [
  "--headless=new",
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profileDir}`,
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-extensions",
  "--mute-audio",
];
if (args.gpu === undefined) {
  flags.push("--disable-gpu");
}

const child = spawn(browser, [...flags, "about:blank"], { stdio: "ignore" });
let socket;

try {
  socket = await open(await waitForTarget());
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Network.enable");
  await send("Network.setCacheDisabled", { cacheDisabled: true });

  // The observer has to exist before the document does: the canvas and the
  // tier attribute both arrive within the first second.
  await send("Page.addScriptToEvaluateOnNewDocument", {
    source: `
      window.__film = { canvasAt: null, tiers: [] };
      (() => {
        const look = () => {
          if (window.__film.canvasAt === null && document.querySelector("canvas") !== null) {
            window.__film.canvasAt = Math.round(performance.now());
          }
          const node = document.querySelector("[data-story-tier]");
          if (node === null) {
            return;
          }
          const tier = Number(node.getAttribute("data-story-tier"));
          const last = window.__film.tiers[window.__film.tiers.length - 1];
          if (last === undefined || last.tier !== tier) {
            window.__film.tiers.push({ tier, at: Math.round(performance.now()) });
          }
        };
        new MutationObserver(look).observe(document, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ["data-story-tier"],
        });
        look();
      })();
    `,
  });

  for (const name of profiles) {
    const shape = SHAPES[name];
    if (shape === undefined) {
      throw new Error(`no such profile: ${name}`);
    }
    await send("Emulation.setDeviceMetricsOverride", {
      width: shape.width,
      height: shape.height,
      deviceScaleFactor: shape.dpr,
      mobile: shape.mobile,
    });
    await send("Emulation.setCPUThrottlingRate", { rate: shape.cpu });
    await send("Network.emulateNetworkConditions", {
      offline: false,
      latency: shape.network?.latency ?? 0,
      downloadThroughput: shape.network?.downloadThroughput ?? -1,
      uploadThroughput: shape.network?.uploadThroughput ?? -1,
    });

    const taken = [];
    for (let run = 0; run < runs; run += 1) {
      taken.push(await measure());
    }

    console.log("");
    console.log(
      `profile    ${name}   ${shape.width}x${shape.height}, cpu x${shape.cpu}, ${shape.network === null ? "network unthrottled" : "slow 4G"}${args.gpu === undefined ? ", gpu off" : ""}`,
    );
    console.log(`url        ${url}`);
    console.log(`runs       ${taken.map((one) => show(one.first)).join(", ")}   first picture`);
    console.log(`           ${taken.map((one) => show(one.half)).join(", ")}   half the field`);
    console.log(`median     first picture ${show(median(taken.map((one) => one.first)))}, half the field ${show(median(taken.map((one) => one.half)))}`);
    console.log(`cold run   first picture ${show(taken[0].first)}, half the field ${show(taken[0].half)} (the optimizer had not read these pictures yet)`);

    const last = taken[taken.length - 1];
    console.log(
      `scripts    ${last.scripts.count} of this app's own, ${Math.round(last.scripts.bytes / 1024)} kB, the last one in at ${last.scripts.last} ms`,
    );
    console.log(`canvas     ${last.canvasAt === null ? "never" : `${last.canvasAt} ms`}, tier ${last.tiers.map((step) => `${step.tier} at ${step.at} ms`).join(" then ") || "never set"}`);
    console.log(
      `pictures   ${last.images.length} asked for, ${last.concurrency} in flight at once at the most, ${Math.round(last.bytes / 1024)} kB in all, largest ${Math.round(last.largest / 1024)} kB`,
    );
    for (const image of last.images.slice(0, 8)) {
      console.log(`  ${pad(image.name, 30)}asked at ${pad(`${image.start} ms`, 10)}answered ${pad(`${image.end} ms`, 10)}${Math.round(image.size / 1024)} kB`);
    }
    if (last.images.length > 8) {
      console.log(`  ... ${last.images.length - 8} more`);
    }
  }
} finally {
  socket?.close();
  child.kill();
  await rm(profileDir, { recursive: true, force: true }).catch(() => undefined);
}

/** One load, from navigation start to the two marks the scene leaves. */
async function measure() {
  await send("Page.navigate", { url: "about:blank" });
  await wait(300);
  await send("Page.navigate", { url });

  const until = Date.now() + patience;
  let first = null;
  let half = null;
  while (Date.now() < until) {
    const marks = JSON.parse(
      await evaluate(
        `JSON.stringify({
          first: performance.getEntriesByName("moolam:first-plate")[0]?.startTime ?? null,
          half: performance.getEntriesByName("moolam:half-plates")[0]?.startTime ?? null,
        })`,
      ),
    );
    first = marks.first;
    half = marks.half;
    if (half !== null) {
      break;
    }
    await wait(100);
  }

  // One more frame's worth of slack: on the slow profile the last plate of the
  // half can land between two polls.
  await wait(200);
  const rest = JSON.parse(
    await evaluate(`JSON.stringify({
      film: window.__film,
      scripts: performance.getEntriesByType("resource")
        .filter((entry) => entry.name.includes("/_next/static/") && entry.name.endsWith(".js"))
        .reduce(
          (sum, entry) => ({
            count: sum.count + 1,
            bytes: sum.bytes + (entry.encodedBodySize || entry.transferSize || 0),
            last: Math.max(sum.last, Math.round(entry.responseEnd)),
          }),
          { count: 0, bytes: 0, last: 0 },
        ),
      images: performance.getEntriesByType("resource")
        .filter((entry) => entry.name.includes("/_next/image"))
        .map((entry) => ({
          name: decodeURIComponent(entry.name).split("url=")[1]?.split("&")[0]?.split("/").pop() ?? entry.name,
          start: Math.round(entry.startTime),
          end: Math.round(entry.responseEnd),
          size: entry.encodedBodySize || entry.transferSize || 0,
        })),
    })`),
  );

  return {
    first: first === null ? null : Math.round(first),
    half: half === null ? null : Math.round(half),
    canvasAt: rest.film?.canvasAt ?? null,
    tiers: rest.film?.tiers ?? [],
    scripts: rest.scripts,
    images: rest.images,
    bytes: rest.images.reduce((total, one) => total + one.size, 0),
    largest: rest.images.reduce((most, one) => Math.max(most, one.size), 0),
    concurrency: atOnce(rest.images),
  };
}

/** The most requests that were ever open together, which is what says whether they queued. */
function atOnce(images) {
  const edges = [];
  for (const image of images) {
    edges.push({ at: image.start, change: 1 });
    edges.push({ at: image.end, change: -1 });
  }
  edges.sort((a, b) => a.at - b.at || a.change - b.change);
  let open = 0;
  let most = 0;
  for (const edge of edges) {
    open += edge.change;
    most = Math.max(most, open);
  }
  return most;
}

function median(list) {
  const kept = list.filter((one) => one !== null).sort((a, b) => a - b);
  return kept.length === 0 ? null : kept[Math.floor(kept.length / 2)];
}

function show(value) {
  return value === null ? "never" : `${(value / 1000).toFixed(2)} s`;
}

function pad(value, width) {
  const text = String(value);
  return text.length >= width ? `${text} ` : text + " ".repeat(width - text.length);
}

function onPath(name) {
  return spawnSync(process.platform === "win32" ? "where" : "which", [name], { stdio: "ignore" }).status === 0;
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

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForTarget() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await response.json();
      const page = targets.find((entry) => entry.type === "page");
      if (page !== undefined) {
        return page.webSocketDebuggerUrl;
      }
    } catch {
      // The browser has not opened its port yet.
    }
    await wait(100);
  }
  throw new Error("the browser never opened its debugging port");
}

function open(target) {
  return new Promise((resolve, reject) => {
    const connection = new WebSocket(target);
    connection.addEventListener("open", () => resolve(connection));
    connection.addEventListener("error", reject);
    connection.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      const pending = waiting.get(message.id);
      if (pending !== undefined) {
        waiting.delete(message.id);
        if (message.error === undefined) {
          pending.resolve(message.result);
        } else {
          pending.reject(new Error(message.error.message));
        }
      }
    });
  });
}

function send(method, params = {}) {
  const id = nextId;
  nextId += 1;
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const answer = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (answer.exceptionDetails !== undefined) {
    throw new Error(answer.exceptionDetails.exception?.description ?? "the page threw");
  }
  return answer.result.value;
}
