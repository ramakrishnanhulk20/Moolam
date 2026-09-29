// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import en from "@/messages/en.json";
import type { TrySample } from "@/lib/data/samples";

/**
 * Verify's wave 3 features: the live wait, what a match cannot prove, a drop or
 * paste anywhere, the compare wipe, a shared sample link and a failure with a
 * way on.
 *
 * Every check runs against hand-made answers of the verify service's own shape,
 * with the service, the gateway and the chain read mocked out; nothing here
 * talks to a network. Does NOT cover how the veil, the wipe or the wait look,
 * the drag of the handle by a real pointer, or a real clipboard: those need a
 * real browser. The pointer and touch wording is chosen in CSS and is only
 * checked as markup.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const hold = vi.hoisted(() => ({
  sent: [] as File[],
  answer: null as null | ((file: File) => Promise<unknown>),
  lookups: [] as string[],
  fetched: [] as { id: string; url: string }[],
  reduced: false,
}));

vi.mock("@/lib/i18n/routing", () => ({
  Link: (props: { href: string; children?: unknown; className?: string }) =>
    createElement("a", { href: props.href, className: props.className }, props.children as never),
  useRouter: () => ({ refresh: () => undefined, push: () => undefined }),
}));
vi.mock("@/components/passport/Picture", () => ({
  Picture: (props: { sources: string[]; alt?: string }) =>
    createElement("span", { "data-picture": props.sources[0] ?? "", "data-alt": props.alt ?? "" }),
}));
vi.mock("@/components/passport/RecheckRequest", () => ({ RecheckRequest: () => null }));
vi.mock("@/lib/verifier/client", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/verifier/client")>();
  return {
    ...real,
    verifierHost: () => "verify.example",
    verify: ({ file }: { file: File }) => {
      hold.sent.push(file);
      return hold.answer === null ? new Promise(() => undefined) : hold.answer(file);
    },
  };
});
vi.mock("@/components/verify/lookup", () => ({
  matchedPassport: async (id: string) => {
    hold.lookups.push(id);
    return id.toLowerCase() === REGISTERED_ELSEWHERE.toLowerCase() || id.toLowerCase() === MATCHED.toLowerCase()
      ? {
          id,
          kind: 0,
          registeredAt: "1790000000",
          creator: `0x${"11".repeat(20)}`,
          generatorAgentId: "0",
          disputed: false,
          title: "Marina Beach Kite Sellers at Dusk",
          thumbnailUrl: "https://gateway.example/ipfs/bafkreiregistered",
        }
      : null;
  },
}));
vi.mock("@/components/verify/sample", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/verify/sample")>()),
  fileFromSample: async (sample: TrySample) => {
    hold.fetched.push({ id: sample.id, url: sample.url });
    return image("sample.jpeg");
  },
}));

const MATCHED = `0x${"4d".repeat(32)}`;
const OFFERED = `0x${"2b".repeat(32)}`;
const REGISTERED_ELSEWHERE = `0x${"6a".repeat(32)}`;
const SAMPLE: TrySample = { id: OFFERED as `0x${string}`, url: "ipfs://bafkreisample", title: "A church in a storm" };
const QUERIED = { sha256: `0x${"7e".repeat(32)}`, phash: "c3a5", blockhash: `0x${"1f".repeat(32)}`, width: 614, height: 410, format: "jpeg" };

function matchResponse(id = MATCHED) {
  return {
    result: {
      exact: null,
      best: { id, phashDistance: 3, blockhashDistance: 9, variant: "identity" },
      matches: [{ id, phashDistance: 3, blockhashDistance: 9, variant: "identity" }],
      confidence: 0.9,
      queried: QUERIED,
    },
    manifest: { present: false },
  };
}

const MISS = { result: { exact: null, best: null, matches: [], confidence: 0, queried: QUERIED }, manifest: { present: false } };

// The page reads a file's first bytes before it sends one, so every fixture
// opens with a real signature.
function image(name: string): File {
  const png = name.endsWith(".png");
  const head = png ? [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] : [0xff, 0xd8, 0xff, 0xe0];
  return new File([new Uint8Array([...head, 1, 2, 3])], name, { type: png ? "image/png" : "image/jpeg" });
}

let root: Root | null = null;
let host: HTMLElement;

async function mount(node: ReactElement) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(createElement(NextIntlClientProvider as never, { locale: "en", messages: en, timeZone: "UTC" }, node));
  });
}

async function flush() {
  await act(async () => {
    for (let turn = 0; turn < 6; turn += 1) {
      await new Promise((settle) => setTimeout(settle, 0));
    }
  });
}

async function screen(samples: TrySample[] = [SAMPLE]) {
  const { VerifyScreen } = await import("@/components/verify/VerifyScreen");
  await mount(createElement(VerifyScreen, { samples }));
  await flush();
}

async function choose(name: string) {
  const input = host.querySelector("input[type=file]") as HTMLInputElement;
  Object.defineProperty(input, "files", { value: [image(name)], configurable: true });
  await act(async () => {
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await flush();
}

/** A native event with the one browser field jsdom does not build for it. */
function eventWith(type: string, field: string, value: unknown): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, field, { value });
  return event;
}

beforeEach(() => {
  hold.sent = [];
  hold.answer = null;
  hold.lookups = [];
  hold.fetched = [];
  hold.reduced = false;
  window.history.replaceState(null, "", "/verify");
  URL.createObjectURL = () => "blob:reader-copy";
  URL.revokeObjectURL = () => undefined;
  window.HTMLElement.prototype.scrollIntoView = () => undefined;
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query.includes("reduce") ? hold.reduced : false,
    media: query,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    onchange: null,
    dispatchEvent: () => false,
  }));
  vi.stubGlobal("IntersectionObserver", class {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
  });
});

afterEach(async () => {
  if (root !== null) {
    await act(async () => {
      root?.unmount();
    });
    root = null;
  }
  host?.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("the wait, while a check runs", () => {
  async function waiting() {
    const { AnswerCard } = await import("@/components/verify/AnswerCard");
    await mount(createElement(AnswerCard, { stage: { kind: "checking", name: "holiday.jpg" } }));
  }
  const seconds = () => host.querySelector("[role=timer]")?.textContent;

  it("lists the three things the service does, and ticks none of them", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    await waiting();
    const steps = [...host.querySelectorAll("[data-wait-steps] li")].map((step) => step.textContent);
    expect(steps).toEqual([
      `01${en.verify.wait.fingerprint}`,
      `02${en.verify.wait.turns}`,
      `03${en.verify.wait.search}`,
    ]);
    const before = host.querySelector("[data-wait-steps]")?.outerHTML;
    await act(async () => {
      vi.advanceTimersByTime(6000);
    });
    expect(host.querySelector("[data-wait-steps]")?.outerHTML).toBe(before);
  });

  it("counts the seconds and adds the slow line after ten of them", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    await waiting();
    expect(seconds()).toBe("0 seconds");
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    expect(seconds()).toBe("1 second");
    await act(async () => {
      vi.advanceTimersByTime(8000);
    });
    expect(seconds()).toBe("9 seconds");
    expect(host.querySelector("[data-wait-slow]")).toBeNull();
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    expect(seconds()).toBe("10 seconds");
    expect(host.querySelector("[data-wait-slow]")?.textContent).toBe(en.verify.wait.slow);
  });

  it("still counts for a reader who asked for less motion, with the scan line gone", async () => {
    hold.reduced = true;
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    await waiting();
    expect(host.querySelector("span.h-px.bg-accent\\/70")).toBeNull();
    await act(async () => {
      vi.advanceTimersByTime(12000);
    });
    expect(seconds()).toBe("12 seconds");
    expect(host.querySelector("[data-wait-slow]")).not.toBeNull();
  });
});

describe("what a match cannot prove", () => {
  it("sits under a match and never under a miss or a failure", async () => {
    await screen();
    hold.answer = async () => matchResponse();
    await choose("mine.png");
    const block = host.querySelector("[data-verify-limits]");
    expect(block?.textContent).toBe(`${en.verify.limits.label}${en.verify.limits.line}`);

    hold.answer = async () => MISS;
    await choose("other.png");
    expect(host.textContent).toContain(en.verify.none);
    expect(host.querySelector("[data-verify-limits]")).toBeNull();

    hold.answer = async () => Promise.reject(new Error("socket hang up"));
    await choose("third.png");
    expect(host.querySelector("[data-verify-limits]")).toBeNull();
  });
});

describe("no account, and the words for the device", () => {
  it("says no account is needed beside Choose an image, and gives touch its own title", async () => {
    await screen();
    const box = host.querySelector("[data-verify-drop]") as HTMLElement;
    expect(box.querySelector("[data-no-account]")?.textContent).toBe(`${en.verify.noAccount}${en.verify.noAccountWhy}`);
    expect(box.innerHTML).toContain(`<span class="pointer-coarse:hidden">${en.verify.dropTitle}</span>`);
    expect(box.innerHTML).toContain(`<span class="hidden pointer-coarse:inline">${en.verify.dropTitleTouch}</span>`);
    const paste = box.querySelector("[data-paste-hint]") as HTMLElement;
    expect(paste.textContent).toBe(en.verify.paste);
    expect(paste.className).toContain("hidden");
    expect(paste.className).toContain("pointer-fine:block");
  });
});

describe("a picture dropped or pasted anywhere on Verify", () => {
  it("raises the veil while a file is dragged over the page and checks the file let go outside the box", async () => {
    await screen();
    const file = image("dropped.png");
    const transfer = { types: ["Files"], files: [file], dropEffect: "none" };

    await act(async () => {
      document.body.dispatchEvent(eventWith("dragenter", "dataTransfer", transfer));
    });
    expect(document.body.querySelector("[data-drop-veil]")?.textContent).toBe(en.verify.dropAnywhere);

    const drop = eventWith("drop", "dataTransfer", transfer);
    await act(async () => {
      document.body.dispatchEvent(drop);
    });
    await flush();
    expect(drop.defaultPrevented).toBe(true);
    expect(hold.sent.map((one) => one.name)).toEqual(["dropped.png"]);
  });

  it("leaves a dragged link or text alone", async () => {
    await screen();
    await act(async () => {
      document.body.dispatchEvent(eventWith("dragenter", "dataTransfer", { types: ["text/plain"], files: [] }));
      document.body.dispatchEvent(eventWith("drop", "dataTransfer", { types: ["text/plain"], files: [] }));
    });
    await flush();
    expect(document.body.querySelector("[data-drop-veil]")).toBeNull();
    expect(hold.sent).toEqual([]);
  });

  it("checks a pasted clipboard picture, through the same byte check as a chosen file", async () => {
    await screen();
    const pasted = image("image.png");
    const paste = eventWith("paste", "clipboardData", {
      files: [],
      items: [{ kind: "file", type: "image/png", getAsFile: () => pasted }],
    });
    await act(async () => {
      document.body.dispatchEvent(paste);
    });
    await flush();
    expect(paste.defaultPrevented).toBe(true);
    expect(hold.sent.map((one) => one.name)).toEqual(["image.png"]);

    const notes = new File([new TextEncoder().encode("not a picture at all")], "notes.png", { type: "image/png" });
    await act(async () => {
      document.body.dispatchEvent(eventWith("paste", "clipboardData", { files: [notes], items: [] }));
    });
    await flush();
    expect(hold.sent.map((one) => one.name)).toEqual(["image.png"]);
    expect(host.textContent).toContain(en.verify.problem.notAnImage);
  });

  it("lets text pasted into a field stay a normal paste", async () => {
    await screen();
    const field = document.createElement("input");
    document.body.append(field);
    const paste = eventWith("paste", "clipboardData", { files: [image("typed.png")], items: [] });
    await act(async () => {
      field.dispatchEvent(paste);
    });
    await flush();
    expect(paste.defaultPrevented).toBe(false);
    expect(hold.sent).toEqual([]);
    field.remove();
  });
});

describe("the compare wipe", () => {
  const slider = () => host.querySelector("[role=slider]") as HTMLElement | null;

  it("turns the picture into a wipe on a match from the reader's own file", async () => {
    await screen();
    hold.answer = async () => matchResponse();
    await choose("mine.png");
    const wipe = host.querySelector("[data-compare-wipe]") as HTMLElement;
    expect(wipe.querySelector("img")?.getAttribute("src")).toBe("blob:reader-copy");
    expect(wipe.querySelector("[data-picture]")?.getAttribute("data-picture")).toContain("bafkreiregistered");
    expect(wipe.textContent).toContain(en.verify.compare.yours);
    expect(wipe.textContent).toContain(en.verify.compare.registered);
    expect(slider()?.getAttribute("aria-label")).toBe(en.verify.compare.label);
  });

  it("moves with the arrow keys, Home and End", async () => {
    await screen();
    hold.answer = async () => matchResponse();
    await choose("mine.png");
    const press = async (key: string, shiftKey = false) => {
      await act(async () => {
        slider()?.dispatchEvent(new KeyboardEvent("keydown", { key, shiftKey, bubbles: true }));
      });
      return slider()?.getAttribute("aria-valuenow");
    };
    expect(slider()?.getAttribute("aria-valuenow")).toBe("50");
    expect(slider()?.tabIndex).toBe(0);
    expect(await press("ArrowRight")).toBe("55");
    expect(await press("ArrowLeft", true)).toBe("35");
    expect(await press("End")).toBe("100");
    expect(await press("ArrowRight")).toBe("100");
    expect(await press("Home")).toBe("0");
  });

  it("is never drawn for a sample press, where both sides would be the same file, or for a miss", async () => {
    await screen();
    hold.answer = async () => matchResponse();
    await act(async () => {
      (host.querySelector("[data-verify-samples] button") as HTMLButtonElement).click();
    });
    await flush();
    expect(host.textContent).toContain(en.verify.limits.label);
    expect(slider()).toBeNull();

    hold.answer = async () => MISS;
    await choose("mine.png");
    expect(host.textContent).toContain(en.verify.none);
    expect(slider()).toBeNull();
  });

  it("works out no fingerprint in the browser", () => {
    for (const file of ["components/verify/CompareSlider.tsx", "components/verify/AnswerCard.tsx", "components/verify/VerifyScreen.tsx"]) {
      const source = readFileSync(file, "utf8");
      expect(source, file).not.toMatch(/lib\/chain\/fingerprint|bitsApart|phashOf|getImageData|OffscreenCanvas|<canvas/);
    }
  });
});

describe("a link to a sample's answer", () => {
  it("runs an offered sample's check when the page opens with its id", async () => {
    hold.answer = async () => matchResponse(OFFERED);
    window.history.replaceState(null, "", `/verify?sample=${OFFERED}`);
    await screen();
    expect(hold.fetched).toEqual([{ id: OFFERED, url: SAMPLE.url }]);
    expect(hold.sent.map((one) => one.name)).toEqual(["sample.jpeg"]);
  });

  it("runs any passport with a published picture, read from Monad first", async () => {
    window.history.replaceState(null, "", `/verify?sample=${REGISTERED_ELSEWHERE}`);
    await screen();
    expect(hold.lookups).toEqual([REGISTERED_ELSEWHERE]);
    expect(hold.fetched).toEqual([{ id: REGISTERED_ELSEWHERE, url: "https://gateway.example/ipfs/bafkreiregistered" }]);
  });

  it("does nothing for an id that is not a passport, or a passport Monad does not have", async () => {
    for (const bad of ["nonsense", "0x1234", `${OFFERED}00`, `0x${"99".repeat(32)}`]) {
      hold.lookups = [];
      window.history.replaceState(null, "", `/verify?sample=${encodeURIComponent(bad)}`);
      await screen();
      expect(hold.fetched, bad).toEqual([]);
      expect(hold.sent, bad).toEqual([]);
      expect(host.querySelector("[data-answer-card]")?.textContent, bad).toContain(en.verify.idleHeading);
      await act(async () => {
        root?.unmount();
      });
      root = null;
      host.remove();
    }
  });

  it("copies the answer's link from a sample answer and says so on the button", async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    hold.answer = async () => matchResponse(OFFERED);
    await screen();
    await act(async () => {
      (host.querySelector("[data-verify-samples] button") as HTMLButtonElement).click();
    });
    await flush();
    const button = () => host.querySelector("[data-share-answer] button") as HTMLButtonElement;
    expect(button().textContent).toBe(en.verify.share.copy);
    await act(async () => {
      button().click();
    });
    await flush();
    expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/verify?sample=${OFFERED}`);
    expect(button().textContent).toBe(en.verify.share.copied);
  });

  it("says the copy failed when the browser refuses the clipboard", async () => {
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText: async () => Promise.reject(new Error("denied")) } });
    hold.answer = async () => matchResponse(OFFERED);
    await screen();
    await act(async () => {
      (host.querySelector("[data-verify-samples] button") as HTMLButtonElement).click();
    });
    await flush();
    await act(async () => {
      (host.querySelector("[data-share-answer] button") as HTMLButtonElement).click();
    });
    await flush();
    expect(host.querySelector("[data-share-failed]")?.textContent).toContain(en.common.copyFailed);
  });

  it("is not offered on the reader's own file", async () => {
    hold.answer = async () => matchResponse();
    await screen();
    await choose("mine.png");
    expect(host.querySelector("[data-share-answer]")).toBeNull();
  });
});

describe("a failed check", () => {
  it("offers Check this file again, which sends the same file, and keeps the raw reason inside Details", async () => {
    const { VerifierError } = await import("@/lib/verifier/client");
    hold.answer = async () => Promise.reject(new VerifierError("pin-failed", 502, "upstream pinning returned 502"));
    await screen();
    await choose("mine.png");

    const line = host.querySelector("[data-failure-line]") as HTMLElement;
    expect(line.firstElementChild?.tagName.toLowerCase()).toBe("svg");
    expect(line.textContent).toBe(en.verify.problem.serviceFailed);
    expect(line.textContent).not.toContain("502");

    const details = host.querySelector("[data-failure-details]") as HTMLDetailsElement;
    expect(details.tagName.toLowerCase()).toBe("details");
    expect(details.open).toBe(false);
    expect(details.querySelector("summary")?.textContent?.trim().endsWith(en.common.details)).toBe(true);
    expect(details.textContent).toContain("upstream pinning returned 502");
    const outside = (host.querySelector("[data-answer-card]")?.textContent ?? "").replace(details.textContent ?? "", "");
    expect(outside).not.toContain("upstream pinning");

    hold.answer = async () => matchResponse();
    const again = host.querySelector("[data-check-again]") as HTMLButtonElement;
    expect(again.textContent).toBe(en.verify.checkAgain);
    await act(async () => {
      again.click();
    });
    await flush();
    expect(hold.sent.map((one) => one.name)).toEqual(["mine.png", "mine.png"]);
    expect(hold.sent[1]).toBe(hold.sent[0]);
    expect(host.querySelector("[data-verify-limits]")).not.toBeNull();
  });

  it("has no Check this file again for a sample, where pressing the sample again is the way", async () => {
    hold.answer = async () => Promise.reject(new Error("socket hang up"));
    await screen();
    await act(async () => {
      (host.querySelector("[data-verify-samples] button") as HTMLButtonElement).click();
    });
    await flush();
    expect(host.querySelector("[data-failure-line]")).not.toBeNull();
    expect(host.querySelector("[data-check-again]")).toBeNull();
  });
});
