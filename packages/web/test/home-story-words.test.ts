// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import en from "@/messages/en.json";
import type { TrySample } from "@/lib/data/samples";
import type { StoryData } from "@/components/story/data";

/**
 * WO-217: the first screen and the film's own panels speak like the rest of the
 * site. One case per step: the drop's unstarted line (2), the film's try panel
 * in the first screen's shape and safe against a second press (3), failures
 * with the warning mark and the raw words folded under Details (4), the still
 * page's translated copy names and bit distances (5), the closing card's dash
 * for a count it could not read (6), 44 px calls and no label under 11 px (7),
 * the pinned panel scrolling inside itself (8), one look for the secondary
 * buttons (9), and the board's Try again when nothing could be read (10).
 *
 * Does NOT cover how any of this looks in a browser at 375 px or 1440 px, the
 * film's scene, or the verify page's own card, which has its own tests.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const hold = vi.hoisted(() => ({
  answers: new Map<string, { promise: Promise<unknown>; settle: (value: unknown) => void; fail: (error: unknown) => void }>(),
  sampleFile: null as null | ((sample: { title?: string | null }) => Promise<File>),
  refreshed: 0,
}));

function later(name: string) {
  let settle!: (value: unknown) => void;
  let fail!: (error: unknown) => void;
  const promise = new Promise<unknown>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });
  // A failure set before anything asks for it is still handled, by the panel, later.
  promise.catch(() => undefined);
  const one = { promise, settle, fail };
  hold.answers.set(name, one);
  return one;
}

vi.mock("@/lib/i18n/routing", () => ({
  Link: (props: { href: string; className?: string; children?: unknown }) =>
    createElement("a", { href: props.href, className: props.className }, props.children as never),
}));

vi.mock("@/components/passport/Picture", () => ({
  Picture: (props: { alt?: string }) => createElement("span", { "data-picture": props.alt ?? "" }),
}));

// The first screen's check code never arrives, which is the one way its drop
// can fail before any card exists to say so.
vi.mock("@/components/home/check", () => {
  throw new Error("Loading chunk components_home_check failed.");
});

vi.mock("@/components/verify/sample", () => ({
  fileFromSample: (sample: { title?: string | null }) =>
    hold.sampleFile?.(sample) ?? Promise.resolve(new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1])], `${sample.title}.jpeg`)),
}));

vi.mock("@/lib/verifier/client", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/verifier/client")>();
  return {
    ...real,
    verify: ({ file }: { file: File }) => hold.answers.get(file.name)?.promise ?? Promise.reject(new Error("no answer set")),
  };
});

vi.mock("@/components/verify/lookup", () => ({ matchedPassport: async () => null }));

const { Drop } = await import("@/components/home/Drop");
const { Board } = await import("@/components/home/Board");
const { SECONDARY_BUTTON } = await import("@/components/home/Headline");
const { ReadAgain } = await import("@/components/home/ReadAgain");
const { TryPanel, answerScroll, stillCurrent } = await import("@/components/story/TryPanel");
const { CloseCard, UNREAD_FIGURE } = await import("@/components/story/CloseCard");
const { StillStory } = await import("@/components/story/StillStory");
const { degradeSteps } = await import("@/components/story/measurements");

const PASSPORT = `0x${"7c".repeat(32)}`;
const SAMPLES: TrySample[] = [
  { id: PASSPORT, url: "ipfs://bafkreisample", title: "A church in a storm" },
  { id: `0x${"2b".repeat(32)}`, url: "ipfs://bafkreiother", title: "A harbour at dusk" },
];

function served(distance: number) {
  const best = { id: PASSPORT, phashDistance: distance, blockhashDistance: 4, variant: "identity", score: 0.94 };
  return {
    result: {
      exact: null,
      best,
      matches: [best],
      confidence: 0.94,
      queried: { sha256: PASSPORT, phash: "7840506850305415717", blockhash: `0x${"1f".repeat(32)}`, width: 512, height: 384, format: "jpeg" },
    },
    manifest: { present: true },
  };
}

function image(name: string): File {
  return new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])], name, { type: "image/jpeg" });
}

function inEnglish(node: ReactElement) {
  return createElement(NextIntlClientProvider as never, { locale: "en", messages: en, timeZone: "UTC" }, node);
}

function markup(node: ReactElement): string {
  return renderToStaticMarkup(inEnglish(node));
}

let root: Root | null = null;
let host: HTMLElement;

async function mount(node: ReactElement) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(inEnglish(node));
  });
}

async function flush() {
  await act(async () => {
    for (let turn = 0; turn < 8; turn += 1) {
      await new Promise((settle) => setTimeout(settle, 0));
    }
  });
}

async function press(node: Element | null) {
  await act(async () => {
    (node as HTMLElement).click();
  });
}

async function choose(name: string) {
  const input = host.querySelector("input[type=file]") as HTMLInputElement;
  Object.defineProperty(input, "files", { value: [image(name)], configurable: true });
  await act(async () => {
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

beforeEach(() => {
  hold.answers.clear();
  hold.sampleFile = null;
  hold.refreshed = 0;
  URL.createObjectURL = () => "blob:preview";
  URL.revokeObjectURL = () => undefined;
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false,
    media: query,
    addEventListener() {},
    removeEventListener() {},
  }));
});

afterEach(async () => {
  if (root !== null) {
    await act(async () => {
      root?.unmount();
    });
    root = null;
  }
  host?.remove();
  vi.unstubAllGlobals();
});

const DATA: StoryData = {
  source: "envio",
  plates: [],
  focal: null,
  attestation: null,
  agent: null,
  statement: null,
  statementError: null,
  passportCount: null,
  attestationCount: null,
  error: "the Envio endpoint answered 429",
};

describe("step 2: the drop when the check's code did not load", () => {
  it("says the check did not start and what to do, with the warning mark, never the bare problem label", async () => {
    await mount(createElement(Drop, { samples: SAMPLES, look: "board" }));
    await press(host.querySelector("[data-first-samples] button"));
    await flush();

    const line = host.querySelector("[data-first-unstarted]");
    expect(line?.textContent).toBe(en.home.first.unstarted);
    expect(line?.textContent).not.toBe(en.verify.problemLabel);
    expect(line?.firstElementChild?.tagName.toLowerCase()).toBe("svg");
  });
});

describe("step 3: the film's try panel answers in the first screen's shape", () => {
  it("leads with the verdict and bits apart, names its samples, fills Choose, and does not say Drop on a phone", async () => {
    later("A church in a storm.jpeg").settle(served(3));
    await mount(createElement(TryPanel, { onPreview: () => undefined, samples: SAMPLES, pinned: false }));

    expect(host.querySelector('[data-try-title="phone"]')?.textContent).toBe(en.home.first.check);
    expect(host.querySelector('[data-try-title="phone"]')?.className).toContain("lg:hidden");
    const choose = host.querySelector("[data-try-choose]") as HTMLButtonElement;
    expect(choose.textContent).toBe(en.verify.choose);
    expect(choose.className).toContain("bg-accent");
    expect(choose.className).toContain("h-11");
    const names = [...host.querySelectorAll("[data-try-samples] button")].map((button) => button.textContent);
    expect(names).toEqual(SAMPLES.map((sample) => sample.title));

    await press(host.querySelector("[data-try-samples] button"));
    await flush();

    expect(host.querySelector("[data-try-verdict]")?.textContent).toBe("Yes. This is the same picture as A church in a storm.");
    expect(host.querySelector("[data-try-bits]")?.textContent).toContain("3 of 64 bits apart");
    expect(host.textContent).not.toContain("0.94");
  });

  it("disables its samples while a check runs, and a slower first answer never lands under a second press", async () => {
    const first = later("A church in a storm.jpeg");
    const second = later("my-own-copy.jpeg");
    await mount(createElement(TryPanel, { onPreview: () => undefined, samples: SAMPLES, pinned: false }));

    await press(host.querySelector("[data-try-samples] button"));
    await flush();
    const plates = [...host.querySelectorAll<HTMLButtonElement>("[data-try-samples] button")];
    expect(plates.every((plate) => plate.disabled)).toBe(true);
    expect(plates[0].getAttribute("aria-busy")).toBe("true");
    expect((host.querySelector("[data-try-choose]") as HTMLButtonElement).disabled).toBe(true);

    await choose("my-own-copy.jpeg");
    second.settle(served(1));
    await flush();
    first.settle(served(9));
    await flush();

    expect(host.querySelector("[data-try-bits]")?.textContent).toContain("1 of 64 bits apart");
    expect(host.textContent).toContain("my-own-copy.jpeg");
    expect(stillCurrent(2, 1)).toBe(false);
    expect(stillCurrent(2, 2)).toBe(true);
  });
});

describe("step 4: a failure has the warning mark and its raw words folded shut", () => {
  it("in the film's try panel", async () => {
    later("A church in a storm.jpeg").fail(new Error("the Envio endpoint answered 429"));
    await mount(createElement(TryPanel, { onPreview: () => undefined, samples: SAMPLES, pinned: false }));
    await press(host.querySelector("[data-try-samples] button"));
    await flush();

    const failed = host.querySelector("[data-try-failed]") as HTMLElement;
    const line = failed.querySelector("[role=alert]");
    expect(line?.firstElementChild?.tagName.toLowerCase()).toBe("svg");
    expect(line?.textContent).toBe(en.story.tryIt.error);
    const details = failed.querySelector("details") as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(details.querySelector("summary")?.textContent).toContain(en.common.details);
    expect(details.textContent).toContain("the Envio endpoint answered 429");
  });

  it("on the closing card", () => {
    const html = markup(createElement(CloseCard, { data: DATA, pinned: false }));
    const error = html.slice(html.indexOf("data-close-error"));
    expect(error).toMatch(/^[^>]*><p[^>]*><svg/);
    expect(error).toContain(en.story.close.error);
    expect(error).toContain("<details");
    expect(error).not.toMatch(/<details[^>]* open/);
    expect(error).toContain("the Envio endpoint answered 429");
  });
});

describe("step 5: the still page prints the film's own words for each copy", () => {
  it("shows translated copy names and bits apart, never the verifier's file names", () => {
    const html = markup(
      createElement(StillStory, {
        data: { ...DATA, error: null, passportCount: 3, attestationCount: 1 },
        table: { beat: {} } as never,
        beats: [
          { key: "shared", body: null },
          { key: "verified", body: null },
        ],
      }),
    );
    const ladder = html.slice(html.indexOf("data-still-ladder"), html.indexOf("</ul>", html.indexOf("data-still-ladder")));
    const frames = html.slice(html.indexOf("data-still-frames"), html.indexOf("</ul>", html.indexOf("data-still-frames")));

    for (const step of degradeSteps()) {
      expect(ladder).toContain(en.story.verified.copies[step.transform as keyof typeof en.story.verified.copies]);
      expect(ladder).toContain(`${step.phashDistance} of 64 bits apart: match`);
    }
    expect(frames).toContain(en.story.verified.copies["reencode-q30"]);
    const social = degradeSteps().find((step) => step.transform === "social-chain");
    expect(frames).toContain(`${social?.phashDistance} of 64 bits apart: match`);
    for (const name of ["reencode-q30", "reencode-q60", "social-chain", "resize-10", "rotate-90"]) {
      expect(ladder + frames).not.toMatch(new RegExp(`>${name}<`, "i"));
    }
  });
});

describe("step 6: the closing card with no counts", () => {
  it("draws the dash at display size and says why in body size beside it", () => {
    const html = markup(createElement(CloseCard, { data: DATA, pinned: false }));
    const figures = html.match(/<dd data-close-figure="unread"[^>]*>(.*?)<\/dd>/g) ?? [];
    expect(figures).toHaveLength(2);
    for (const figure of figures) {
      expect(figure).toContain(`<span aria-hidden="true">${UNREAD_FIGURE}</span>`);
      expect(figure).toContain(`<span class="sr-only">${en.story.close.unread}</span>`);
    }
    const line = html.slice(html.indexOf("data-close-error"));
    expect(line).toMatch(/<p role="status" class="[^"]*text-base/);
    expect(line.slice(0, line.indexOf("</p>"))).not.toContain("text-sm");
  });
});

describe("step 7: the panels' calls and labels on a phone", () => {
  it("gives the closing card's two calls 44 px and pads the proof link", () => {
    const html = markup(createElement(CloseCard, { data: { ...DATA, error: null, passportCount: 3, attestationCount: 1 }, pinned: false }));
    const calls = html.slice(html.indexOf("data-close-calls"), html.indexOf("<dl"));
    expect(calls.match(/min-h-11/g)).toHaveLength(2);
    expect(html).toMatch(/<a href="\/docs\/proof" class="tap /);
  });

  it("sets no sentence or label under 11 px on the drop, the board, the try panel or the closing card", () => {
    const pages = [
      markup(createElement(Drop, { samples: SAMPLES, look: "board" })),
      markup(createElement(Board, { finding: { failed: "down" }, copy: { failed: "down" }, samples: SAMPLES, loose: null })),
      markup(createElement(TryPanel, { onPreview: () => undefined, samples: SAMPLES, pinned: true })),
      markup(createElement(CloseCard, { data: DATA, pinned: true })),
    ];
    for (const html of pages) {
      // The sponsor line along the board's foot is Billing.tsx, outside this order.
      // The shared Details disclosure draws its summary at 10 px; these panels
      // lift it to 11 px from the details element, which outranks it.
      const own = html
        .replace(/<p data-first-billing[\s\S]*?<\/p>/, "")
        .replace(/(\[&amp;_summary\]:text-\[11px\]"><summary class="[^"]*?)text-\[10px\]/g, "$1");
      expect(own).not.toMatch(/text-\[(?:[0-9]|10)px\]/);
    }
  });
});

describe("step 8: the pinned try panel on a phone", () => {
  it("scrolls inside its own box, which the film holds to the room above the bar", () => {
    const html = markup(createElement(TryPanel, { onPreview: () => undefined, samples: SAMPLES, pinned: true }));
    expect(html).toMatch(/class="mx-auto w-full max-w-\[100rem\] flex max-h-full flex-col"/);
    const box = html.slice(html.indexOf("data-try-panel"));
    expect(box).toMatch(/^[^>]*min-h-0 overflow-y-auto/);
  });

  it("brings a new answer up inside the panel only when it cannot be read where it is", () => {
    expect(answerScroll(100, 80, 0, 300)).toBeNull();
    expect(answerScroll(400, 200, 0, 300)).toBe(388);
    expect(answerScroll(20, 50, 200, 300)).toBe(8);
    expect(answerScroll(250, 400, 0, 300)).toBe(238);
  });
});

describe("step 9: one look for the secondary buttons", () => {
  it("is shared by Check another, the closing card's Verify an image and the board's Try again", () => {
    const classes = SECONDARY_BUTTON.split(" ");
    expect(classes).toEqual(expect.arrayContaining(["min-h-11", "font-mono", "text-[11px]", "tracking-[0.18em]", "rounded-[8px]"]));

    const close = markup(createElement(CloseCard, { data: DATA, pinned: false }));
    const verify = close.match(/<a href="\/verify" class="([^"]*)"/)?.[1] ?? "";
    const board = markup(createElement(Board, { finding: { failed: "down" }, copy: { failed: "down" }, samples: [], loose: null }));
    const again = board.match(/<button type="button" data-first-read-again="true"[^>]* class="([^"]*)"/)?.[1] ?? "";

    // Check another only shows once a card is up, and the card's code never
    // loads in this file, so it is read from the line that draws it.
    const drop = readFileSync("components/home/Drop.tsx", "utf8");
    expect(drop).toContain("className={`mt-3 ${SECONDARY_BUTTON}`}");
    expect(drop.slice(drop.indexOf('{t("again")}') - 400, drop.indexOf('{t("again")}'))).toContain("SECONDARY_BUTTON");

    for (const used of [verify, again]) {
      for (const name of classes) {
        expect(used.split(" ")).toContain(name);
      }
    }
  });
});

describe("step 10: the board when neither the registry nor the index answered", () => {
  it("shows its failure line with the warning mark and a Try again, not a red square", async () => {
    const html = markup(createElement(Board, { finding: { failed: "down" }, copy: { failed: "down" }, samples: [], loose: null }));
    const loose = html.slice(html.indexOf("data-first-loose"), html.indexOf("data-first-loose") + 2000);
    expect(loose).toMatch(/data-first-unread[^>]*><svg/);
    expect(loose).toContain(en.home.first.unread);
    expect(loose).toContain(`>${en.common.tryAgain}</button>`);
    expect(loose).not.toContain("bg-failed");

    await mount(
      createElement(ReadAgain, {
        reload: () => {
          hold.refreshed += 1;
        },
      }),
    );
    const button = host.querySelector("[data-first-read-again]") as HTMLButtonElement;
    await press(button);
    expect(hold.refreshed).toBe(1);
    expect(button.disabled).toBe(true);
    expect(button.textContent).toBe(en.retry.trying);
  });

  it("keeps Try again off the board while the index still gave a picture", () => {
    const html = markup(
      createElement(Board, {
        finding: { failed: "down" },
        copy: { failed: "down" },
        samples: [],
        loose: { id: PASSPORT as `0x${string}`, title: "A church in a storm", thumbnail: "ipfs://bafkreithumb", statement: null },
      }),
    );
    expect(html).not.toContain("data-first-read-again");
    expect(html).toMatch(/data-first-unread[^>]*><svg/);
  });
});
