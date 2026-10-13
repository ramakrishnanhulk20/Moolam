import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createElement, type FunctionComponent } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";
import type { Hex } from "viem";
import en from "@/messages/en.json";
import type { Art } from "@/components/passport/art";
import type { PassportMarkFacts } from "@/components/mark/read";
import type { ExplorePlate } from "@/components/explore/sort";
import type { FirstRegistration, MatchedPassport } from "@/components/verify/lookup";
import type { Passport } from "@/lib/chain/registry";
import type { TopFact } from "@/components/passport/top-facts";
import type { RecheckControl } from "@/lib/recheck/useRecheck";
import { readAnswer } from "@/components/verify/answer";
import { verifyResponseSchema } from "@/lib/verifier/client";

/**
 * Pictures of the trust mark for a visual review (WO-284a): a passport
 * in each mark state, the look-alike block, the later line, Moolam's grey
 * search line, the claim block, an Explore sheet with every mark's word, and a
 * verify answer that leads with an earlier registration. Each at 1440 and
 * 375 px, in light and in dark.
 *
 * Every fact is a fixture: no chain, no index, no verify service. The markup
 * is the server render each screen would hydrate, laid in a headless Chrome
 * over the site's own stylesheet compiled the way the app compiles it.
 *
 * Off by default, because it opens a browser and writes files outside the
 * package. Run it with MARKS_SHOTS=1. Motion is drawn at its resting frame.
 */

const STILLS = fileURLToPath(new URL("../../agents/.moolam/agent-images/", import.meta.url));
const FALLBACK_STILL = fileURLToPath(new URL("../public/hero/frame-reencode-q60.jpg", import.meta.url));

function still(name: string): string {
  const path = join(STILLS, name);
  return `data:image/jpeg;base64,${readFileSync(existsSync(path) ? path : FALLBACK_STILL).toString("base64")}`;
}

vi.mock("next-intl/server", async () => {
  const { createFormatter, createTranslator } = await import("next-intl");
  const { timeFormats } = await import("@/lib/i18n/timeFormats");
  const messages = (await import("@/messages/en.json")).default;
  return {
    getTranslations: async (namespace?: string) => createTranslator({ locale: "en", messages, namespace: namespace as never }),
    getFormatter: async () => createFormatter({ locale: "en", timeZone: "UTC", formats: timeFormats }),
  };
});

vi.mock("@/lib/i18n/routing", () => ({
  Link: (props: { href: string; children?: unknown; className?: string }) =>
    createElement("a", { href: props.href, className: props.className }, props.children as never),
  useRouter: () => ({ refresh: () => undefined, push: () => undefined }),
}));
vi.mock("next/link", () => ({
  default: (props: { href: string; children?: unknown }) => createElement("a", { href: props.href }, props.children as never),
  useLinkStatus: () => ({ pending: false }),
}));
vi.mock("next/navigation", () => ({ useParams: () => ({ locale: "en" }), useRouter: () => ({ refresh: () => undefined }) }));
vi.mock("@/lib/passport/refresh", () => ({ refreshPassport: async () => undefined }));
vi.mock("@/components/mark/read", async () => (await import("./mark-fixtures")).markReadMock);
vi.mock("@/lib/data/platform-label", () => ({ creditFor: async () => null }));
vi.mock("@/lib/passport/useEditPassport", async () => {
  const { initialEditState } = await import("@/lib/passport/edit");
  const nothing = async () => undefined;
  return {
    useEditPassport: () => ({
      ready: true,
      isOwner: true,
      configured: true,
      granted: true,
      granting: false,
      revoking: false,
      grantFailure: null,
      state: { ...initialEditState, title: "Nets, cropped for the print" },
      actions: {
        grant: nothing,
        revoke: nothing,
        choose: () => undefined,
        setTitle: () => undefined,
        setNote: () => undefined,
        submit: nothing,
        recheck: nothing,
        signIn: () => undefined,
        reset: () => undefined,
      },
    }),
  };
});
vi.mock("@/lib/recheck/useRecheck", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/recheck/useRecheck")>()),
  useRecheckRequest: (): RecheckControl => ({
    state: { kind: "none" },
    spent: false,
    checking: false,
    actions: { request: () => undefined, check: () => undefined },
  }),
}));
// The real picture component goes through next/image, which only a running
// Next server can answer. A still laid where it would sit is the same frame.
vi.mock("@/components/passport/Picture", async () => {
  const { createElement: element } = await import("react");
  return {
    Picture: (props: { sources: string[]; className?: string }) =>
      element("img", {
        src: props.sources[0],
        alt: "",
        className: `absolute inset-0 h-full w-full ${props.className ?? ""}`,
      }),
  };
});

const { Poster } = await import("@/components/passport/Poster");
const { Facts } = await import("@/components/passport/Facts");
const { FactStrip } = await import("@/components/passport/TopFacts");
const { markCopy } = await import("@/components/mark/copy");
const { Plate } = await import("@/components/explore/Plate");
const { AnswerCard } = await import("@/components/verify/AnswerCard");
const { Editor } = await import("@/components/passport/Editor");

const WEB = fileURLToPath(new URL("..", import.meta.url));
const OUT = fileURLToPath(new URL("../../../kitchen/reports/marks/", import.meta.url));
const ON = process.env.MARKS_SHOTS === "1";

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
  profile = await mkdtemp(join(tmpdir(), "moolam-marks-shots-"));
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

const ID = `0x${"3d".repeat(16)}${"ae".repeat(16)}` as Hex;
const EARLIER = `0x${"0c".repeat(16)}${"45".repeat(16)}` as Hex;
const LATER = `0x${"9f".repeat(16)}${"21".repeat(16)}` as Hex;
const CREATOR = "0x551610a063BcAd79e6bd25dc55cEe92Ba3FD960a" as Hex;
const REGISTERED = 1_790_052_000;
const NETS = "monsoon-fishing-nets-drying-cdb25d37.jpg";

const passport: Passport = {
  id: ID,
  exactHash: ID,
  parentId: `0x${"0".repeat(64)}` as Hex,
  creator: CREATOR,
  generatorAgentId: 0n,
  phash: 0xd1c3a5f0e2b49786n,
  blockhash256: "0x001e003e37fc17ff003e00de16fe07ff07ff83fe03901f90c3f387e00ff007f0" as Hex,
  manifestHash: `0x${"0".repeat(64)}` as Hex,
  kind: 1,
  fingerprintVersion: 1,
  registeredAt: BigInt(REGISTERED),
  disputed: false,
  metadataURI: "ipfs://bafkreidocument",
};

const art: Art = {
  title: "Monsoon Fishing Nets Drying",
  imageUrl: still(NETS),
  thumbnailUrl: still(NETS),
  statements: { sworn: true },
  missing: false,
};

const sealedArt: Art = {
  title: "Kept in the drawer",
  sealed: true,
  blockhash: passport.blockhash256,
  statements: { sworn: true },
  missing: false,
};

const strip: TopFact[] = [
  { key: "madeBy", label: en.passport.facts.madeBy, value: "0x5516…960a", href: "#made-by", tone: "text", mono: true },
  { key: "drawnBy", label: en.passport.facts.drawnBy, value: en.kind["1"], href: "#drawn-by", tone: "faint" },
  { key: "aiUse", label: en.passport.facts.aiUse, value: en.passport.consent.summary.closed, href: "#ai-use", tone: "pending" },
  { key: "rechecked", label: en.passport.facts.rechecked, value: en.passport.facts.notYet, href: "#second-opinion", tone: "faint" },
];

const quiet = { lookalike: { kind: "quiet" } as const, later: { first: null, count: 0 }, earlier: null, challenge: null, testRun: false };
const earlierPassport = { id: EARLIER, title: "Nets at Kovalam, first light", registeredAt: REGISTERED - 86_400 * 41 };
const checked = { network: true, matched: true, phashBits: 0, at: REGISTERED + 540 };

const PASSPORTS: Record<string, { facts: PassportMarkFacts; art?: Art; facts2?: Art; platform?: string }> = {
  "second-print": {
    facts: { ...quiet, mark: { state: "mismatch", verdict: { ...checked, matched: false, phashBits: 3 }, secondPrint: true }, registeredAt: REGISTERED },
  },
  "shown-earlier": {
    facts: { ...quiet, mark: { state: "waiting" }, registeredAt: REGISTERED, lookalike: { kind: "searching", earlier: earlierPassport } },
    facts2: { ...art, statements: { sworn: true, seenEarlier: EARLIER } },
  },
  platform: {
    facts: { ...quiet, mark: { state: "checked", verdict: checked }, registeredAt: REGISTERED },
    facts2: { ...art, statements: { sworn: false, platformStatement: "Imagined by a Dreamloom member, who typed the prompt and chose this picture." } },
    platform: "Dreamloom",
  },
  upheld: { facts: { ...quiet, mark: { state: "upheld" }, registeredAt: REGISTERED } },
  mismatch: {
    facts: { ...quiet, mark: { state: "mismatch", verdict: { ...checked, matched: false, phashBits: 27 }, secondPrint: false }, registeredAt: REGISTERED },
  },
  lookalike: {
    facts: {
      mark: { state: "lookalike", lookalike: { network: true, valid: true, earlier: EARLIER, executedAt: REGISTERED + 600 } },
      registeredAt: REGISTERED,
      challenge: null,
      earlier: earlierPassport,
      lookalike: { kind: "found", earlier: earlierPassport, sealed: false, bits: 2, at: REGISTERED + 600 },
      later: { first: null, count: 0 },
      testRun: false,
    },
    facts2: {
      ...art,
      statements: {
        sworn: true,
        seenEarlier: EARLIER,
        seenOnline: { count: 4, pages: ["https://www.example-photo-site.com/monsoon/kovalam-nets", "https://blog.example.org/2026/09/nets"] },
      },
    },
  },
  challenged: {
    facts: { ...quiet, mark: { state: "challenged" }, registeredAt: REGISTERED, challenge: { bond: "1", answerBy: REGISTERED + 14 * 86_400 } },
  },
  waiting: {
    facts: {
      ...quiet,
      mark: { state: "waiting" },
      registeredAt: REGISTERED,
      lookalike: { kind: "searching", earlier: earlierPassport },
    },
  },
  checked: {
    facts: {
      ...quiet,
      mark: { state: "checked", verdict: checked },
      registeredAt: REGISTERED,
      later: { first: { id: LATER, title: "Fishing nets, re-saved", registeredAt: REGISTERED + 86_400 * 6 }, count: 2 },
    },
  },
  "checked-none": {
    facts: { ...quiet, mark: { state: "checked", verdict: checked }, registeredAt: REGISTERED, lookalike: { kind: "none", at: REGISTERED + 600 } },
  },
  sealed: { facts: { ...quiet, mark: { state: "sealed" }, registeredAt: REGISTERED }, art: sealedArt },
  nothing: { facts: { ...quiet, mark: { state: "nothing" }, registeredAt: REGISTERED } },
  unread: {
    facts: { ...quiet, mark: { state: "unread" }, registeredAt: REGISTERED },
    facts2: { ...art, statements: { sworn: false } },
  },
};

async function passportPage(name: string): Promise<string> {
  const entry = PASSPORTS[name];
  const shown = entry.art ?? art;
  const copy = await markCopy(entry.facts, "en");
  const poster = await Poster({ passport, art: shown, locale: "en", strip: FactStrip({ facts: strip }), mark: copy });
  const record =
    entry.facts2 === undefined
      ? null
      : await Facts({
          passport,
          art: entry.facts2,
          owner: CREATOR,
          hasPasskey: true,
          standing: "unverified",
          txHash: null,
          platform: entry.platform === undefined ? null : { status: "kit", name: entry.platform, platform: {} as never },
          credit: null,
        });
  return renderToStaticMarkup(
    createElement(Provider, { locale: "en", messages: en, timeZone: "UTC" }, createElement("article", null, poster, record)),
  );
}

const GRID_STATES = ["lookalike", "checked", "waiting", "mismatch", "challenged", "upheld", "nothing", "sealed"] as const;
const PLATE_STILLS = [
  NETS,
  "marina-beach-kite-sellers-at-dusk-0c45b008.jpg",
  "nilgiri-dawn-tea-train-35fcd08a.jpg",
  "meenakshi-temple-gopuram-in-monsoon-night-rain-07a0bfba.jpg",
  "madurai-tiffin-at-five-tungsten-steam-portrait-0a3c8368.jpg",
  "dhanushkodi-ghost-town-church-under-storm-sky-f08bea9e.jpg",
  "blue-hour-quiet-greenhouse-7cb4aead.jpg",
];
const PLATE_TITLES = [
  "Fishing nets, re-saved",
  "Marina Beach Kite Sellers at Dusk",
  "Nilgiri Dawn Tea Train",
  "Gopuram in Monsoon Rain",
  "Madurai Tiffin at Five",
  "Dhanushkodi Church Under Storm",
  "Blue Hour Greenhouse",
  "Kept in the drawer",
];

function explorePage(): string {
  const plates: ExplorePlate[] = GRID_STATES.map((mark, n) => ({
    id: `0x${(0x7c00 + n).toString(16).padStart(64, "a")}`,
    kind: n % 3 === 0 ? 1 : 0,
    registeredAt: REGISTERED - n * 86_400,
    title: PLATE_TITLES[n],
    thumbnailUrl: mark === "sealed" || mark === "nothing" ? null : still(PLATE_STILLS[n]),
    manifest: n % 2 === 0,
    rechecked: mark === "checked" || mark === "mismatch" || mark === "lookalike",
    chainlink: true,
    disputed: mark === "upheld",
    agentId: null,
    consent: null,
    sealed: mark === "sealed",
    blockhash: passport.blockhash256,
    mark,
  }));
  return renderToStaticMarkup(
    createElement(
      Provider,
      { locale: "en", messages: en, timeZone: "UTC" },
      createElement(
        "div",
        { className: "mx-auto w-full max-w-[1400px] px-5 pb-16 pt-8 sm:px-8" },
        createElement("p", { className: "font-mono text-[11px] uppercase tracking-[0.24em] text-text-faint" }, en.explore.title),
        createElement(
          "div",
          { className: "mt-6 grid grid-cols-2 gap-px border border-line bg-line sm:grid-cols-3 lg:grid-cols-4" },
          ...plates.map((plate) => createElement(Plate, { key: plate.id, plate })),
        ),
      ),
    ),
  );
}

function verifyPage(): string {
  const HEADLINE = LATER;
  const closest: MatchedPassport = {
    id: HEADLINE,
    kind: 1,
    registeredAt: String(REGISTERED + 86_400 * 6),
    creator: "0x8a1d0C1f3E0b9c2B5d3F6A4e7C9b2D1f0E3a5C7b",
    generatorAgentId: "0",
    disputed: false,
    title: "Fishing nets, re-saved",
    thumbnailUrl: still(NETS),
    sealed: false,
  };
  const first: FirstRegistration = {
    ...closest,
    id: EARLIER,
    registeredAt: String(REGISTERED),
    title: "Nets at Kovalam, first light",
    creator: CREATOR,
    holder: CREATOR,
  };
  const consent = {
    source: "chain",
    stated: true,
    standard: "cawg.training-mining/1.1",
    aiTraining: "notAllowed",
    aiGenerativeTraining: "notAllowed",
    aiInference: "notAllowed",
    dataMining: "notAllowed",
    at: REGISTERED + 100,
    writer: CREATOR,
  };
  const answer = readAnswer(
    verifyResponseSchema.parse({
      result: {
        exact: null,
        best: { id: HEADLINE, phashDistance: 1, blockhashDistance: 8, variant: "identity", score: 0.93, consent: { source: "chain", stated: false } },
        matches: [
          { id: HEADLINE, phashDistance: 1, blockhashDistance: 8, variant: "identity", score: 0.93, consent: { source: "chain", stated: false } },
          { id: EARLIER, phashDistance: 2, blockhashDistance: 10, variant: "identity", score: 0.9, consent },
        ],
        confidence: 0.93,
        queried: {
          sha256: `0x${"ab".repeat(32)}`,
          phash: "15114720397716408198",
          blockhash: `0x${"cd".repeat(32)}`,
          width: 1024,
          height: 1280,
          format: "jpeg",
        },
        firstRegisteredId: EARLIER,
      },
      manifest: { present: false },
      index: { loadedAt: REGISTERED + 86_400 * 7, stale: false },
    }),
  );
  return renderToStaticMarkup(
    createElement(
      Provider,
      { locale: "en", messages: en, timeZone: "UTC" },
      createElement(
        "div",
        { className: "mx-auto grid w-full max-w-[1400px] gap-12 px-5 pb-16 pt-8 sm:px-8 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)] lg:gap-16" },
        createElement(
          "div",
          { className: "grain relative aspect-[4/5] overflow-hidden border border-line bg-bg-sunken" },
          createElement("img", { src: still(NETS), alt: "", className: "absolute inset-0 h-full w-full object-cover" }),
        ),
        // A still cannot turn the card over, so the shot shows its answer face the way it comes to rest.
        createElement("div", { "data-turned": "" }, createElement(AnswerCard, { stage: { kind: "answer", answer, passport: closest, first } })),
      ),
    ),
  );
}

function editPage(): string {
  return renderToStaticMarkup(
    createElement(
      Provider,
      { locale: "en", messages: en, timeZone: "UTC" },
      createElement(
        "div",
        { className: "mx-auto w-full max-w-[1400px] px-5 pb-16 pt-4 sm:px-8" },
        createElement("div", { className: "max-w-[44rem]" }, createElement(Editor, { parentId: ID, owner: CREATOR })),
      ),
    ),
  );
}

function page(markup: string, theme: "light" | "dark"): string {
  return `<!doctype html><html class="${theme}" lang="en" style="--font-display:'Archivo';--font-body:'Inter';--font-mono:'IBM Plex Mono';--header-h:64px">
<head>
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wght@500;600;700&family=Inter:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=block">
<style>${css}</style>
<style>[style*="opacity:0"]{opacity:1!important;transform:none!important}.rise{animation:none!important}[data-turned] [style*="grid-area"]:first-child{display:none}[data-turned] [style*="rotateY"]{transform:none!important}</style>
</head>
<body class="bg-bg text-text">${markup}</body></html>`;
}

async function shoot(name: string, html: string, width: number, theme: string): Promise<string> {
  if (tab === null) throw new Error("no browser");
  await tab.send("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: width < 600 });
  const tree = await tab.send<{ frameTree: { frame: { id: string } } }>("Page.getFrameTree");
  await tab.send("Page.setDocumentContent", { frameId: tree.frameTree.frame.id, html });
  await tab.send("Runtime.evaluate", {
    expression:
      "Promise.all([document.fonts.ready, ...[...document.images].map((i) => i.decode().catch(() => null))]).then(() => new Promise((r) => setTimeout(r, 500)))",
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

describe.skipIf(browserPath === null)("the trust mark, photographed", () => {
  it("writes every passport state, Explore and Verify at 1440 and 375, light and dark", async () => {
    mkdirSync(OUT, { recursive: true });
    const screens: [string, string][] = [];
    for (const name of Object.keys(PASSPORTS)) screens.push([`passport-${name}`, await passportPage(name)]);
    screens.push(["explore", explorePage()]);
    screens.push(["verify-first", verifyPage()]);
    screens.push(["edit-sworn", editPage()]);
    const written: string[] = [];
    for (const [name, markup] of screens) {
      for (const theme of ["light", "dark"] as const) {
        for (const width of [1440, 375]) written.push(await shoot(name, page(markup, theme), width, theme));
      }
    }
    expect(written).toHaveLength(screens.length * 4);
  }, 600_000);
});
