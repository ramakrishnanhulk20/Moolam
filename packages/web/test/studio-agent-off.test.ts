// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createElement, type FunctionComponent, type ReactNode, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider, createTranslator } from "next-intl";
import de from "@/messages/de.json";
import en from "@/messages/en.json";
import es from "@/messages/es.json";
import fr from "@/messages/fr.json";
import hi from "@/messages/hi.json";
import ja from "@/messages/ja.json";
import ko from "@/messages/ko.json";
import pt from "@/messages/pt.json";
import ta from "@/messages/ta.json";
import zh from "@/messages/zh.json";
import { CompactSwitch, PathChoice } from "@/components/studio/PathChoice";
import { FailureNote } from "@/components/studio/FailureNote";
import { describeFailure, describeGenerateFailure } from "@/lib/studio/problems";
import type { Mode } from "@/lib/studio/flow";
import { VerifierError, generate, readGenerateService, verifierUrl } from "@/lib/verifier/client";

/**
 * The studio and a verify service that cannot draw pictures (WO-300).
 *
 * Ram chose "make one with the agent" on a host whose /generate route was off,
 * typed a prompt, and was told the service "answered in a shape this page does
 * not understand". The route did not exist, so the service answered 404 with a
 * plain JSON error, and the studio had no sentence for that. Held here: the
 * failure itself, the read of /health that lets the studio say so first, the
 * switch that shows it, and the same line in all ten languages. The screen and
 * the press are driven in studio-agent-off-screen and studio-agent-off-flow.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
window.matchMedia ??= ((query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addListener: () => undefined,
  removeListener: () => undefined,
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
  dispatchEvent: () => false,
})) as typeof window.matchMedia;

vi.mock("@/lib/i18n/routing", () => ({
  Link: (props: { href: string; children?: unknown; className?: string }) =>
    createElement("a", { href: props.href, className: props.className }, props.children as never),
}));

const CREATOR = "0x559F357aDa3A96d11AEa679eC0D622E4AF15F67c";
const LANGS = { en, de, es, fr, hi, ja, ko, pt, ta, zh } as const;
const LONG_DASH = String.fromCharCode(0x2014);

/** What a host that serves everything answers on /health, shaped as docs/api/verifier-endpoints.md gives it. */
const HEALTH = {
  ok: true,
  records: 31,
  index: { loadedAt: 1_790_312_400, stale: false },
  version: "0.1.0",
  routes: ["verify", "mcp", "lookalikes/candidates", "lookalikes/backlog", "recheck", "prepare", "generate", "edit", "unseal", "sealed", "health"],
  off: [],
  limits: { prepares: { used: 0, max: 400 }, generations: { used: 0, max: 60 } },
  recheck: { pending: 0, running: 0 },
  sweep: { mode: "off", lastRun: null },
};

function withoutGenerate(extra: object = {}) {
  return { ...HEALTH, routes: HEALTH.routes.filter((route) => route !== "generate"), ...extra };
}

function answer(status: number, body: unknown) {
  const stub = vi.fn<(url: string, init?: RequestInit) => Promise<unknown>>(async () => ({
    ok: status < 400,
    status,
    json: async () => body,
  }));
  vi.stubGlobal("fetch", stub);
  return stub;
}

async function drawn(): Promise<unknown> {
  return await generate({
    prompt: "a fishing boat at first light",
    title: "His Dream",
    creator: CREATOR,
    deadline: 1_788_878_733n,
    accessToken: "token-123",
  }).catch((error: unknown) => error);
}

let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("the failure Ram met", () => {
  it("is a 404 from /generate, which the studio printed as an answer in an unknown shape", async () => {
    answer(404, { error: "no route for POST /generate" });
    const failure = await drawn();

    expect(failure).toBeInstanceOf(VerifierError);
    expect((failure as VerifierError).status).toBe(404);
    // The upload path's mapping, which is what the agent path used before this order.
    expect(describeFailure(failure, "prepare").key).toBe("badResponse");
    expect(describeGenerateFailure(failure).key).not.toBe("badResponse");
  });
});

describe("a /generate that is not served maps to the one line", () => {
  it("answers a 404 for a path the service does not have, with no words of the service's under it", async () => {
    answer(404, { error: "no route for POST /generate" });
    expect(describeGenerateFailure(await drawn())).toEqual({ key: "agentOff" });
  });

  it("answers any 404 the same way, whatever the body says or whether it has one", async () => {
    answer(404, { error: "unknown route" });
    expect(describeGenerateFailure(await drawn())).toEqual({ key: "agentOff" });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 404,
        json: async () => {
          throw new Error("not JSON");
        },
      })),
    );
    expect(describeGenerateFailure(await drawn())).toEqual({ key: "agentOff" });
  });

  it("answers a host whose registry check has not passed yet the same way, because it is the same state", async () => {
    answer(503, { error: "generator-unchecked", reason: "the registry on chain has not been read yet" });
    expect(describeGenerateFailure(await drawn())).toEqual({ key: "agentOff" });
  });

  it("leaves every other answer from /generate on the mapping it always had", async () => {
    const cases: [number, unknown, object][] = [
      [401, { error: "unauthorized" }, { key: "signedOut", next: "signIn" }],
      [429, { error: "quota", quota: { used: 3, limit: 3, resetsAt: 1_788_961_533 } }, { key: "quotaReached" }],
      [400, { error: "prompt-refused", reason: "the safety system said no" }, { key: "promptRefused", reason: "the safety system said no" }],
      [502, { error: "model-failed" }, { key: "modelFailed", next: "again" }],
      [503, { error: "busy" }, { key: "agentBusy", next: "again" }],
      [503, { error: "service-fault" }, { key: "serviceFault", next: "again" }],
    ];
    for (const [status, body, expected] of cases) {
      answer(status, body);
      expect(describeGenerateFailure(await drawn()), `${status} ${JSON.stringify(body)}`).toMatchObject(expected);
    }
  });

  it("leaves a service that did not answer, and any error that is not the service's, as it was", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("fetch failed"))));
    expect(describeGenerateFailure(await drawn()).key).toBe("serviceOffline");
    expect(describeGenerateFailure(new Error("this session has no access token")).key).toBe("unknown");
  });

  it("is never the unknown-shape sentence for either answer", async () => {
    for (const [status, body] of [
      [404, { error: "no route for POST /generate" }],
      [503, { error: "generator-unchecked" }],
    ] as const) {
      answer(status, body);
      expect(describeGenerateFailure(await drawn()).key).not.toBe("badResponse");
    }
  });
});

describe("reading what the service can draw", () => {
  it("asks /health with a plain GET and says on when generate is among the routes it serves", async () => {
    const stub = answer(200, HEALTH);
    expect(await readGenerateService()).toEqual({ state: "on" });
    expect(stub).toHaveBeenCalledOnce();
    const [url, init] = stub.mock.calls[0];
    expect(url).toBe(verifierUrl("/health"));
    expect(init?.method).toBe("GET");
    expect(init?.headers).toBeUndefined();
    expect(init?.body).toBeUndefined();
  });

  it("says off when generate is not in the routes, which is how a host missing a key shows", async () => {
    answer(200, withoutGenerate());
    expect(await readGenerateService()).toEqual({ state: "off" });
  });

  it("says off when /health names POST /generate under off, with the reason left where the service keeps it", async () => {
    answer(
      200,
      withoutGenerate({ off: [{ route: "POST /generate", reason: "the registry on chain has not been read yet" }] }),
    );
    expect(await readGenerateService()).toEqual({ state: "off" });
  });

  it("says off when generate is listed and also named off, because the closed route is the one that answers", async () => {
    answer(200, { ...HEALTH, off: [{ route: "POST /generate", reason: "the registry check disagreed" }] });
    expect(await readGenerateService()).toEqual({ state: "off" });
  });

  it("does not take another route being off for generate being off", async () => {
    answer(200, { ...HEALTH, off: [{ route: "POST /unseal", reason: "it needs PRIVY_APP_SECRET" }] });
    expect(await readGenerateService()).toEqual({ state: "on" });
  });

  it("says unknown, never off, when /health cannot be read at all", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("fetch failed"))));
    expect((await readGenerateService()).state).toBe("unknown");

    answer(500, { error: "boom" });
    expect((await readGenerateService()).state).toBe("unknown");

    answer(404, { error: "no route for GET /health" });
    expect((await readGenerateService()).state).toBe("unknown");
  });

  it("says unknown for an answer that is not JSON or has no list of routes in it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => {
          throw new Error("not JSON");
        },
      })),
    );
    expect((await readGenerateService()).state).toBe("unknown");

    answer(200, { ok: true, records: 3 });
    expect((await readGenerateService()).state).toBe("unknown");

    answer(200, { ok: true, routes: "generate" });
    expect((await readGenerateService()).state).toBe("unknown");

    answer(200, { ok: true, routes: [7, null] });
    expect((await readGenerateService()).state).toBe("unknown");
  });

  it("still reads the routes when the list of what is off is in a shape it does not know", async () => {
    answer(200, { ...HEALTH, off: "none" });
    expect(await readGenerateService()).toEqual({ state: "on" });
  });

  it("gives up with the caller, and says unknown, so a studio that closes mid read changes nothing", async () => {
    const asking = new AbortController();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        await new Promise((_resolve, reject) =>
          init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))),
        );
        return { ok: true, status: 200, json: async () => HEALTH };
      }),
    );
    const reading = readGenerateService({ signal: asking.signal });
    asking.abort();
    expect((await reading).state).toBe("unknown");
  });
});

const Provider = NextIntlClientProvider as unknown as FunctionComponent<{
  locale: string;
  messages: unknown;
  timeZone: string;
  children?: ReactNode;
}>;

const NOOP = () => undefined;

/** The markup writes an apostrophe as an entity, so a sentence is held against it the same way. */
const escaped = (words: string) => words.replaceAll("'", "&#x27;");

function draw(node: ReactNode, locale = "en", messages: unknown = en): string {
  return renderToStaticMarkup(createElement(Provider, { locale, messages, timeZone: "UTC" }, node));
}

/** The choice mounted as the studio holds it, so a click or a key can be answered the way the studio would. */
function mount(start: Mode, generateOff: boolean): { box: HTMLElement; asked: Mode[] } {
  const asked: Mode[] = [];
  function Held() {
    const [mode, setMode] = useState<Mode>(start);
    return createElement(PathChoice, {
      mode,
      busy: false,
      generateOff,
      onMode: (next: Mode) => {
        asked.push(next);
        setMode(next);
      },
    });
  }
  document.body.innerHTML = "<main></main>";
  const box = document.querySelector("main") as HTMLElement;
  root = createRoot(box);
  act(() => {
    root?.render(createElement(Provider, { locale: "en", messages: en, timeZone: "UTC" }, createElement(Held)));
  });
  return { box, asked };
}

const radios = (box: HTMLElement) => [...box.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
const offLine = (box: HTMLElement) => box.querySelector<HTMLElement>("[data-switch-off]");

describe("the two ways in with the agent switched off", () => {
  it("dims the agent's half and cannot be chosen, and says why in one line under the switch", () => {
    const { box } = mount("upload", true);
    const [upload, agent] = radios(box);

    expect(agent.disabled).toBe(true);
    expect(agent.className).toContain("opacity-55");
    expect(upload.disabled).toBe(false);
    expect(upload.getAttribute("aria-checked")).toBe("true");

    const line = offLine(box);
    expect(line?.textContent).toBe(en.studio.failure.agentOff);
    expect(line?.className).toContain("text-base");
    // A screen reader hears the reason with the half's name.
    expect(document.getElementById(agent.getAttribute("aria-describedby") ?? "")).toBe(line);
  });

  it("points at the upload path in the same line", () => {
    expect(en.studio.failure.agentOff).toContain("Upload a picture");
  });

  it("does not take a click on the agent's half, and does not take the arrow keys either", () => {
    const { box, asked } = mount("upload", true);
    const group = box.querySelector('[role="radiogroup"]') as HTMLElement;
    act(() => {
      radios(box)[1].click();
      for (const key of ["ArrowRight", "ArrowLeft", "ArrowDown", "ArrowUp", "End", "Home"]) {
        group.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
      }
    });
    // A request for the path already chosen would clear the form, so none is made either.
    expect(asked).toEqual([]);
    expect(radios(box)[0].getAttribute("aria-checked")).toBe("true");
  });

  it("still takes the upload half when the studio had opened on the agent", () => {
    const { box, asked } = mount("generate", true);
    act(() => radios(box)[0].click());
    expect(asked).toEqual(["upload"]);
    expect(radios(box)[0].getAttribute("aria-checked")).toBe("true");
  });

  it("draws the same line in the laptop's compact switch", () => {
    const markup = draw(createElement(CompactSwitch, { mode: "upload", busy: false, generateOff: true, onMode: NOOP }));
    expect(markup).toContain("data-switch-off");
    expect(markup).toContain(escaped(en.studio.failure.agentOff));
  });

  it("is the same switch as before when the service can draw, or when nobody could ask", () => {
    for (const generateOff of [false, undefined]) {
      const { box, asked } = mount("upload", generateOff as boolean);
      expect(offLine(box)).toBeNull();
      expect(radios(box).every((radio) => !radio.disabled)).toBe(true);
      act(() => radios(box)[1].click());
      expect(asked).toEqual(["generate"]);
      act(() => root?.unmount());
      root = null;
    }
    expect(draw(createElement(PathChoice, { mode: "upload", busy: false, onMode: NOOP }))).not.toContain("data-switch-off");
  });

  it("keeps the shape it had: no pill, the frame at 8 px", () => {
    const markup = draw(createElement(PathChoice, { mode: "upload", busy: false, generateOff: true, onMode: NOOP }));
    expect(markup).not.toMatch(/rounded-full|rounded-3xl|rounded-2xl|9999px/);
    expect(markup).toMatch(/role="radiogroup"[^>]*class="[^"]*rounded-\[8px\]/);
  });
});

describe("the same line when the press is the first to find out", () => {
  it("is what the failure note prints, with no button to try again and no service words folded under it", () => {
    const markup = draw(createElement(FailureNote, { failure: { key: "agentOff" } }));
    expect(markup).toContain(escaped(en.studio.failure.agentOff));
    expect(markup).not.toContain("<button");
    expect(markup).not.toContain("<details");
    expect(markup).not.toContain(en.studio.failure.badResponse);
  });
});

describe("the line in every language", () => {
  const tongues = Object.entries(LANGS);

  it("is said in all ten, each as its own words", () => {
    expect(tongues).toHaveLength(10);
    for (const [lang, messages] of tongues) {
      const said = messages.studio.failure.agentOff;
      expect(typeof said, lang).toBe("string");
      expect(said.trim().length, lang).toBeGreaterThan(20);
      if (lang !== "en") {
        expect(said, lang).not.toBe(en.studio.failure.agentOff);
      }
    }
  });

  it("carries no placeholder, so no language can leave one open or drop one the others fill", () => {
    for (const [lang, messages] of tongues) {
      expect(messages.studio.failure.agentOff.match(/[{}]/g), lang).toBeNull();
    }
  });

  it("formats as written under the message library, which is what the screen runs", () => {
    for (const [lang, messages] of tongues) {
      const say = createTranslator({ locale: lang, messages: messages as never, namespace: "studio.failure" });
      expect(say("agentOff"), lang).toBe(messages.studio.failure.agentOff);
    }
  });

  it("holds no long dash, which is the one tell this house does not print", () => {
    for (const [lang, messages] of tongues) {
      expect(messages.studio.failure.agentOff.includes(LONG_DASH), lang).toBe(false);
    }
  });

  it("draws in the switch and in the failure note for a Tamil reader", () => {
    const switchMarkup = draw(createElement(PathChoice, { mode: "upload", busy: false, generateOff: true, onMode: NOOP }), "ta", ta);
    expect(switchMarkup).toContain(escaped(ta.studio.failure.agentOff));
    const noteMarkup = draw(createElement(FailureNote, { failure: { key: "agentOff" } }), "ta", ta);
    expect(noteMarkup).toContain(escaped(ta.studio.failure.agentOff));
  });
});
