/**
 * How long a frame of the home story takes on this machine, measured.
 *
 * Starts a headless Chrome, opens the page, scrolls it with real wheel events
 * for half a minute, and samples every frame from inside the page with
 * requestAnimationFrame. It prints the mean, the p95 and every step the
 * adaptive tier took, which is what tells you whether a change to the scene
 * cost frames or bought them.
 *
 * Run it against a production build, never the dev server: the dev build draws
 * the same scene through unminified React and reads three to four milliseconds
 * a frame slower.
 *
 *   npm run build --workspace packages/web
 *   npx next start --dir packages/web -p 3312
 *   node packages/web/scripts/perf/scroll-frames.mjs --url http://localhost:3312/en
 *
 * Options: --url, --seconds, --width, --height, --port, --browser, --gpu.
 * Without --browser it looks for chrome-headless-shell on the PATH, then for
 * Chrome where Windows installs it.
 */

import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The protocol is request and response over one socket, so every call carries its own id. */
let nextId = 1;
const waiting = new Map();

const args = readArgs(process.argv.slice(2));
const url = args.url ?? "http://localhost:3312/en";
const seconds = Number(args.seconds ?? 30);
const width = Number(args.width ?? 1440);
const height = Number(args.height ?? 900);
const port = Number(args.port ?? 9333);

const CHROMES = [
  process.env.CHROME,
  "chrome-headless-shell",
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
];

const browser = args.browser ?? CHROMES.find((path) => path !== undefined && (path.includes("/") ? existsSync(path) : onPath(path)));
if (browser === undefined) {
  throw new Error("no browser found: pass --browser with the path to chrome-headless-shell or Chrome");
}

const profile = await mkdtemp(join(tmpdir(), "moolam-frames-"));
const flags = [
  "--headless=new",
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`,
  `--window-size=${width},${height}`,
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-extensions",
  "--hide-scrollbars",
  "--mute-audio",
];
if (args.gpu === undefined) {
  // A headless shell has no GPU driver path anyway, and saying so keeps the two
  // kinds of browser measuring the same thing.
  flags.push("--disable-gpu");
}

const child = spawn(browser, [...flags, "about:blank"], { stdio: "ignore" });
let socket;

try {
  const target = await waitForTarget();
  socket = await open(target);

  await send("Page.enable");
  await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });

  await send("Page.navigate", { url });
  await settled();

  // The sampler lives in the page: a frame time measured from outside would be
  // the protocol's round trip, not the page's own frame.
  await evaluate(`
    window.__frames = [];
    window.__tiers = [];
    (() => {
      let last = performance.now();
      const start = last;
      const step = (now) => {
        window.__frames.push(now - last);
        last = now;
        const node = document.querySelector("[data-story-tier]");
        const tier = node === null ? null : Number(node.getAttribute("data-story-tier"));
        const seen = window.__tiers.at(-1);
        if (tier !== null && (seen === undefined || seen.tier !== tier)) {
          window.__tiers.push({ tier, at: Math.round(now - start) });
        }
        requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    })();
  `);

  const until = Date.now() + seconds * 1000;
  while (Date.now() < until) {
    await send("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x: Math.round(width / 2),
      y: Math.round(height / 2),
      deltaX: 0,
      deltaY: 120,
      pointerType: "mouse",
    });
    await wait(90);
  }

  const frames = await evaluate("JSON.stringify({ frames: window.__frames, tiers: window.__tiers })");
  const answer = JSON.parse(frames);

  // A frame longer than a quarter of a second is a pause, not a frame rate: a
  // navigation, a texture decode, the protocol itself. The tier controller
  // throws those away too.
  const kept = answer.frames.filter((ms) => ms > 0 && ms <= 250).sort((a, b) => a - b);
  if (kept.length === 0) {
    throw new Error("no frames were sampled: is the page really at that address?");
  }

  const mean = kept.reduce((total, ms) => total + ms, 0) / kept.length;
  const p95 = kept[Math.min(kept.length - 1, Math.floor(kept.length * 0.95))];

  console.log(`url        ${url}`);
  console.log(`window     ${width}x${height}${args.gpu === undefined ? ", gpu off" : ""}`);
  console.log(`frames     ${kept.length} kept of ${answer.frames.length} over ${seconds}s`);
  console.log(`mean       ${mean.toFixed(1)} ms`);
  console.log(`p95        ${p95.toFixed(1)} ms`);
  console.log(
    `tier       ${answer.tiers.length === 0 ? "no canvas on the page" : answer.tiers.map((step) => `${step.tier} at ${(step.at / 1000).toFixed(1)}s`).join(", ")}`,
  );
} finally {
  socket?.close();
  child.kill();
  await rm(profile, { recursive: true, force: true }).catch(() => undefined);
}

/** Whether a bare command name can actually be run, so a missing shell fails here and not silently. */
function onPath(name) {
  const found = spawnSync(process.platform === "win32" ? "where" : "which", [name], { stdio: "ignore" });
  return found.status === 0;
}

function readArgs(list) {
  const out = {};
  for (let index = 0; index < list.length; index += 1) {
    if (!list[index].startsWith("--")) {
      continue;
    }
    const name = list[index].slice(2);
    const next = list[index + 1];
    out[name] = next === undefined || next.startsWith("--") ? "" : next;
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

/** Waits for the scene to exist and for its textures to be through the grace period. */
async function settled() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const ready = await evaluate("document.querySelector('canvas') !== null || document.querySelector('[data-story]') !== null");
    if (ready === true) {
      break;
    }
    await wait(200);
  }
  await wait(2500);
}
