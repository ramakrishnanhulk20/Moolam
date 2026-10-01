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
import { getAddress, parseEther, type Hex } from "viem";
import en from "@/messages/en.json";
import type { Dispute } from "@/lib/chain/registry";
import { decisionView } from "@/lib/disputes/decisions";
import { BURN_ADDRESS, initialFlagState } from "@/lib/disputes/flag";
import type { FlagPassport } from "@/lib/disputes/useFlagPassport";
import type { HolderAnswer as HolderAnswerHook } from "@/lib/disputes/useHolderAnswer";

/**
 * Pictures of the challenge screens (WO-284c) at 1440 and 375 px, light and dark, for the head
 * chef's review: the flag panel with its rules, a challenged passport as its holder sees it (the
 * form and each of its states) and as a stranger sees it, decided passports with their reasons,
 * and My pictures' challenged list. No sign-in, no wallet and no transaction: every answer is a
 * fixture, and the markup is the server render laid in a headless Chrome over the site's own
 * stylesheet. The resolver console's publish step is not here: it waits on WO-275c.
 *
 * Off by default, because it opens a browser and writes files outside the package. Run it with
 * CHALLENGES_SHOTS=1. Motion is drawn at its resting frame.
 */

const flagStub = vi.hoisted(() => ({ current: null as unknown as FlagPassport }));
const answerStub = vi.hoisted(() => ({ current: null as unknown as HolderAnswerHook }));
vi.mock("@/lib/disputes/useFlagPassport", () => ({ useFlagPassport: () => flagStub.current }));
vi.mock("@/lib/disputes/useHolderAnswer", () => ({ useHolderAnswer: () => answerStub.current }));
vi.mock("@/lib/passport/refresh", () => ({ refreshPassport: async () => undefined }));
vi.mock("@/lib/i18n/routing", () => ({
  Link: (props: { href: string; className?: string; children?: unknown }) =>
    createElement("a", { href: props.href, className: props.className }, props.children as never),
  useRouter: () => ({ refresh: () => undefined }),
}));
// A still has no wallet to wait for, so the slot draws what the hook stub says at once.
vi.mock("@/components/challenge/HolderAnswer", async () => {
  const panel = await import("@/components/challenge/HolderAnswerPanel");
  return { HolderAnswer: panel.HolderAnswerPanel };
});

const { Challenge } = await import("@/components/passport/Challenge");
const { ChallengeRecord } = await import("@/components/challenge/ChallengeRecord");
const { DecisionBlock } = await import("@/components/challenge/DecisionBlock");
const { ChallengedList } = await import("@/components/mine/ChallengedPictures");

const WEB = fileURLToPath(new URL("..", import.meta.url));
const OUT = fileURLToPath(new URL("../../../kitchen/reports/challenges/", import.meta.url));
const STILLS = fileURLToPath(new URL("../../agents/.moolam/agent-images/", import.meta.url));
const ON = process.env.CHALLENGES_SHOTS === "1";

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
  profile = await mkdtemp(join(tmpdir(), "moolam-challenges-shots-"));
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

const Provider = NextIntlClientProvider as unknown as FunctionComponent<{
  locale: string;
  messages: unknown;
  timeZone: string;
  formats?: unknown;
}>;

const NOOP = () => undefined;
const ASYNC_NOOP = async () => undefined;
const PASSPORT = `0x${"5c3e".repeat(16)}` as Hex;
const HOLDER = getAddress("0x551610a063BcAd79e6bd25dc55cEe92Ba3FD960a");
const CHALLENGER = getAddress("0x85a88Ca81Ff5F681D96AB86fA60ccB8452a139a6");
const OPENED_AT = 1_790_850_000;
const UNTIL = OPENED_AT + 14 * 86_400;
const CID = `bafkreidrea${"s".repeat(49)}`;
const STILL = "nilgiri-dawn-tea-train-35fcd08a.jpg";
const STILL_URL = "https://gateway.pinata.cloud/ipfs/bafkreistill00";

const CLAIM =
  "The same photograph was posted on my Flickr account on 14 March 2019, and the camera's original file, with its serial number, is linked in my evidence.";
const ANSWER =
  "I took this on the Nilgiri line at 6:10 am on 2 February 2024, from the third carriage.\n\nThe raw file from my camera is on my drive with its EXIF intact, and I can share it with Moolam. The Flickr post the challenge names is a crop of my picture, uploaded five years after its own date says.";

function dispute(over: Partial<Dispute> = {}): Dispute {
  return { challenger: CHALLENGER, bond: parseEther("1"), evidenceHash: `0x${"ab".repeat(32)}`, status: 1, openedAt: BigInt(OPENED_AT), ...over };
}

function hook(over: Partial<HolderAnswerHook> = {}): HolderAnswerHook {
  return { ready: true, isHolder: true, text: "", phase: "idle", refusal: null, answerURI: null, sent: null, setText: NOOP, submit: ASYNC_NOOP, ...over };
}

function flag(): FlagPassport {
  return {
    ready: true,
    authenticated: true,
    isOwner: false,
    wallet: CHALLENGER,
    reading: false,
    bond: parseEther("1"),
    balance: parseEther("3.2"),
    check: { enough: true, shortfall: 0n },
    treasury: BURN_ADDRESS,
    state: { ...initialFlagState, open: true, reason: CLAIM },
    actions: { open: NOOP, close: NOOP, setReason: NOOP, submit: ASYNC_NOOP, recheck: ASYNC_NOOP, signIn: NOOP, reset: NOOP },
  };
}

const answered = { kind: "answered", words: { text: ANSWER, holder: HOLDER, answerURI: `ipfs://${CID}` } } as const;
const evidence = { reason: CLAIM, uri: "data:text/plain;charset=utf-8,claim" };

interface Screen {
  hook?: HolderAnswerHook;
  node: () => ReactElement;
}

function record(over: Partial<Parameters<typeof ChallengeRecord>[0]>): () => ReactElement {
  return function challengeRecord() {
    return createElement(ChallengeRecord, { passportId: PASSPORT, dispute: dispute(), evidence, answer: { kind: "waiting", until: UNTIL }, ...over });
  };
}

const SCREENS: Record<string, Screen> = {
  "1-flag-panel": {
    node: () => {
      flagStub.current = flag();
      return createElement(Challenge, { passportId: PASSPORT, owner: HOLDER, disputeOpen: false });
    },
  },
  "2-holder-form": { hook: hook({ text: ANSWER }), node: record({}) },
  "3-holder-signing": { hook: hook({ text: ANSWER, phase: "signing" }), node: record({}) },
  "4-holder-refused": { hook: hook({ text: "Mine.\tReally.", refusal: "notPrintable" }), node: record({}) },
  "5-holder-done": { hook: hook({ phase: "done", sent: ANSWER, answerURI: `ipfs://${CID}` }), node: record({}) },
  "6-stranger-waiting": { hook: hook({ isHolder: false }), node: record({}) },
  "7-stranger-answered": { node: record({ answer: answered }) },
  "8-decided-upheld": {
    node: record({
      dispute: dispute({ status: 2 }),
      answer: answered,
      decision: createElement(DecisionBlock, {
        view: decisionView(
          { status: 2 },
          { kind: "published", decision: { upheld: true, reasonsURI: `ipfs://${CID}`, publishedAt: OPENED_AT + 9 * 86_400 } },
          OPENED_AT + 8 * 86_400,
        )!,
      }),
    }),
  },
  "9-decided-rejected-no-reasons": {
    node: record({
      dispute: dispute({ status: 3 }),
      answer: { kind: "none" },
      decision: createElement(DecisionBlock, { view: decisionView({ status: 3 }, { kind: "none" }, OPENED_AT + 15 * 86_400)! }),
    }),
  },
  "10-mine-challenged": {
    hook: hook({ text: "" }),
    node: () =>
      createElement(ChallengedList, {
        rows: [
          {
            passportId: PASSPORT,
            challenger: CHALLENGER,
            openedAt: OPENED_AT,
            reason: CLAIM,
            title: "Tea train at Nilgiri dawn",
            imageUrl: STILL_URL,
            answer: { kind: "waiting", until: UNTIL },
          },
          {
            passportId: `0x${"7a1f".repeat(16)}` as Hex,
            challenger: CHALLENGER,
            openedAt: OPENED_AT - 3 * 86_400,
            reason: null,
            title: "Kite sellers at Marina",
            answer: answered,
          },
        ],
      }),
  },
};

function page(markup: string, theme: "light" | "dark", mine: boolean): string {
  const still = `data:image/jpeg;base64,${readFileSync(join(STILLS, STILL)).toString("base64")}`;
  return `<!doctype html><html class="${theme}" lang="en" style="--font-display:'Archivo';--font-body:'Inter';--font-mono:'IBM Plex Mono'">
<head>
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wght@500;600;700&family=Inter:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=block">
<style>${css}</style>
<style>[style*="opacity:0"]{opacity:1!important;transform:none!important}.rise{animation:none!important}</style>
</head>
<body class="bg-bg text-text">
<div class="relative mx-auto w-full max-w-[1400px] px-5 pb-16 pt-7 sm:px-8 sm:pb-24 sm:pt-9">
<p class="font-mono text-[11px] uppercase tracking-[0.24em] text-text-faint">${mine ? "Your account" : "Passport"}</p>
<h1 class="mt-3 mb-10 font-display text-[clamp(2.4rem,7vw,6rem)] font-semibold uppercase leading-[0.9] tracking-[-0.04em]">${mine ? "Made by you" : "Tea train at Nilgiri dawn"}</h1>
${markup.split(STILL_URL).join(still)}
</div>
</body></html>`;
}

async function shoot(name: string, html: string, width: number, theme: string): Promise<string> {
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
  const path = join(OUT, `${name}-${width}-${theme}.png`);
  writeFileSync(path, Buffer.from(shot.data, "base64"));
  // A page wider than the screen scrolls sideways on a phone, which is a fault worth failing on.
  expect(w, `${name} at ${width} in ${theme}`).toBeLessThanOrEqual(width);
  return path;
}

describe.skipIf(browserPath === null)("the challenge screens, photographed", () => {
  it("writes every screen at 1440 and 375, light and dark", async () => {
    mkdirSync(OUT, { recursive: true });
    const written: string[] = [];
    for (const [name, screen] of Object.entries(SCREENS)) {
      if (screen.hook !== undefined) answerStub.current = screen.hook;
      const markup = renderToStaticMarkup(
        createElement(
          Provider,
          { locale: "en", messages: en, timeZone: "Asia/Kolkata", formats: { dateTime: { moment: { dateStyle: "medium", timeStyle: "short" } } } },
          screen.node(),
        ),
      );
      for (const theme of ["light", "dark"] as const) {
        for (const width of [1440, 375]) written.push(await shoot(name, page(markup, theme, name.includes("mine")), width, theme));
      }
    }
    expect(written).toHaveLength(Object.keys(SCREENS).length * 4);
  }, 600_000);
});
