/**
 * The stated beat in the home page's film, measured from outside the page.
 *
 * It opens the film in a headless Chrome with a GPU, winds the story's own
 * scroller to the offsets you ask about, and prints what is really on screen at
 * each one: how much of the rule is drawn, where the words, the rule and the
 * shot are, which of the four marks have stamped and what each one says. With
 * --frames it stays inside one beat and samples every frame, which is how two
 * beats of the same film are compared on one machine.
 *
 * The dev server is fine for the boxes and for the drawing. Frame times taken
 * here belong to the dev build and are only worth reading against another
 * number taken the same way in the same run.
 *
 *   node packages/web/scripts/perf/stated-beat.mjs --url http://localhost:3210/en --at 0.34,0.37,0.40
 *   node packages/web/scripts/perf/stated-beat.mjs --url http://localhost:3210/en --frames 0.334,0.445 --seconds 8
 *
 * Options: --url, --at, --frames from,to, --seconds, --width, --height,
 * --shot (a png path), --reduced, --port, --browser, --gpu (on by default).
 */

import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let nextId = 1;
const waiting = new Map();

const args = readArgs(process.argv.slice(2));
const url = args.url ?? "http://localhost:3210/en";
const width = Number(args.width ?? 1440);
const height = Number(args.height ?? 900);
const port = Number(args.port ?? 9366);
const seconds = Number(args.seconds ?? 8);
const stops = (args.at ?? "").split(",").filter((one) => one !== "").map(Number);
const window = (args.frames ?? "").split(",").filter((one) => one !== "").map(Number);

const CHROMES = [
  process.env.CHROME,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "chrome-headless-shell",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
];

const browser =
  args.browser ?? CHROMES.find((path) => path !== undefined && (path.includes("/") ? existsSync(path) : onPath(path)));
if (browser === undefined) {
  throw new Error("no browser found: pass --browser with the path to Chrome");
}

const profile = await mkdtemp(join(tmpdir(), "moolam-stated-"));
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
  // The film drops to a still page when frames miss their budget, and a
  // software renderer misses it every time. The beat is judged with a GPU.
  "--use-angle=default",
  "--enable-gpu",
  "--ignore-gpu-blocklist",
];

const child = spawn(browser, [...flags, "about:blank"], { stdio: "ignore" });
let socket;

try {
  socket = await open(await waitForTarget());
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: width < 600,
  });
  if (args.reduced !== undefined) {
    await send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-motion", value: "reduce" }],
    });
  }
  if (args.theme !== undefined && args.theme !== "") {
    // The site's own toggle, set before the page runs, the way a returning
    // reader would arrive with it. The film is dark either way and this is how
    // that claim is checked rather than assumed.
    await send("Page.addScriptToEvaluateOnNewDocument", {
      source: `localStorage.setItem("theme", ${JSON.stringify(args.theme)});`,
    });
  }
  if (args.nowebgl !== undefined) {
    // A browser that cannot open a 3D context at all. Chrome falls back to a
    // software renderer rather than refusing, so the refusal is put in front of
    // it, before the page's own script has asked.
    await send("Page.addScriptToEvaluateOnNewDocument", {
      source: `
        const real = HTMLCanvasElement.prototype.getContext;
        HTMLCanvasElement.prototype.getContext = function (kind, ...rest) {
          return String(kind).startsWith("webgl") ? null : real.call(this, kind, ...rest);
        };
      `,
    });
  }

  await send("Page.navigate", { url });
  await ready();

  console.log(`url        ${url}`);
  console.log(`window     ${width}x${height}${args.reduced === undefined ? "" : ", reduced motion"}`);
  console.log(`story      ${await evaluate("document.querySelector('[data-story]')?.getAttribute('data-story') ?? 'none'")}`);
  console.log(`pages      ${await evaluate("(() => { const el = document.querySelector('[data-story-scroller]'); return el === null ? 'no scroller' : Math.round(el.scrollHeight / el.clientHeight); })()")}`);

  for (const at of stops) {
    await park(at);
    const seen = JSON.parse(await evaluate(report()));
    console.log(`\nat ${at.toFixed(3)}  the scroller sits at ${seen.offset.toFixed(4)}`);
    console.log(`  rule     ${seen.rule === null ? "not drawn" : `${seen.rule.drawn.toFixed(1)} px of ${seen.rule.guide.toFixed(1)} px, opacity ${seen.rule.opacity}`}`);
    console.log(`  beat     ${seen.beats.length === 0 ? "no caption on screen" : seen.beats.join(" ")}`);
    console.log(`  marks    ${seen.marks.map((mark) => `${mark.field}=${mark.use}@${mark.opacity}`).join(" ")}`);
    for (const [name, box] of Object.entries(seen.boxes)) {
      console.log(`  ${name.padEnd(8)} ${box === null ? "not on screen" : `x ${box.x.toFixed(0)} to ${(box.x + box.width).toFixed(0)}, y ${box.y.toFixed(0)} to ${(box.y + box.height).toFixed(0)}`}`);
    }
    console.log(`  ink      rule ${seen.ink.rule}, marks ${seen.ink.mark}, on ${seen.ink.ground}`);
    console.log(`  overlap  ${seen.overlap.length === 0 ? "none" : seen.overlap.join(", ")}`);
    console.log(`  sideways ${seen.sideways ? `yes, ${seen.scrollWidth} px wide in a ${width} px window` : "none"}`);

    if (args.shot !== undefined && args.shot !== "") {
      const shot = await send("Page.captureScreenshot", { format: "png" });
      const path = args.shot.replace("{at}", at.toFixed(3));
      await writeFile(path, Buffer.from(shot.data, "base64"));
      console.log(`  shot     ${path}`);
    }
  }

  if (args.toggle !== undefined) {
    console.log(`\nbench control`);
    console.log(`  before   ${await cut()}`);
    await evaluate("document.querySelector('[data-bench-cut]')?.click()");
    await wait(4000);
    console.log(`  after    ${await cut()}`);
    await evaluate("document.querySelector('[data-bench-cut]')?.click()");
    await wait(4000);
    console.log(`  again    ${await cut()}`);
  }

  if (window.length === 2) {
    const frames = await sampleFrames(window[0], window[1], seconds);
    console.log(`\nframes in ${window[0]} to ${window[1]}: ${frames.kept} kept of ${frames.total} over ${seconds}s`);
    console.log(`  mean     ${frames.mean.toFixed(1)} ms`);
    console.log(`  p95      ${frames.p95.toFixed(1)} ms`);
    console.log(`  worst    ${frames.worst.toFixed(1)} ms`);
    console.log(`  tier     ${frames.tier}`);
  }
} finally {
  socket?.close();
  child.kill();
  await rm(profile, { recursive: true, force: true }).catch(() => undefined);
}

/**
 * Winds the film's own scroller and waits for its damping to arrive. The still
 * page has no scroller of its own, so there the same fraction moves the window,
 * which is the only scroll that page has.
 */
async function park(at) {
  await evaluate(`(() => {
    const el = document.querySelector('[data-story-scroller]');
    if (el !== null) {
      el.scrollTop = ${at} * (el.scrollHeight - el.clientHeight);
      return;
    }
    window.scrollTo({ top: ${at} * (document.documentElement.scrollHeight - window.innerHeight), behavior: 'auto' });
  })()`);
  await wait(1600);
}

/** What is on screen right now, read inside the page in one go. */
function report() {
  return `JSON.stringify((() => {
    const el = document.querySelector('[data-story-scroller]');
    const offset = el === null ? 0 : el.scrollTop / (el.scrollHeight - el.clientHeight);
    const pinned = document.querySelector('[data-stated-ledger="pinned"]');
    const inline = document.querySelector('[data-stated-ledger="inline"]');
    const ledger = pinned !== null && getComputedStyle(pinned).display !== 'none' ? pinned : inline;
    const drawn = ledger === null ? null : ledger.querySelector('[data-rule="drawn"]');
    const guide = ledger === null ? null : ledger.querySelector('[data-rule="guide"]');
    const words = document.querySelector('[data-beat="stated"]');
    const canvas = document.querySelector('canvas');
    const band = canvas === null ? null : canvas.getBoundingClientRect();
    const phone = window.innerWidth < 640;
    const box = (node) => {
      if (node === null) return null;
      const rect = node.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    };
    // The words are the text alone. The ledger stacks inside the same caption
    // on a phone, and counting it as words would report the block overlapping
    // itself.
    // A range over each line, not the block around it: the words are set to the
    // end of a full width column, so the block's own box says the caption is
    // 1300 px wide when the ink in it is 500.
    const inked = (node) => {
      const range = document.createRange();
      range.selectNodeContents(node);
      return range.getBoundingClientRect();
    };
    const said = words === null ? [] : [...(words.firstElementChild ?? words).querySelectorAll('p, h2')]
      .filter((node) => node.closest('[data-stated-ledger]') === null)
      .map(inked)
      .filter((rect) => rect.width > 0 && rect.height > 0);
    const wordsBox = said.length === 0 ? null : {
      x: Math.min(...said.map((rect) => rect.x)),
      y: Math.min(...said.map((rect) => rect.y)),
      width: Math.max(...said.map((rect) => rect.x + rect.width)) - Math.min(...said.map((rect) => rect.x)),
      height: Math.max(...said.map((rect) => rect.y + rect.height)) - Math.min(...said.map((rect) => rect.y)),
    };
    // The pinned ledger's own element is the whole screen, so what is measured
    // is the ink in it: the rule, the notch and the marks that have landed.
    const drawnBits = ledger === null ? [] : [...ledger.querySelectorAll('[data-rule], [data-stated-mark]')]
      .map((node) => node.getBoundingClientRect())
      .filter((rect) => rect.width > 0 && rect.height >= 0);
    const union = drawnBits.length === 0 ? null : {
      x: Math.min(...drawnBits.map((rect) => rect.x)),
      y: Math.min(...drawnBits.map((rect) => rect.y)),
      width: Math.max(...drawnBits.map((rect) => rect.x + rect.width)) - Math.min(...drawnBits.map((rect) => rect.x)),
      height: Math.max(...drawnBits.map((rect) => rect.y + rect.height)) - Math.min(...drawnBits.map((rect) => rect.y)),
    };
    // On a phone the shot is the top 45 percent of the canvas and nothing is
    // drawn below it, so that band is the picture.
    const picture = band === null ? null : { x: band.x, y: band.y, width: band.width, height: phone ? band.height * 0.45 : band.height };
    const ruleBox = union ?? box(ledger);
    const hits = (a, b, an, bn) => a !== null && b !== null && a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height ? [an + ' over ' + bn] : [];
    const marks = [...(ledger === null ? [] : ledger.querySelectorAll('[data-stated-mark]'))].map((node) => ({
      field: node.getAttribute('data-stated-mark'),
      use: node.getAttribute('data-stated-use'),
      opacity: Number(getComputedStyle(node).opacity).toFixed(2),
    }));
    return {
      offset,
      // Which words are on screen at this offset, which is the only way to read
      // a beat's own offsets off a running film.
      beats: [...document.querySelectorAll('[data-beat]')]
        .map((node) => ({ name: node.getAttribute('data-beat'), shown: Number(getComputedStyle(node).opacity) }))
        .filter((one) => one.shown > 0.02)
        .map((one) => one.name + '@' + one.shown.toFixed(2)),
      rule: drawn === null ? null : {
        drawn: drawn.getBoundingClientRect().width,
        guide: guide === null ? ledger.getBoundingClientRect().width : guide.getBoundingClientRect().width,
        opacity: Number(getComputedStyle(ledger.closest('[data-stated-ledger]')).opacity).toFixed(2),
      },
      marks,
      ink: {
        rule: drawn === null ? "none" : getComputedStyle(drawn).backgroundColor,
        mark: marks.length === 0 ? "none" : getComputedStyle(ledger.querySelector('[data-stated-mark] span')).color,
        ground: getComputedStyle(document.querySelector('[data-story]') ?? document.body).backgroundColor,
      },
      boxes: { words: wordsBox, rule: ruleBox, picture },
      // On a phone nothing may sit on the picture at all. On a desktop the shot
      // is the whole frame by design, so what is checked there is that the
      // words and the rule keep out of each other.
      overlap: [
        // Line by line, not block by block: the ledger stacks between the body
        // and the readout on a phone, so a box drawn round all the words
        // contains it by definition and would report an overlap that no reader
        // can see.
        ...said.flatMap((line, at) => hits({ x: line.x, y: line.y, width: line.width, height: line.height }, ruleBox, 'line ' + at, 'rule')),
        ...(phone ? [...hits(wordsBox, picture, 'words', 'picture'), ...hits(ruleBox, picture, 'rule', 'picture')] : []),
      ],
      sideways: document.documentElement.scrollWidth > window.innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
    };
  })())`;
}

/**
 * Frames while the film is nudged back and forth inside one beat.
 *
 * A beat is a fraction of the scroll, so the sampler wheels a little way in and
 * a little way back rather than running the whole film: what is being asked is
 * what this beat costs, not what the film costs.
 */
async function sampleFrames(from, to, forSeconds) {
  await park(from);
  await evaluate(`
    window.__beatFrames = [];
    (() => {
      let last = performance.now();
      const step = (now) => {
        window.__beatFrames.push(now - last);
        last = now;
        requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    })();
  `);

  const until = Date.now() + forSeconds * 1000;
  let forward = true;
  while (Date.now() < until) {
    await send("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x: Math.round(width / 2),
      y: Math.round(height / 2),
      deltaX: 0,
      deltaY: forward ? 80 : -80,
      pointerType: "mouse",
    });
    const at = Number(await evaluate("(() => { const el = document.querySelector('[data-story-scroller]'); return el.scrollTop / (el.scrollHeight - el.clientHeight); })()"));
    if (at >= to) {
      forward = false;
    }
    if (at <= from) {
      forward = true;
    }
    await wait(60);
  }

  const all = JSON.parse(await evaluate("JSON.stringify(window.__beatFrames ?? [])"));
  const tier = await evaluate("document.querySelector('[data-story-tier]')?.getAttribute('data-story-tier') ?? 'none'");
  const kept = all.filter((ms) => ms > 0 && ms <= 250).sort((a, b) => a - b);
  if (kept.length === 0) {
    throw new Error("no frames were sampled");
  }
  return {
    total: all.length,
    kept: kept.length,
    mean: kept.reduce((sum, ms) => sum + ms, 0) / kept.length,
    p95: kept[Math.min(kept.length - 1, Math.floor(kept.length * 0.95))],
    worst: kept[kept.length - 1],
    tier,
  };
}

/** Which cut is on the bench right now, and how long its film is. */
async function cut() {
  return await evaluate(`(() => {
    const el = document.querySelector('[data-story-scroller]');
    const screens = el === null ? 'no scroller' : (el.scrollHeight / el.clientHeight).toFixed(2) + ' screens';
    const ledger = document.querySelector('[data-stated-ledger]') === null ? 'no ledger' : 'ledger drawn';
    return (document.querySelector('[data-bench-cut]')?.getAttribute('data-bench-cut') ?? 'no control') + ', ' + screens + ', ' + ledger;
  })()`);
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

async function ready() {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const there = await evaluate(
      "document.querySelector('canvas') !== null || document.querySelector('[data-story=\"still\"]') !== null",
    );
    if (there === true) {
      break;
    }
    await wait(250);
  }
  // The pictures have to be on the plates before anything is drawn along one.
  await wait(3500);
}

async function waitForTarget() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const page = (await response.json()).find((entry) => entry.type === "page");
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
