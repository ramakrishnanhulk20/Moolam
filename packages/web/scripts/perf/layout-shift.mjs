/**
 * Every layout shift the first seconds of a page make, and which element made it.
 *
 * Lighthouse prints one CLS number and no cause. This opens the page in a
 * headless Chrome with a PerformanceObserver installed before the document
 * exists, watches for six seconds, and prints each shift with the moment it
 * landed, the score it carried, and the element that moved with its box before
 * and after. That is what turns "CLS 0.007" into a sentence someone can fix.
 *
 * Run it against a production build.
 *
 *   NEXT_DIST_DIR=.next-check npx next start -p 3389
 *   node packages/web/scripts/perf/layout-shift.mjs --url http://localhost:3389/en
 *
 * Options: --url, --runs, --seconds, --sizes (WxH,WxH), --port, --browser, --gpu.
 * Scrollbars are left on: a scrollbar that comes and goes is itself a shift, and
 * hiding it would measure a window nobody has.
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
const runs = Number(args.runs ?? 3);
const seconds = Number(args.seconds ?? 6);
const port = Number(args.port ?? 9388);
const sizes = (args.sizes ?? "1440x900,375x667").split(",").map((one) => {
  const [width, height] = one.split("x").map(Number);
  return { width, height, mobile: width < 600 };
});

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

const profileDir = await mkdtemp(join(tmpdir(), "moolam-shift-"));
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

  await send("Page.addScriptToEvaluateOnNewDocument", {
    source: `
      window.__shifts = [];
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          window.__shifts.push({
            at: Math.round(entry.startTime),
            value: entry.value,
            // Chrome leaves a shift out of the score when it lands within half a
            // second of an input, and a phone's viewport meta resizing the
            // layout viewport counts as one. Those are kept and marked here:
            // the page still moved under the reader.
            excused: entry.hadRecentInput,
            sources: entry.sources.map((source) => ({
              node: describe(source.node),
              from: box(source.previousRect),
              to: box(source.currentRect),
            })),
          });
        }
      }).observe({ type: "layout-shift", buffered: true });

      function box(rect) {
        return rect === undefined || rect === null
          ? null
          : { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) };
      }

      function describe(node) {
        if (node === null || node === undefined) {
          return "gone";
        }
        if (node.nodeType !== 1) {
          return node.nodeName;
        }
        const story = node.getAttribute("data-story");
        const name = node.tagName.toLowerCase();
        const classes = typeof node.className === "string" && node.className !== "" ? "." + node.className.trim().split(/\\s+/).join(".") : "";
        return (name + (story === null ? "" : "[data-story=" + story + "]") + classes).slice(0, 96);
      }
    `,
  });

  for (const size of sizes) {
    await send("Emulation.setDeviceMetricsOverride", {
      width: size.width,
      height: size.height,
      deviceScaleFactor: 1,
      mobile: size.mobile,
    });

    console.log("");
    console.log(`window     ${size.width}x${size.height}   ${url}   ${seconds}s per run${args.gpu === undefined ? ", gpu off" : ""}`);

    for (let run = 0; run < runs; run += 1) {
      const shifts = await measure();
      const scored = shifts.filter((one) => !one.excused).reduce((sum, one) => sum + one.value, 0);
      const all = shifts.reduce((sum, one) => sum + one.value, 0);
      console.log(
        `run ${run + 1}      CLS ${scored.toFixed(5)}${all === scored ? "" : `, ${all.toFixed(5)} counting the shifts excused for a recent resize`}${shifts.length === 0 ? "   no shift at all" : ""}`,
      );
      for (const shift of shifts) {
        console.log(`  ${pad(`${shift.at} ms`, 10)}${shift.value.toFixed(5)}${shift.excused ? "   excused" : ""}`);
        for (const source of shift.sources) {
          const from = source.from === null ? "?" : `${source.from.w}x${source.from.h} at ${source.from.x},${source.from.y}`;
          const to = source.to === null ? "?" : `${source.to.w}x${source.to.h} at ${source.to.x},${source.to.y}`;
          console.log(`    ${source.node}`);
          console.log(`      ${from}  ->  ${to}`);
        }
      }
    }
  }
} finally {
  socket?.close();
  child.kill();
  await rm(profileDir, { recursive: true, force: true }).catch(() => undefined);
}

async function measure() {
  await send("Page.navigate", { url: "about:blank" });
  await wait(300);
  await send("Page.navigate", { url });
  await wait(seconds * 1000);
  return JSON.parse(await evaluate("JSON.stringify(window.__shifts ?? [])"));
}

function onPath(name) {
  return spawnSync(process.platform === "win32" ? "where" : "which", [name], { stdio: "ignore" }).status === 0;
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
