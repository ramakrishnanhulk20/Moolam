// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement, type FunctionComponent, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import en from "@/messages/en.json";
import type { RegisterState } from "@/lib/studio/flow";
import { verifierUrl } from "@/lib/verifier/client";

/**
 * The live studio when the verify service says whether it can draw (WO-300).
 *
 * LiveStudio is mounted whole, with the wallet hook stood in for by one that
 * keeps the real register state, and the service is a stubbed fetch. What is
 * held, before any prompt is typed: a service that does not serve /generate
 * leaves the agent's half switched off with its one line and the upload form on
 * screen, a link that opened on the agent lands on the upload form, a /health
 * that cannot be read leaves everything as it was, and the service is asked
 * once.
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

// The scroll reveals watch for the page coming into view, which a test page never does.
globalThis.IntersectionObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
} as unknown as typeof IntersectionObserver;

const chunks = vi.hoisted(() => ({ pending: [] as Promise<unknown>[] }));
const hook = vi.hoisted(() => ({ modes: [] as string[], patch: {} as Record<string, unknown> }));

vi.mock("next/dynamic", async () => {
  const { createElement: make } = await import("react");
  return {
    default: (load: () => Promise<FunctionComponent<never>>, options?: { loading?: FunctionComponent }) => {
      let Loaded: FunctionComponent<never> | null = null;
      chunks.pending.push(
        load().then((component) => {
          Loaded = component;
        }),
      );
      return (props: never) =>
        Loaded === null ? (options?.loading === undefined ? null : make(options.loading)) : make(Loaded, props);
    },
  };
});

vi.mock("@/lib/i18n/routing", () => ({
  Link: (props: { href: string; children?: unknown; className?: string }) =>
    createElement("a", { href: props.href, className: props.className }, props.children as never),
}));

// The wallet hook, with the real register reducer behind it, so the studio
// reacts to the mode it is asked for exactly as it does live.
vi.mock("@/lib/studio/useStudio", async () => {
  const { useReducer } = await import("react");
  const { initialRegisterState, registerReducer } = await import("@/lib/studio/flow");
  const { initialBindState } = await import("@/lib/studio/binding");
  const nothing = () => undefined;
  const nothingLater = async () => undefined;
  return {
    useStudio: (initialMode: "upload" | "generate" = "upload") => {
      const [register, dispatch] = useReducer(registerReducer, {
        ...initialRegisterState,
        mode: initialMode,
        ...hook.patch,
      } as RegisterState);
      return {
        ready: true,
        authenticated: true,
        account: { kind: "email", value: "creator@moolam.test" },
        wallet: "0x559F357aDa3A96d11AEa679eC0D622E4AF15F67c",
        walletMissing: false,
        binding: { status: "bound", passkey: null, credentialId: undefined, error: null, refresh: nothing, remember: nothing },
        bind: initialBindState,
        confirming: false,
        register,
        sponsorship: "proven",
        balance: null,
        recovering: false,
        recovery: null,
        login: nothing,
        logout: nothing,
        actions: {
          bindThisDevice: nothingLater,
          recoverThisDevice: nothingLater,
          choose: (file: File) => dispatch({ type: "choose", file }),
          setTitle: (title: string) => dispatch({ type: "title", title }),
          setPrompt: (prompt: string) => dispatch({ type: "prompt", prompt }),
          setMode: (mode: "upload" | "generate") => {
            hook.modes.push(mode);
            dispatch({ type: "mode", mode });
          },
          setConsent: nothing,
          setSealed: nothing,
          setIncludePrompt: nothing,
          saveSealed: nothing,
          stateAgain: nothingLater,
          registerImage: nothingLater,
          generateImage: nothingLater,
          resend: nothingLater,
          recheck: nothingLater,
          clearBind: nothing,
          reset: nothing,
        },
        passports: {
          status: "ready",
          passports: [],
          error: null,
          refresh: nothing,
          hasMore: false,
          loadingMore: false,
          moreError: null,
          more: nothing,
        },
      };
    },
  };
});

process.env.NEXT_PUBLIC_PRIVY_APP_ID = "test-app-id";

const { LiveStudio } = await import("@/components/studio/LiveStudio");

// Every panel is loaded before the first render, so a test never draws the waiting stand-in.
for (let seen = -1; seen !== chunks.pending.length; ) {
  seen = chunks.pending.length;
  await Promise.all(chunks.pending);
}

const Provider = NextIntlClientProvider as unknown as FunctionComponent<{
  locale: string;
  messages: unknown;
  timeZone: string;
  children?: ReactNode;
}>;

const HEALTH = {
  ok: true,
  records: 31,
  version: "0.1.0",
  routes: ["verify", "mcp", "recheck", "prepare", "generate", "edit", "unseal", "sealed", "health"],
  off: [],
};
const WITHOUT_GENERATE = { ...HEALTH, routes: HEALTH.routes.filter((route) => route !== "generate") };

let root: Root | null = null;
let box: HTMLElement;

/** Every fetch the studio makes in a test, and what each was answered with. */
function service(health: () => Promise<unknown>) {
  const stub = vi.fn(async (url: string) => {
    if (url === verifierUrl("/health")) {
      return await health();
    }
    throw new Error(`the studio asked for ${url}, which this test does not serve`);
  });
  vi.stubGlobal("fetch", stub);
  return stub;
}

const says = (body: unknown, status = 200) => async () => ({ ok: status < 400, status, json: async () => body });

async function open(initialMode: "upload" | "generate"): Promise<void> {
  document.body.innerHTML = "<main></main>";
  box = document.querySelector("main") as HTMLElement;
  root = createRoot(box);
  await act(async () => {
    root?.render(
      createElement(Provider, { locale: "en", messages: en, timeZone: "UTC" }, createElement(LiveStudio, { initialMode })),
    );
  });
  // The service's answer comes through a promise, one turn after the first paint.
  await act(async () => undefined);
}

const radios = () => [...box.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
const offLine = () => box.querySelector<HTMLElement>("[data-switch-off]");
const upload = () => box.querySelector('[data-studio-panel="upload"]');
const agent = () => box.querySelector('[data-studio-panel="generate"]');

beforeEach(() => {
  hook.modes.length = 0;
  hook.patch = {};
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("a service whose /generate is off, before any prompt is typed", () => {
  it("switches the agent's half off with its one line, and has the upload form on screen", async () => {
    service(says(WITHOUT_GENERATE));
    await open("upload");

    const [uploadHalf, agentHalf] = radios();
    expect(uploadHalf.getAttribute("aria-checked")).toBe("true");
    expect(uploadHalf.disabled).toBe(false);
    expect(agentHalf.disabled).toBe(true);
    expect(offLine()?.textContent).toBe(en.studio.failure.agentOff);

    expect(upload()).not.toBeNull();
    expect(agent()).toBeNull();
    expect(box.querySelector("textarea")).toBeNull();
    // The upload path is there to be used: its file picker is not held back.
    expect(box.querySelector<HTMLInputElement>('input[type="file"]')?.disabled).toBe(false);
  });

  it("lands a link that opened on the agent on the upload form, with the line saying why", async () => {
    service(says(WITHOUT_GENERATE));
    await open("generate");

    expect(hook.modes).toEqual(["upload"]);
    expect(radios()[0].getAttribute("aria-checked")).toBe("true");
    expect(offLine()?.textContent).toBe(en.studio.failure.agentOff);
    expect(upload()).not.toBeNull();
    expect(agent()).toBeNull();
    expect(box.querySelector("textarea")).toBeNull();
  });

  it("says the same when /health names POST /generate under off with a reason", async () => {
    service(says({ ...WITHOUT_GENERATE, off: [{ route: "POST /generate", reason: "the registry on chain has not been read yet" }] }));
    await open("upload");
    expect(radios()[1].disabled).toBe(true);
    expect(offLine()?.textContent).toBe(en.studio.failure.agentOff);
    // The service's own reason stays where the service keeps it.
    expect(box.textContent).not.toContain("registry on chain");
  });

  it("never moves a run that is already under way", async () => {
    service(says(WITHOUT_GENERATE));
    hook.patch = { steps: { prepare: "waiting", draw: "running", pin: "waiting", agentSign: "waiting", sign: "waiting", send: "waiting" } };
    await open("generate");
    expect(hook.modes).toEqual([]);
  });

  it("asks the service once for the whole opening", async () => {
    const stub = service(says(WITHOUT_GENERATE));
    await open("generate");
    await act(async () => {
      radios()[0].click();
    });
    expect(stub).toHaveBeenCalledTimes(1);
    expect(stub.mock.calls[0][0]).toBe(verifierUrl("/health"));
  });
});

describe("a service that can draw, or that cannot be asked", () => {
  it("leaves both halves on and the agent form where the link put it when /health lists generate", async () => {
    service(says(HEALTH));
    await open("generate");

    expect(offLine()).toBeNull();
    expect(radios().every((radio) => !radio.disabled)).toBe(true);
    expect(radios()[1].getAttribute("aria-checked")).toBe("true");
    expect(agent()).not.toBeNull();
    expect(hook.modes).toEqual([]);
  });

  it("leaves the chooser as it was when /health cannot be read, whichever way it fails", async () => {
    const ways: [string, () => Promise<unknown>][] = [
      ["no answer", () => Promise.reject(new TypeError("fetch failed"))],
      ["a 500", says({ error: "boom" }, 500)],
      ["a 404", says({ error: "no route for GET /health" }, 404)],
      ["not JSON", async () => ({ ok: true, status: 200, json: async () => Promise.reject(new Error("not JSON")) })],
      ["no list of routes", says({ ok: true, records: 3 })],
    ];
    for (const [way, health] of ways) {
      service(health);
      await open("generate");

      expect(offLine(), way).toBeNull();
      expect(radios().every((radio) => !radio.disabled), way).toBe(true);
      expect(radios()[1].getAttribute("aria-checked"), way).toBe("true");
      expect(agent(), way).not.toBeNull();
      expect(hook.modes, way).toEqual([]);

      act(() => root?.unmount());
      root = null;
    }
  });

  it("offers the agent as it always was until the answer comes, and only then switches it off", async () => {
    let answer: (value: unknown) => void = () => undefined;
    service(() => new Promise((resolve) => (answer = resolve)));
    await open("upload");

    expect(offLine()).toBeNull();
    expect(radios().every((radio) => !radio.disabled)).toBe(true);

    await act(async () => {
      answer(await says(WITHOUT_GENERATE)());
    });
    expect(offLine()?.textContent).toBe(en.studio.failure.agentOff);
    expect(radios()[1].disabled).toBe(true);
  });
});
