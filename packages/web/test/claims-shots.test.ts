import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createElement, type FunctionComponent, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";
import type { Hex } from "viem";
import en from "@/messages/en.json";
import type { ClaimsAnswer } from "@/lib/claims/client";
import type { ConfirmRow } from "@/lib/claims/useClaimConfirm";
import { failureKey } from "@/lib/claims/useClaims";

/**
 * Pictures of "Waiting for you" in each of its states at 1440 and 375 px, for
 * the head chef's review (WO-264). No sign-in and no transaction: the session's
 * address is a fixture, every answer is a fixture, and the markup is the
 * server render the page would hydrate, laid in a headless Chrome over the
 * site's own stylesheet compiled the way the app compiles it.
 *
 * Off by default, because it opens a browser and writes files outside the
 * package. Run it with CLAIMS_SHOTS=1. Motion is drawn at its resting frame:
 * the server render carries each entrance's first frame, which a still cannot
 * play, so the rule below shows where every element comes to rest.
 */

vi.mock("@/lib/i18n/routing", () => ({
  Link: (props: { href: string; children?: unknown; className?: string }) =>
    createElement("a", { href: props.href, className: props.className }, props.children as never),
}));

const { ClaimsView } = await import("@/components/claims/ClaimsView");
const { ConfirmCard } = await import("@/components/claims/ConfirmCard");
const { ReadFailed } = await import("@/components/claims/ReadFailed");

const WEB = fileURLToPath(new URL("..", import.meta.url));
const OUT = fileURLToPath(new URL("../../../kitchen/reports/claims-web/", import.meta.url));
const STILLS = fileURLToPath(new URL("../../agents/.moolam/agent-images/", import.meta.url));
const ON = process.env.CLAIMS_SHOTS === "1";

function findBrowser(): string | null {
  const playwright = join(process.env.LOCALAPPDATA ?? join(process.env.HOME ?? "", ".cache"), "ms-playwright");
  if (!existsSync(playwright)) return null;
  for (const shell of readdirSync(playwright).filter((name) => name.startsWith("chromium_headless_shell-")).sort().reverse()) {
    for (const inner of ["chrome-headless-shell-win64", "chrome-win", "chrome-headless-shell-linux64", "chrome-linux"]) {
      for (const exe of ["chrome-headless-shell.exe", "headless_shell.exe", "chrome-headless-shell", "headless_shell"]) {
        const path = join(playwright, shell, inner, exe);
        if (existsSync(path)) return path;
      }
    }
  }
  return null;
}

const browserPath = ON ? findBrowser() : null;

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
    if (reply.error !== undefined) throw new Error(`${method}: ${reply.error.message}`);
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
  if (browserPath === null) return;
  const source = readFileSync(join(WEB, "styles/globals.css"), "utf8");
  css = (await postcss([tailwind({ base: WEB })]).process(source, { from: join(WEB, "styles/globals.css") })).css;
  profile = await mkdtemp(join(tmpdir(), "moolam-claims-shots-"));
  chrome = spawn(
    browserPath,
    ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--hide-scrollbars", "about:blank"],
    { stdio: "ignore" },
  );
  let port: string | null = null;
  for (let tries = 0; tries < 100 && port === null; tries += 1) {
    try {
      port = (await readFile(join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0].trim() || null;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  if (port === null) throw new Error("Chrome never opened its DevTools port");
  const targets = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as { type: string; webSocketDebuggerUrl: string }[];
  const page = targets.find((target) => target.type === "page");
  if (page === undefined) throw new Error("Chrome opened no page");
  tab = await Tab.open(page.webSocketDebuggerUrl);
  await tab.send("Page.enable");
}, 60_000);

afterAll(async () => {
  tab?.close();
  chrome?.kill();
  if (profile !== null) {
    await new Promise((resolve) => setTimeout(resolve, 300));
    await rm(profile, { recursive: true, force: true }).catch(() => undefined);
  }
});

const Provider = NextIntlClientProvider as unknown as FunctionComponent<{ locale: string; messages: unknown; timeZone: string }>;

const NOOP = () => undefined;
const KEY_A = `0x${"a1".repeat(32)}` as Hex;
const KEY_B = `0x${"b2".repeat(32)}` as Hex;
const WALLET = "0x559F357aDa3A96d11AEa679eC0D622E4AF15F67c" as Hex;
const HASH = `0x${"7e".repeat(32)}` as Hex;
const GATEWAY = "https://gateway.pinata.cloud/ipfs/";

const STILL_FILES = [
  "lighthouse-in-storm-cinematic-poster-29957147.jpg",
  "nilgiri-dawn-tea-train-35fcd08a.jpg",
  "marina-beach-kite-sellers-at-dusk-0c45b008.jpg",
  "meenakshi-temple-gopuram-in-monsoon-night-rain-07a0bfba.jpg",
  "single-light-jazz-trumpeter-dece558a.jpg",
];
const CIDS = STILL_FILES.map((_, n) => `bafkreistill${String(n).padStart(2, "0")}${"q".repeat(44)}`);

function passport(n: number): Hex {
  return `0x${(0x9c4e00 + n).toString(16).padStart(64, "f")}` as Hex;
}

const TERMS = {
  aiTraining: "notAllowed",
  aiGenerativeTraining: "notAllowed",
  aiInference: "allowed",
  dataMining: "notAllowed",
  constraintInfo: "",
} as const;

const TITLES = ["Lighthouse in a storm", "Tea train at Nilgiri dawn", "Kite sellers at Marina", "Gopuram in monsoon rain", "One light, one trumpet"];

const OFFERS: ClaimsAnswer = {
  offers: [
    ...[0, 1, 2].map((n) => ({
      ticketId: String(n + 1).padStart(32, "0"),
      passportId: passport(n),
      platform: { name: "Dreamloom", keyHash: KEY_A },
      verifiedBy: "google" as const,
      preview: { title: TITLES[n], image: `ipfs://${CIDS[n]}` },
      createdAt: 1_790_000_000 - n,
    })),
    {
      ticketId: "4".padStart(32, "0"),
      passportId: passport(3),
      platform: { name: "Dreamloom", keyHash: KEY_A },
      verifiedBy: "google",
      preview: null,
      createdAt: 1_789_990_000,
    },
    {
      ticketId: "5".padStart(32, "0"),
      passportId: passport(4),
      platform: { name: "Inkwell Studio", keyHash: KEY_B },
      verifiedBy: "email-code",
      preview: { title: TITLES[4], image: `ipfs://${CIDS[4]}` },
      createdAt: 1_789_980_000,
    },
  ],
  waiting: [],
  standing: [{ platform: { name: "Dreamloom", keyHash: KEY_A }, destination: WALLET }],
  muted: [],
};

const waitingRow = (state: "accepted" | "failed" | "delivered", n: number, name = "Dreamloom", key = KEY_A) => ({
  ticketId: String(20 + n).padStart(32, "0"),
  passportId: passport(n),
  platform: { name, keyHash: key },
  state,
  destination: WALLET,
  terms: TERMS,
});

const ROWS: ConfirmRow[] = [0, 1, 2].map((n) => ({
  passportId: passport(n),
  platform: "Dreamloom",
  art: { title: TITLES[n], imageUrl: `${GATEWAY}${CIDS[n]}` },
}));

function confirmCard(step: Parameters<typeof ConfirmCard>[0]["step"], extra: Partial<Parameters<typeof ConfirmCard>[0]> = {}) {
  return createElement(ConfirmCard, { rows: ROWS, terms: TERMS, step, failure: null, onConfirm: NOOP, onRecheck: NOOP, onReread: NOOP, ...extra });
}

function view(answer: ClaimsAnswer, extra: Partial<Parameters<typeof ClaimsView>[0]> = {}): ReactElement {
  return createElement(ClaimsView, {
    answer,
    emails: ["ram@example.com"],
    busy: {},
    failures: {},
    refusal: null,
    watching: true,
    pending: { status: "idle", groups: [] },
    confirmedNow: [],
    renderConfirm: () => null,
    onMine: NOOP,
    onNotMine: NOOP,
    onStop: NOOP,
    onUnmute: NOOP,
    onReload: NOOP,
    onReread: NOOP,
    onSignIn: NOOP,
    ...extra,
  });
}

const STATES: Record<string, ReactElement> = {
  "1-offers": view(OFFERS),
  "2-handover": view({
    offers: [],
    waiting: [waitingRow("accepted", 0), waitingRow("accepted", 1), waitingRow("failed", 7, "Inkwell Studio", KEY_B)],
    standing: [{ platform: { name: "Dreamloom", keyHash: KEY_A }, destination: WALLET }],
    muted: [{ platform: { name: "Pixel Forge", keyHash: `0x${"c3".repeat(32)}` as Hex } }],
  }),
  "3-confirm": view(
    { offers: [], waiting: [0, 1, 2].map((n) => waitingRow("delivered", n)), standing: [], muted: [] },
    {
      pending: { status: "ready", groups: [{ key: "a", terms: TERMS, entries: [], ids: ROWS.map((row) => row.passportId) }] },
      renderConfirm: () => confirmCard("ready"),
    },
  ),
  "4-confirming": view(
    { offers: [], waiting: [0, 1, 2].map((n) => waitingRow("delivered", n)), standing: [], muted: [] },
    {
      pending: { status: "ready", groups: [{ key: "a", terms: TERMS, entries: [], ids: ROWS.map((row) => row.passportId) }] },
      renderConfirm: () => confirmCard("confirming"),
    },
  ),
  "5-confirmed": view(
    { offers: [], waiting: [0, 1, 2].map((n) => waitingRow("delivered", n)), standing: [], muted: [] },
    {
      pending: { status: "ready", groups: [{ key: "a", terms: TERMS, entries: [], ids: ROWS.map((row) => row.passportId) }] },
      renderConfirm: () => confirmCard("done", { txHash: HASH }),
    },
  ),
  "6-send-failed": view(
    { offers: [], waiting: [0, 1, 2].map((n) => waitingRow("delivered", n)), standing: [], muted: [] },
    {
      pending: { status: "ready", groups: [{ key: "a", terms: TERMS, entries: [], ids: ROWS.map((row) => row.passportId) }] },
      renderConfirm: () => confirmCard("failed", { failure: { key: "declined", next: "again" } }),
    },
  ),
  "7-refused": view(OFFERS, {
    failures: { [failureKey("offer", KEY_A)]: { key: "notOpen", next: "reload", word: "not-open" } },
  }),
  "8-settings-only": view({
    offers: [],
    waiting: [],
    standing: [{ platform: { name: "Dreamloom", keyHash: KEY_A }, destination: WALLET }],
    muted: [{ platform: { name: "Pixel Forge", keyHash: `0x${"c3".repeat(32)}` as Hex } }],
  }),
  "9-read-failed": createElement(ReadFailed, { refusal: { key: "badResponse", next: "again" }, reading: false, onAgain: NOOP, onSignIn: NOOP }),
};

/** The section where the page puts it: under the page's own opening, above the grid. */
function page(markup: string): string {
  const stills = Object.fromEntries(
    CIDS.map((cid, n) => [`${GATEWAY}${cid}`, `data:image/jpeg;base64,${readFileSync(join(STILLS, STILL_FILES[n])).toString("base64")}`]),
  );
  let body = markup;
  for (const [url, data] of Object.entries(stills)) body = body.split(url).join(data);
  return `<!doctype html><html class="dark" lang="en" style="--font-display:'Archivo';--font-body:'Inter';--font-mono:'IBM Plex Mono'">
<head>
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wght@500;600;700&family=Inter:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=block">
<style>${css}</style>
<style>[style*="opacity:0"]{opacity:1!important;transform:none!important}</style>
</head>
<body class="bg-bg text-text">
<div class="relative mx-auto w-full max-w-[1400px] px-5 pb-16 pt-7 sm:px-8 sm:pb-24 sm:pt-9">
<p class="font-mono text-[11px] uppercase tracking-[0.24em] text-text-faint">Your account</p>
<h1 class="mt-3 mb-10 font-display text-[clamp(3rem,10vw,9rem)] font-semibold uppercase leading-[0.9] tracking-[-0.04em]">Made by you</h1>
${body}
<div class="h-40 border-t border-line pt-6 font-mono text-[10px] uppercase tracking-[0.2em] text-text-faint">Your pictures (the grid sits here)</div>
</div>
</body></html>`;
}

async function shoot(name: string, html: string, width: number): Promise<string> {
  if (tab === null) throw new Error("no browser");
  await tab.send("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: width < 600 });
  const tree = await tab.send<{ frameTree: { frame: { id: string } } }>("Page.getFrameTree");
  await tab.send("Page.setDocumentContent", { frameId: tree.frameTree.frame.id, html });
  await tab.send("Runtime.evaluate", {
    expression: "Promise.all([document.fonts.ready, ...[...document.images].map((i) => i.decode().catch(() => null))]).then(() => new Promise((r) => setTimeout(r, 400)))",
    awaitPromise: true,
  });
  const size = await tab.send<{ result: { value: string } }>("Runtime.evaluate", {
    expression: "JSON.stringify({ h: document.documentElement.scrollHeight, w: document.documentElement.scrollWidth })",
    returnByValue: true,
  });
  const { h, w } = JSON.parse(size.result.value) as { h: number; w: number };
  const shot = await tab.send<{ data: string }>("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: true,
    clip: { x: 0, y: 0, width, height: h, scale: 1 },
  });
  const path = join(OUT, `${name}-${width}.png`);
  writeFileSync(path, Buffer.from(shot.data, "base64"));
  // A page wider than the screen scrolls sideways on a phone, which is a fault worth failing on.
  expect(w, `${name} at ${width}`).toBeLessThanOrEqual(width);
  return path;
}

describe.skipIf(browserPath === null)("Waiting for you, photographed", () => {
  it("writes every state at 1440 and 375", async () => {
    mkdirSync(OUT, { recursive: true });
    const written: string[] = [];
    for (const [name, node] of Object.entries(STATES)) {
      const markup = renderToStaticMarkup(createElement(Provider, { locale: "en", messages: en, timeZone: "Asia/Kolkata" }, node));
      for (const width of [1440, 375]) written.push(await shoot(name, page(markup), width));
    }
    expect(written).toHaveLength(Object.keys(STATES).length * 2);
  }, 180_000);
});
