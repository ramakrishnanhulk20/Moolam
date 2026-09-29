// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import en from "@/messages/en.json";
import type { TrySample } from "@/lib/data/samples";

/**
 * Two checks in flight at once, on the home page's drop and on the verify page.
 *
 * A reader presses a sample, then chooses their own file before the sample has
 * answered. The file is the last thing they did, so its answer is the one the
 * card must end on, and the sample's answer arriving late must change nothing.
 * Before the run guard the card ended on whichever answer landed last.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** A promise the test settles by hand, so the order answers land in is the test's to choose. */
function later<T>() {
  let settle!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    settle = resolve;
  });
  return { promise, settle };
}

const hold = vi.hoisted(() => ({
  sampleBytes: null as null | { promise: Promise<File | null>; settle: (file: File | null) => void },
  answers: new Map<string, { promise: Promise<unknown>; settle: (value: unknown) => void }>(),
}));

function answerLater(name: string) {
  const one = later<unknown>();
  hold.answers.set(name, one);
  return one;
}

vi.mock("@/lib/i18n/routing", () => ({
  Link: (props: { href: string; children?: unknown }) => createElement("a", { href: props.href }, props.children as never),
}));

vi.mock("@/components/passport/Picture", () => ({
  Picture: () => createElement("span", { "data-picture": true }),
}));

// The card prints the stage it was handed, so the test reads exactly what the
// frame ended on.
vi.mock("@/components/verify/AnswerCard", () => ({
  AnswerCard: ({ stage }: { stage: unknown }) => createElement("pre", { "data-stage": true }, JSON.stringify(stage)),
}));

// The home drop's check steps, fetched on the first press. Each file's answer
// waits until the test settles it.
vi.mock("@/components/home/check", async () => {
  const card = await import("@/components/verify/AnswerCard");
  return {
    AnswerCard: card.AnswerCard,
    sampleFile: () => hold.sampleBytes?.promise ?? Promise.resolve(null),
    answerFor: (file: File) => hold.answers.get(file.name)?.promise ?? Promise.resolve({ kind: "idle" }),
  };
});

// The verify page's own steps, with the same hand-settled answers.
vi.mock("@/components/verify/sample", () => ({
  fileFromSample: () => hold.sampleBytes?.promise,
}));
vi.mock("@/lib/verifier/client", async (importOriginal) => ({
  isMeasured: (await importOriginal<typeof import("@/lib/verifier/client")>()).isMeasured,
  verifierHost: () => "verify.example",
  verify: ({ file }: { file: File }) => hold.answers.get(file.name)?.promise,
}));
vi.mock("@/components/verify/lookup", () => ({
  matchedPassport: async () => null,
}));

const SAMPLE: TrySample = { id: `0x${"2b".repeat(32)}`, url: "ipfs://bafkreisample", title: "A church in a storm" };
const SAMPLE_FILE = "a-church-in-a-storm.jpeg";
const MINE = "my-own-copy.png";

function verifyAnswer(id: string) {
  const queried = { sha256: `0x${"7e".repeat(32)}`, phash: "1", blockhash: `0x${"1f".repeat(32)}`, width: 1, height: 1, format: "png" };
  return {
    result: { exact: id, best: null, matches: [], confidence: 1, queried },
    manifest: { present: false },
  };
}

// The page reads a file's first bytes before sending it, so the fixture opens
// with a real PNG or JPEG signature.
function image(name: string): File {
  const png = name.endsWith(".png");
  const head = png ? [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] : [0xff, 0xd8, 0xff, 0xe0];
  return new File([new Uint8Array([...head, 1, 2, 3])], name, { type: png ? "image/png" : "image/jpeg" });
}

let root: Root;
let host: HTMLElement;

async function mount(node: ReturnType<typeof createElement>) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root.render(createElement(NextIntlClientProvider as never, { locale: "en", messages: en, timeZone: "UTC" }, node));
  });
}

async function flush() {
  await act(async () => {
    for (let turn = 0; turn < 5; turn += 1) {
      await new Promise((settle) => setTimeout(settle, 0));
    }
  });
}

/** Chooses a file through the hidden input, the way the file picker hands one back. */
async function choose(name: string) {
  const input = host.querySelector("input[type=file]") as HTMLInputElement;
  Object.defineProperty(input, "files", { value: [image(name)], configurable: true });
  await act(async () => {
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

function shown(): string {
  return host.querySelector("[data-stage]")?.textContent ?? "";
}

beforeEach(() => {
  hold.sampleBytes = null;
  hold.answers.clear();
  URL.createObjectURL = () => "blob:preview";
  URL.revokeObjectURL = () => undefined;
  window.HTMLElement.prototype.scrollIntoView = () => undefined;
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false,
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
  await act(async () => {
    root.unmount();
  });
  host.remove();
  vi.unstubAllGlobals();
});

describe("the home page's drop", () => {
  async function drop() {
    const { Drop } = await import("@/components/home/Drop");
    await mount(createElement(Drop, { samples: [SAMPLE], look: "board" }));
  }

  it("ends on the chosen file's answer when the sample's answer lands after it", async () => {
    await drop();
    hold.sampleBytes = later<File | null>();
    const sampleAnswer = answerLater(SAMPLE_FILE);
    const mineAnswer = answerLater(MINE);

    await act(async () => {
      (host.querySelector("[data-first-samples] button") as HTMLButtonElement).click();
    });
    await flush();
    hold.sampleBytes.settle(image(SAMPLE_FILE));
    await flush();
    expect(shown()).toContain(SAMPLE_FILE);

    await choose(MINE);
    await flush();
    mineAnswer.settle({ kind: "problem", problem: { key: "mine", reason: MINE } });
    await flush();
    expect(shown()).toContain('"key":"mine"');

    sampleAnswer.settle({ kind: "problem", problem: { key: "sample", reason: SAMPLE_FILE } });
    await flush();
    expect(shown()).toContain('"key":"mine"');
    expect(shown()).not.toContain('"key":"sample"');
  });

  it("ignores the sample's bytes arriving after the file was chosen", async () => {
    await drop();
    hold.sampleBytes = later<File | null>();
    answerLater(SAMPLE_FILE).settle({ kind: "problem", problem: { key: "sample" } });
    const mineAnswer = answerLater(MINE);

    await act(async () => {
      (host.querySelector("[data-first-samples] button") as HTMLButtonElement).click();
    });
    await flush();
    await choose(MINE);
    await flush();
    hold.sampleBytes.settle(image(SAMPLE_FILE));
    await flush();
    expect(shown()).toContain(MINE);
    expect(shown()).not.toContain(SAMPLE_FILE);

    mineAnswer.settle({ kind: "problem", problem: { key: "mine" } });
    await flush();
    expect(shown()).toContain('"key":"mine"');
    expect(shown()).not.toContain('"key":"sample"');
  });

  it("keeps the pressed sample marked only while its own check runs", async () => {
    await drop();
    hold.sampleBytes = later<File | null>();
    const sampleAnswer = answerLater(SAMPLE_FILE);

    await act(async () => {
      (host.querySelector("[data-first-samples] button") as HTMLButtonElement).click();
    });
    await flush();
    const plate = () => host.querySelector("[data-first-samples] button") as HTMLButtonElement;
    expect(plate().getAttribute("aria-busy")).toBe("true");

    hold.sampleBytes.settle(image(SAMPLE_FILE));
    await flush();
    expect(plate().getAttribute("aria-busy")).toBe("true");

    sampleAnswer.settle({ kind: "problem", problem: { key: "sample" } });
    await flush();
    expect(plate().getAttribute("aria-busy")).toBe("false");
  });
});

describe("the verify page", () => {
  async function screen() {
    const { VerifyScreen } = await import("@/components/verify/VerifyScreen");
    await mount(createElement(VerifyScreen, { samples: [SAMPLE] }));
  }

  it("ends on the chosen file's answer when the sample's answer lands after it", async () => {
    await screen();
    hold.sampleBytes = later<File | null>();
    const sampleAnswer = answerLater(SAMPLE_FILE);
    const mineAnswer = answerLater(MINE);
    const sampleId = `0x${"2b".repeat(32)}`;
    const mineId = `0x${"9c".repeat(32)}`;

    await act(async () => {
      (host.querySelector("[data-verify-samples] button") as HTMLButtonElement).click();
    });
    await flush();
    hold.sampleBytes.settle(image(SAMPLE_FILE));
    await flush();

    await choose(MINE);
    await flush();
    mineAnswer.settle(verifyAnswer(mineId));
    await flush();
    expect(shown()).toContain(mineId);

    sampleAnswer.settle(verifyAnswer(sampleId));
    await flush();
    expect(shown()).toContain(mineId);
    expect(shown()).not.toContain(sampleId);
    expect(host.textContent).toContain(MINE);
  });

  it("ignores the sample's bytes arriving after the file was chosen", async () => {
    await screen();
    hold.sampleBytes = later<File | null>();
    answerLater(SAMPLE_FILE).settle(verifyAnswer(`0x${"2b".repeat(32)}`));
    const mineAnswer = answerLater(MINE);
    const mineId = `0x${"9c".repeat(32)}`;

    await act(async () => {
      (host.querySelector("[data-verify-samples] button") as HTMLButtonElement).click();
    });
    await flush();
    await choose(MINE);
    await flush();
    hold.sampleBytes.settle(image(SAMPLE_FILE));
    await flush();
    mineAnswer.settle(verifyAnswer(mineId));
    await flush();

    expect(shown()).toContain(mineId);
    expect(host.textContent).toContain(MINE);
    expect(host.textContent).not.toContain(SAMPLE_FILE);
  });
});
