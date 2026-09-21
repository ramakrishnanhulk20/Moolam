/**
 * Can a judge reach the end of the home page, and can they do it with a keyboard?
 *
 * Starts a headless Chrome on the home page and asks the two questions the film
 * makes hard. First: from the top, one wheel tick must move the story and not
 * the page under it; at the last beat, more ticks must bring the footer into
 * view and scrolling back up must land on the last beat again. Second: Tab must
 * reach the story's scroller, and Page, Space, the arrows, Home and End must
 * move it the way they move a document.
 *
 * Every line it prints is a measurement, not a claim: wheel ticks counted,
 * window.scrollY, the scroller's own scrollTop, and the footer's bottom edge
 * against the window height.
 *
 *   node packages/web/scripts/perf/story-reach.mjs --url http://localhost:3210/en
 *   node packages/web/scripts/perf/story-reach.mjs --width 375 --height 812 --touch
 *
 * Options: --url, --width, --height, --port, --browser, --touch (drag with a
 * finger instead of a wheel), --light (the light theme), --reduced (ask for
 * less motion), --nowebgl (take WebGL away, which is the still page), --gpu.
 */

import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let nextId = 1;
const waiting = new Map();

const args = readArgs(process.argv.slice(2));
const url = args.url ?? "http://localhost:3210/en";
const width = Number(args.width ?? 1440);
const height = Number(args.height ?? 900);
const port = Number(args.port ?? 9341);
const touch = args.touch !== undefined;

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

const profile = await mkdtemp(join(tmpdir(), "moolam-reach-"));
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
  flags.push("--disable-gpu");
}

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
    mobile: touch,
  });
  if (touch) {
    await send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
  }
  if (args.reduced !== undefined) {
    await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  }
  if (args.light !== undefined) {
    // next-themes reads the theme off localStorage and puts the class on the
    // html tag before the first paint, so this is the same light page a reader
    // who has chosen it gets.
    await send("Page.addScriptToEvaluateOnNewDocument", { source: `localStorage.setItem("theme", "light");` });
  }
  if (args.nowebgl !== undefined) {
    // The still page is what a browser with no 3D context gets, and it has to
    // reach the footer too. Taking the context away is the only honest way to
    // ask for it.
    await send("Page.addScriptToEvaluateOnNewDocument", {
      source: `
        const real = HTMLCanvasElement.prototype.getContext;
        HTMLCanvasElement.prototype.getContext = function (kind, ...rest) {
          return kind === "webgl" || kind === "webgl2" || kind === "experimental-webgl" ? null : real.call(this, kind, ...rest);
        };
      `,
    });
  }

  await send("Page.navigate", { url });
  await settled();

  const mode = await evaluate(`(() => {
    const node = document.querySelector("[data-story]");
    return node === null ? "no story" : node.getAttribute("data-story");
  })()`);
  console.log(`url        ${url}`);
  console.log(
    `window     ${width}x${height}${touch ? ", touch" : ", wheel"}${args.light === undefined ? ", dark" : ", light"}${args.reduced === undefined ? "" : ", reduced motion"}${args.nowebgl === undefined ? "" : ", no webgl"}`,
  );
  console.log(`mode       ${mode}`);

  if (mode === "film") {
    await filmChecks();
  } else {
    await stillChecks();
  }
} finally {
  socket?.close();
  child.kill();
  await rm(profile, { recursive: true, force: true }).catch(() => undefined);
}

/** The pinned film: the wheel or the thumb, then the keyboard. */
async function filmChecks() {
  const before = await view();
  await push(120);
  const first = await view();
  console.log(
    `first      one ${touch ? "drag" : "tick"} down: window.scrollY ${before.pageTop} -> ${first.pageTop}, story scrollTop ${before.top} -> ${first.top}`,
  );

  let ticks = 1;
  while (ticks < 60 && (await evaluate("document.body.hasAttribute('data-story-end')")) !== true) {
    await push(600);
    ticks += 1;
  }
  const atEnd = await view();
  console.log(
    `end        data-story-end ${atEnd.ended ? "set" : "never set"} after ${ticks} ${touch ? "drags" : "ticks"}, story offset ${atEnd.offset.toFixed(3)}, tier ${await evaluate("document.querySelector('[data-story-tier]')?.getAttribute('data-story-tier') ?? 'no film'")}`,
  );

  for (let more = 0; more < 2; more += 1) {
    await push(600);
  }
  const reached = await view();
  console.log(
    `footer     after 2 more: footer bottom ${reached.footer === null ? "hidden" : reached.footer.toFixed(0)}, innerHeight ${height}, window.scrollY ${reached.pageTop} of ${reached.pageMax}`,
  );

  await push(-600);
  const one = await view();
  console.log(
    `back       1 up: window.scrollY ${one.pageTop}, story offset ${one.offset.toFixed(3)}, last beat ${one.ended ? "still shown" : "left"}`,
  );
  await push(-600);
  await push(-600);
  const more = await view();
  console.log(
    `rewind     2 more up: window.scrollY ${more.pageTop}, story offset ${more.offset.toFixed(3)}, last beat ${more.ended ? "still shown" : "left"}`,
  );

  await reset();
  console.log(`tab        ${await tabWalk()}`);
  console.log(`ring       ${await focusRing()}`);

  await reset();
  console.log(`skip       ${await pressSkip()}`);

  await reset();
  const onStory = await evaluate(`(() => {
    const el = document.querySelector("[data-story-scroller]");
    if (el === null) {
      return false;
    }
    el.focus();
    return document.activeElement === el;
  })()`);
  if (onStory === true) {
    for (const key of ["PageDown", "Space", "ArrowDown", "ArrowUp", "End", "Home"]) {
      const was = await view();
      await press(key);
      await wait(120);
      const now = await view();
      console.log(
        `key ${key.padEnd(10)} story scrollTop ${was.top} -> ${now.top} (${now.top - was.top >= 0 ? "+" : ""}${now.top - was.top}), window.scrollY ${was.pageTop} -> ${now.pageTop}`,
      );
      if (key === "End") {
        // The footer only arrives once the damped story has read its last beat,
        // which is about a second after the scroller reaches its end, and the
        // page then scrolls to it smoothly. This waits for both.
        await wait(3000);
        const after = await view();
        console.log(
          `end key    footer bottom ${after.footer === null ? "hidden" : after.footer.toFixed(0)}, innerHeight ${height}, window.scrollY ${after.pageTop} of ${after.pageMax}`,
        );
      }
    }
  }
}

/** The still page, which is an ordinary document and must still reach its footer. */
async function stillChecks() {
  await evaluate("window.scrollTo(0, document.documentElement.scrollHeight)");
  await wait(600);
  const at = await view();
  console.log(
    `footer     footer bottom ${at.footer === null ? "hidden" : at.footer.toFixed(0)}, innerHeight ${height}, window.scrollY ${at.pageTop} of ${at.pageMax}`,
  );
}

/** Everything worth knowing about where the page and the story stand, read in one go. */
function view() {
  return evaluate(`(() => {
    const el = document.querySelector("[data-story-scroller]");
    const footer = document.querySelector("footer");
    const shown = footer !== null && getComputedStyle(footer).display !== "none";
    const max = el === null ? 0 : el.scrollHeight - el.clientHeight;
    return {
      top: el === null ? 0 : Math.round(el.scrollTop),
      max: Math.round(max),
      offset: el === null || max === 0 ? 0 : el.scrollTop / max,
      pageTop: Math.round(window.scrollY),
      pageMax: Math.round(document.documentElement.scrollHeight - window.innerHeight),
      footer: shown ? footer.getBoundingClientRect().bottom : null,
      ended: document.body.hasAttribute("data-story-end"),
    };
  })()`);
}

/** One wheel tick, or one thumb drag of the same distance. */
async function push(deltaY) {
  if (touch) {
    // A real finger, not a synthesized gesture: one touchStart, a handful of
    // moves and a touchEnd, which is the path the film's own handlers and the
    // browser's scroll chaining both see.
    const x = Math.round(width / 2);
    const from = Math.round(height / 2 + deltaY / 2);
    const steps = 6;
    await send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x, y: from, id: 1 }],
    });
    for (let step = 1; step <= steps; step += 1) {
      await send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x, y: Math.round(from - (deltaY * step) / steps), id: 1 }],
      });
      await wait(16);
    }
    await send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  } else {
    await send("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x: Math.round(width / 2),
      y: Math.round(height / 2),
      deltaX: 0,
      deltaY,
      pointerType: "mouse",
    });
  }
  await wait(touch ? 220 : 110);
}

/** The key as the browser's own input pipeline needs it spelled. */
function keySpec(name) {
  return {
    Tab: { key: "Tab", code: "Tab", vk: 9, text: undefined },
    PageDown: { key: "PageDown", code: "PageDown", vk: 34, text: undefined },
    PageUp: { key: "PageUp", code: "PageUp", vk: 33, text: undefined },
    ArrowDown: { key: "ArrowDown", code: "ArrowDown", vk: 40, text: undefined },
    ArrowUp: { key: "ArrowUp", code: "ArrowUp", vk: 38, text: undefined },
    End: { key: "End", code: "End", vk: 35, text: undefined },
    Home: { key: "Home", code: "Home", vk: 36, text: undefined },
    Space: { key: " ", code: "Space", vk: 32, text: " " },
    Enter: { key: "Enter", code: "Enter", vk: 13, text: "\r" },
  }[name];
}

async function press(name) {
  const spec = keySpec(name);
  await send("Input.dispatchKeyEvent", {
    type: spec.text === undefined ? "rawKeyDown" : "keyDown",
    key: spec.key,
    code: spec.code,
    windowsVirtualKeyCode: spec.vk,
    nativeVirtualKeyCode: spec.vk,
    text: spec.text,
  });
  await send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: spec.key,
    code: spec.code,
    windowsVirtualKeyCode: spec.vk,
    nativeVirtualKeyCode: spec.vk,
  });
}

/**
 * Where Tab lands, from the top of the document, and whether the film is one of
 * the places it lands. The list is the answer to "in a sensible place in the
 * order": the header's controls, then the way past the film, then the film.
 */
async function tabWalk() {
  await evaluate("document.activeElement?.blur()");
  const seen = [];
  let skip = 0;
  let story = 0;
  for (let count = 1; count <= 24; count += 1) {
    await press("Tab");
    await wait(70);
    const at = await evaluate(`(() => {
      const el = document.activeElement;
      if (el === null) {
        return "nothing";
      }
      const kind = el.hasAttribute("data-story-skip") ? "skip" : el.hasAttribute("data-story-scroller") ? "film" : el.tagName.toLowerCase();
      return kind;
    })()`);
    seen.push(at);
    if (at === "skip" && skip === 0) {
      skip = count;
    }
    if (at === "film") {
      story = count;
      break;
    }
  }
  return story === 0
    ? `the film never took focus in ${seen.length} tabs: ${seen.join(" ")}`
    : `skip control at tab ${skip}, film at tab ${story}: ${seen.join(" ")}`;
}

/**
 * The way past the film, pressed. It should end the story, bring the footer up
 * and leave the reader standing in it.
 */
async function pressSkip() {
  const shown = await evaluate(`(() => {
    const el = document.querySelector("[data-story-skip]");
    if (el === null) {
      return null;
    }
    el.focus();
    const box = el.getBoundingClientRect();
    return JSON.stringify({ text: el.textContent.trim(), w: Math.round(box.width), h: Math.round(box.height), on: document.activeElement === el });
  })()`);
  if (shown === null) {
    return "there is no skip control on this page";
  }
  const seen = JSON.parse(shown);
  await press("Enter");
  await wait(3000);
  const after = await view();
  const focus = await evaluate(`(() => {
    const el = document.activeElement;
    return el === null ? "nothing" : el.tagName.toLowerCase() + (el.closest("footer") === null ? " outside the footer" : " inside the footer");
  })()`);
  return `"${seen.text}" shows at ${seen.w}x${seen.h} when focused; pressed: footer bottom ${after.footer === null ? "hidden" : after.footer.toFixed(0)} of ${height}, window.scrollY ${after.pageTop} of ${after.pageMax}, focus on ${focus}`;
}

/** What the browser would paint around the focused scroller, in this theme. */
function focusRing() {
  return evaluate(`(() => {
    const el = document.querySelector("[data-story-scroller]");
    if (el === null || document.activeElement !== el) {
      return "the scroller does not have focus";
    }
    const style = getComputedStyle(el);
    return style.outlineStyle + " " + style.outlineWidth + " " + style.outlineColor + ", offset " + style.outlineOffset;
  })()`);
}

/** Back to the opening frame, page and story both, before the keyboard run. */
async function reset() {
  await evaluate(`(() => {
    const el = document.querySelector("[data-story-scroller]");
    if (el !== null) {
      el.scrollTop = 0;
    }
    window.scrollTo(0, 0);
  })()`);
  await wait(1200);
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

/** Waits for the story to exist and for its first pictures to be in. */
async function settled() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if ((await evaluate("document.querySelector('[data-story]') !== null")) === true) {
      break;
    }
    await wait(200);
  }
  await wait(3000);
}
