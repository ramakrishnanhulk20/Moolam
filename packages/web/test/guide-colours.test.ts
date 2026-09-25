import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createElement, type FunctionComponent, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";
import en from "@/messages/en.json";

/**
 * The guide's ink, read by a real browser against the site's real stylesheet.
 *
 * The fault this guards against cannot be seen by anything short of a browser:
 * the guide swaps the colour tokens to the dark palette, but a heading with no
 * colour of its own inherits the colour the light body had already worked out,
 * and came out black on the guide's black card. jsdom does not resolve a single
 * var(), so this compiles globals.css with Tailwind exactly as the app does,
 * lays the card on a page set to each theme, and asks Chrome for the colours.
 */

vi.mock("@/lib/i18n/routing", () => ({
  Link: ({ href, className, children }: { href: string; className?: string; children?: ReactNode }) =>
    createElement("a", { href, className }, children),
}));

const { GuideCard } = await import("@/components/guide/GuideWalk");
const { GUIDE_SCOPE } = await import("@/components/guide/GuideGround");

const WEB = fileURLToPath(new URL("..", import.meta.url));

/** A Chrome this machine has: the one named in CHROME, Playwright's headless shell, or the installed browser. */
function findBrowser(): string | null {
  const named = process.env.CHROME;
  if (named !== undefined && existsSync(named)) {
    return named;
  }
  const playwright = join(process.env.LOCALAPPDATA ?? join(process.env.HOME ?? "", ".cache"), "ms-playwright");
  if (existsSync(playwright)) {
    const shells = readdirSync(playwright)
      .filter((name) => name.startsWith("chromium_headless_shell-"))
      .sort()
      .reverse();
    for (const shell of shells) {
      for (const inner of ["chrome-win", "chrome-headless-shell-win64", "chrome-linux", "chrome-headless-shell-linux64"]) {
        for (const exe of ["chrome-headless-shell.exe", "chrome-headless-shell", "headless_shell.exe", "headless_shell"]) {
          const path = join(playwright, shell, inner, exe);
          if (existsSync(path)) {
            return path;
          }
        }
      }
    }
  }
  for (const path of [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
  ]) {
    if (existsSync(path)) {
      return path;
    }
  }
  return null;
}

const browserPath = findBrowser();

/** Just enough of the DevTools protocol to load a page and read from it. */
class Tab {
  private next = 1;
  private waiting = new Map<number, (value: { result?: unknown; error?: { message: string } }) => void>();

  private constructor(private socket: WebSocket) {
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as { id?: number; result?: unknown; error?: { message: string } };
      if (message.id !== undefined) {
        this.waiting.get(message.id)?.(message);
        this.waiting.delete(message.id);
      }
    });
  }

  static async open(url: string): Promise<Tab> {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", reject, { once: true });
    });
    return new Tab(socket);
  }

  async send<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = this.next++;
    const reply = await new Promise<{ result?: unknown; error?: { message: string } }>((resolve) => {
      this.waiting.set(id, resolve);
      this.socket.send(JSON.stringify({ id, method, params }));
    });
    if (reply.error !== undefined) {
      throw new Error(`${method}: ${reply.error.message}`);
    }
    return reply.result as T;
  }

  close() {
    this.socket.close();
  }
}

let chrome: ChildProcess | null = null;
let profile: string | null = null;
let tab: Tab | null = null;
let css = "";

beforeAll(async () => {
  if (browserPath === null) {
    return;
  }
  const source = readFileSync(join(WEB, "styles/globals.css"), "utf8");
  css = (await postcss([tailwind({ base: WEB })]).process(source, { from: join(WEB, "styles/globals.css") })).css;

  profile = await mkdtemp(join(tmpdir(), "moolam-guide-ink-"));
  chrome = spawn(
    browserPath,
    ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--disable-gpu", "about:blank"],
    { stdio: "ignore" },
  );

  // Port 0 lets Chrome pick a free port, which it then writes into the profile.
  let port: string | null = null;
  for (let tries = 0; tries < 100 && port === null; tries += 1) {
    try {
      port = (await readFile(join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0].trim() || null;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  if (port === null) {
    throw new Error("Chrome never opened its DevTools port");
  }
  const targets = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as {
    type: string;
    webSocketDebuggerUrl: string;
  }[];
  const page = targets.find((target) => target.type === "page");
  if (page === undefined) {
    throw new Error("Chrome opened no page");
  }
  tab = await Tab.open(page.webSocketDebuggerUrl);
}, 60_000);

afterAll(async () => {
  tab?.close();
  chrome?.kill();
  if (profile !== null) {
    // Chrome holds its profile for a moment after it is told to go.
    await new Promise((resolve) => setTimeout(resolve, 300));
    await rm(profile, { recursive: true, force: true }).catch(() => undefined);
  }
});

const Provider = NextIntlClientProvider as unknown as FunctionComponent<{
  locale: string;
  messages: unknown;
  timeZone: string;
  children: ReactNode;
}>;

/** The card as the walk draws it, inside the guide's own scope. */
function card(index: number, lit: boolean): string {
  return renderToStaticMarkup(
    createElement(
      Provider,
      { locale: "en", messages: en, timeZone: "Asia/Kolkata" },
      createElement(
        "div",
        { className: GUIDE_SCOPE },
        createElement(GuideCard, { index, lit, reduced: false, onClose: () => undefined, onForward: () => undefined }),
      ),
    ),
  );
}

interface Ink {
  name: string;
  color: string;
  ground: string;
  ratio: number;
}

/**
 * Every piece of the card a reader has to read, with its colour, the colour it
 * sits on (its own fill, or the nearest one behind it) and the contrast between
 * the two, worked out the WCAG way.
 */
const READ = `(() => {
  const lum = (rgb) => {
    const [r, g, b] = rgb.match(/[\\d.]+/g).slice(0, 3).map((part) => {
      const c = Number(part) / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const ground = (node) => {
    for (let at = node; at !== null; at = at.parentElement) {
      const fill = getComputedStyle(at).backgroundColor;
      if (fill !== "rgba(0, 0, 0, 0)" && fill !== "transparent") {
        return fill;
      }
    }
    return getComputedStyle(document.body).backgroundColor;
  };
  const card = document.querySelector("h3").closest("[class*='bg-']");
  const pieces = [
    ["counter", card.querySelector("p")],
    ["title", card.querySelector("h3")],
    ["line", card.querySelector("h3").parentElement.parentElement.nextElementSibling],
    ["elsewhere", card.querySelector("p.border-t")],
    ["action", card.querySelector("a")],
    ["skip", card.querySelectorAll("button")[0]],
    ["next", card.querySelectorAll("button")[1]],
  ];
  return JSON.stringify(pieces.filter(([, node]) => node !== null).map(([name, node]) => {
    const color = getComputedStyle(node).color;
    const back = ground(node);
    const [a, b] = [lum(color), lum(back)].sort((x, y) => y - x);
    return { name, color, ground: back, ratio: Math.round(((a + 0.05) / (b + 0.05)) * 100) / 100 };
  }));
})()`;

async function inkOn(theme: "light" | "dark", markup: string): Promise<Ink[]> {
  if (tab === null) {
    throw new Error("no browser");
  }
  const tree = await tab.send<{ frameTree: { frame: { id: string } } }>("Page.getFrameTree");
  await tab.send("Page.setDocumentContent", {
    frameId: tree.frameTree.frame.id,
    html: `<!doctype html><html class="${theme}"><head><style>${css}</style></head><body>${markup}</body></html>`,
  });
  const read = await tab.send<{ result: { value: string } }>("Runtime.evaluate", { expression: READ, returnByValue: true });
  return JSON.parse(read.result.value) as Ink[];
}

describe.skipIf(browserPath === null)("the guide card's ink, in a real browser", () => {
  it("is the guide's own in the light theme and the dark theme alike", async () => {
    for (const [index, lit] of [
      [0, true],
      [2, false],
    ] as const) {
      const markup = card(index, lit);
      const light = await inkOn("light", markup);
      const dark = await inkOn("dark", markup);

      const names = light.map((one) => one.name);
      expect(names).toEqual(expect.arrayContaining(["title", "line", "skip", "next"]));
      if (!lit) {
        expect(names).toContain("elsewhere");
      }

      // The same colours on the same grounds whichever theme the page is set
      // to: nothing on the card is taking its ink from the page under it.
      expect(light).toEqual(dark);

      // The dark palette's own text colour, not the light theme's near black.
      expect(light.find((one) => one.name === "title")?.color).toBe("rgb(244, 242, 238)");

      for (const one of light) {
        expect(one.ratio, `${one.name}: ${one.color} on ${one.ground}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  }, 60_000);
});
