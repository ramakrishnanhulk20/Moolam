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

  // Every draw the scene makes is counted from before the page exists, split by
  // whether the tab was in front at the time. That is the only way to answer
  // "does the film keep drawing in a background tab" with a number.
  await send("Page.addScriptToEvaluateOnNewDocument", {
    source: `
      window.__draws = { shown: 0, hidden: 0, firstFrame: null };
      // Frames from the moment the document exists, which is the only way to
      // catch a stall while the scene is being built. The sampler further down
      // starts later, once the textures are in, and measures the scroll.
      window.__startup = [];
      (() => {
        let last = performance.now();
        const step = (now) => {
          if (now - last > 0) {
            window.__startup.push({ at: Math.round(now), ms: now - last });
          }
          last = now;
          if (now < 8000) {
            requestAnimationFrame(step);
          }
        };
        requestAnimationFrame(step);
      })();
      (() => {
        const count = (proto) => {
          if (proto === undefined) {
            return;
          }
          for (const name of ["drawElements", "drawArrays", "drawElementsInstanced", "drawArraysInstanced"]) {
            const original = proto[name];
            if (typeof original !== "function") {
              continue;
            }
            proto[name] = function (...rest) {
              window.__draws[document.hidden ? "hidden" : "shown"] += 1;
              if (window.__draws.firstFrame === null) {
                window.__draws.firstFrame = Math.round(performance.now());
              }
              return original.apply(this, rest);
            };
          }
        };
        count(window.WebGLRenderingContext?.prototype);
        count(window.WebGL2RenderingContext?.prototype);
      })();
    `,
  });

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

  // The frames are taken first. A hidden tab gets no animation frame at all, so
  // asking this question earlier would leave one five second gap in the sample
  // and call it the worst frame of the run.
  const background = await inBackground();
  const draws = JSON.parse(await evaluate("JSON.stringify(window.__draws ?? null)"));
  const startup = JSON.parse(await evaluate("JSON.stringify(window.__startup ?? [])"));

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
  for (const level of perTier(answer.frames, answer.tiers)) {
    console.log(
      `  tier ${level.tier}    ${level.frames} frames over ${(level.heldMs / 1000).toFixed(1)}s, mean ${level.mean.toFixed(1)} ms, worst ${Math.round(level.worst)} ms`,
    );
  }
  console.log(`first draw ${draws === null || draws.firstFrame === null ? "no webgl draws" : `${draws.firstFrame} ms after the page opened`}`);
  const stall = startup.reduce((worst, one) => (one.ms > worst.ms ? one : worst), { ms: 0, at: 0 });
  console.log(`startup    worst frame in the first 8s of the page: ${Math.round(stall.ms)} ms at ${Math.round(stall.at)} ms`);
  console.log(
    `background ${background.state} for ${background.seconds}s, ${background.drew} draws while the tab was behind another one`,
  );
  console.log(`worst      ${worstAfterOneSecond(answer.frames)} ms, the longest single frame after the first second of sampling, pauses included`);
} finally {
  socket?.close();
  child.kill();
  await rm(profile, { recursive: true, force: true }).catch(() => undefined);
}

/**
 * What each tier actually cost on this machine.
 *
 * The overall mean of a run that stepped tiers is a blend of four different
 * scenes and says nothing about any of them. Splitting the frames at the moments
 * the tier changed gives the number the thresholds are chosen against. The three
 * frames around a step belong to the swap itself and are left out.
 */
function perTier(frames, tiers) {
  if (tiers.length === 0) {
    return [];
  }
  const held = new Map();
  let elapsed = 0;
  let at = 0;
  let sinceStep = 0;
  for (const ms of frames) {
    elapsed += ms;
    while (at + 1 < tiers.length && elapsed >= tiers[at + 1].at) {
      at += 1;
      sinceStep = 0;
    }
    sinceStep += 1;
    if (sinceStep <= 3 || ms > 250) {
      continue;
    }
    const level = held.get(tiers[at].tier) ?? { tier: tiers[at].tier, frames: 0, total: 0, worst: 0, heldMs: 0 };
    level.frames += 1;
    level.total += ms;
    level.heldMs += ms;
    level.worst = Math.max(level.worst, ms);
    held.set(tiers[at].tier, level);
  }
  return [...held.values()].map((level) => ({ ...level, mean: level.frames === 0 ? 0 : level.total / level.frames }));
}

/**
 * The longest single frame once the scene has had a second to settle. Nothing is
 * thrown away here: a stall is exactly what this line is looking for.
 */
function worstAfterOneSecond(frames) {
  let elapsed = 0;
  let worst = 0;
  for (const ms of frames) {
    elapsed += ms;
    if (elapsed > 1000 && ms > worst) {
      worst = ms;
    }
  }
  return Math.round(worst);
}

/**
 * Puts a second tab in front and reports what the film did while it was behind
 * it. A page that keeps drawing in a background tab is spending a reader's
 * battery on a picture nobody is looking at.
 */
async function inBackground(secondsHidden = 5) {
  const before = Number(await evaluate("window.__draws?.hidden ?? 0"));
  const made = await send("Target.createTarget", { url: "about:blank" });
  await wait(secondsHidden * 1000);
  const state = await evaluate("document.visibilityState");
  const after = Number(await evaluate("window.__draws?.hidden ?? 0"));
  await send("Target.closeTarget", { targetId: made.targetId });
  await wait(500);
  return { state, drew: after - before, seconds: secondsHidden };
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
