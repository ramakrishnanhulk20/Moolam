// @vitest-environment jsdom
import { act, createElement, type FunctionComponent, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Hex } from "viem";
import en from "@/messages/en.json";
import type { Stage } from "@/components/verify/AnswerCard";

/**
 * The first screen's polish of 28 September: the window moves to the card only
 * when its top cannot be seen, a second check keeps the first answer's height
 * so the pressed sample stays under the reader's thumb, and only the exhibit
 * that opens something answers the pointer.
 */

const check = vi.hoisted(() => ({
  answerFor: vi.fn(),
  sampleFile: vi.fn(),
}));

vi.mock("@/components/home/check", () => ({
  answerFor: check.answerFor,
  sampleFile: check.sampleFile,
  AnswerCard: ({ stage }: { stage: Stage }) => createElement("div", { "data-card": stage.kind }),
}));
vi.mock("@/lib/i18n/routing", () => ({
  Link: (props: Record<string, unknown> & { href: string; children?: unknown }) => {
    const { children, ...rest } = props;
    return createElement("a", rest, children as never);
  },
}));
vi.mock("@/components/passport/Picture", () => ({
  Picture: (props: { alt?: string }) => createElement("span", { "data-picture": props.alt ?? "" }),
}));
vi.mock("@/components/verify/AnswerCard", () => ({ AnswerCard: () => null }));

const { cardScroll, heldFrame, Drop } = await import("@/components/home/Drop");
const { FINDING_ID } = await import("@/components/home/finding");
const { Board } = await import("@/components/home/Board");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const Provider = NextIntlClientProvider as unknown as FunctionComponent<{
  locale: string;
  messages: unknown;
  timeZone: string;
  children: ReactNode;
}>;

const SAMPLES = [
  { id: `0x${"2b".repeat(32)}` as Hex, url: "https://gateway.example/ipfs/a", title: "Humans Vs AI" },
  { id: `0x${"3c".repeat(32)}` as Hex, url: "https://gateway.example/ipfs/b", title: "Humans on mars" },
];

const ANSWER = { kind: "answer", answer: { kind: "miss" }, passport: null } as unknown as Stage;

describe("when the window moves to the card", () => {
  const HEADER = 56;
  const FOOT = 812;

  it("leaves a card whose top is on screen where it is, however tall it is", () => {
    expect(cardScroll(480, HEADER, FOOT)).toBeNull();
    expect(cardScroll(HEADER, HEADER, FOOT)).toBeNull();
    expect(cardScroll(FOOT, HEADER, FOOT)).toBeNull();
  });

  it("brings a top hidden above the header down to just under it", () => {
    const by = cardScroll(-1200, HEADER, FOOT);
    expect(by).not.toBeNull();
    expect(-1200 - (by as number)).toBeGreaterThan(HEADER);
    expect(-1200 - (by as number)).toBeLessThan(HEADER + 24);
  });

  it("brings a top below the window's foot up to just under the header", () => {
    const by = cardScroll(1400, HEADER, FOOT);
    expect(by).not.toBeNull();
    expect(1400 - (by as number)).toBeGreaterThan(HEADER);
    expect(1400 - (by as number)).toBeLessThan(HEADER + 24);
  });
});

describe("a second check over a landed answer", () => {
  it("holds the frame only while the check is running", () => {
    const held = { height: 1550, under: ANSWER };
    expect(heldFrame({ kind: "checking", name: "Humans on mars" }, held)).toBe(held);
    expect(heldFrame(ANSWER, held)).toBeNull();
    expect(heldFrame({ kind: "idle" }, held)).toBeNull();
    expect(heldFrame({ kind: "checking", name: "first" }, null)).toBeNull();
  });

  let root: Root | null = null;
  let host: HTMLDivElement | null = null;

  beforeEach(() => {
    window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;
    window.matchMedia = ((query: string) => ({ matches: false, media: query })) as unknown as typeof window.matchMedia;
    // jsdom lays nothing out. The frame reports the phone's measured answer
    // height, with its top on screen so nothing scrolls.
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      top: 120,
      height: 1550,
    } as DOMRect);
    check.sampleFile.mockReset().mockImplementation(async (sample: { title: string }) => new File([new Uint8Array(4)], sample.title));
    check.answerFor.mockReset();
  });

  afterEach(async () => {
    await act(async () => root?.unmount());
    host?.remove();
    root = null;
    host = null;
    vi.restoreAllMocks();
  });

  async function press(title: string) {
    const button = host?.querySelector(`button[title="${title}"]`) as HTMLButtonElement;
    await act(async () => {
      button.click();
    });
  }

  it("keeps the answer's height and shows it dimmed under the checking face, then lets go when the new answer lands", async () => {
    let second: (stage: Stage) => void = () => undefined;
    check.answerFor
      .mockResolvedValueOnce(ANSWER)
      .mockImplementationOnce(() => new Promise<Stage>((resolve) => (second = resolve)));

    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () =>
      root?.render(
        createElement(
          Provider,
          { locale: "en", messages: en, timeZone: "UTC" },
          createElement(Drop, { samples: SAMPLES, look: "board" }),
        ),
      ),
    );

    const frame = () => host?.querySelector("[data-first-frame]") as HTMLElement;

    await press("Humans Vs AI");
    expect(host.querySelector('[data-first-answer] [data-card="answer"]')).not.toBeNull();
    expect(frame().style.minHeight).toBe("");

    await press("Humans on mars");
    expect(frame().style.minHeight).toBe("1550px");
    const held = host.querySelector("[data-first-held]") as HTMLElement;
    expect(held).not.toBeNull();
    expect(held.getAttribute("aria-hidden")).toBe("true");
    expect(held.className).toContain("opacity-25");
    expect(held.querySelector('[data-card="answer"]')).not.toBeNull();
    expect(host.querySelector('[data-first-answer] [data-card="checking"]')).not.toBeNull();
    const pressed = host.querySelector('button[title="Humans on mars"]') as HTMLElement;
    expect(pressed.getAttribute("aria-busy")).toBe("true");
    expect(pressed.textContent).toContain("Checking");

    await act(async () => second(ANSWER));
    expect(frame().style.minHeight).toBe("");
    expect(host.querySelector("[data-first-held]")).toBeNull();
    expect(window.scrollTo).not.toHaveBeenCalled();
  });
});

describe("the exhibits", () => {
  const PHASH = 7840506850305415717n;
  const TITLE = "Monsoon Fishing Nets Drying";
  const FINDING = {
    id: FINDING_ID,
    title: TITLE,
    picture: "https://gateway.example/ipfs/full",
    thumbnail: "https://gateway.example/ipfs/thumb",
    registeredAt: 1_788_881_666,
    phash: PHASH.toString(),
    recheck: { matched: true, distance: 0, at: 1_789_380_000 },
    statement: null,
    statementError: null,
  };
  const COPY = {
    image: "data:image/jpeg;base64,AAAA",
    width: 360,
    height: 353,
    bytes: 4080,
    phash: (PHASH ^ 0b11111n).toString(),
    found: true,
    distance: 5,
    confidence: 0.6,
    measuredAt: 1_790_380_000_000,
  };

  function board(): HTMLElement {
    const html = renderToStaticMarkup(
      createElement(
        Provider,
        { locale: "en", messages: en, timeZone: "UTC" },
        createElement(Board, { finding: { read: FINDING }, copy: { read: COPY }, samples: SAMPLES, loose: null }),
      ),
    );
    const page = document.createElement("div");
    page.innerHTML = html;
    return page;
  }

  it("makes exhibit A a link to the registered passport, named in the passport's own words", () => {
    const a = board().querySelector('[data-exhibit="A"]') as HTMLElement;
    expect(a.tagName).toBe("A");
    expect(a.getAttribute("href")).toBe(`/passport/${FINDING_ID}`);
    expect(a.getAttribute("aria-label")).toBe(`Open the passport: ${TITLE}`);
    expect(a.textContent).toContain("Exhibit A");
  });

  it("keeps exhibit B still: not a link and with no hover effect", () => {
    const b = board().querySelector('[data-exhibit="B"]') as HTMLElement;
    expect(b.tagName).toBe("DIV");
    expect(b.closest("a")).toBeNull();
    const figure = b.closest("figure") as HTMLElement;
    expect(figure.outerHTML).not.toMatch(/hover:/);
  });

  it("puts both exhibits on the same four rows, so the two fingerprints start on one line", () => {
    const figures = board().querySelectorAll("figure");
    expect(figures).toHaveLength(2);
    for (const figure of figures) {
      expect(figure.className).toContain("grid-rows-subgrid");
      expect(figure.className).toContain("row-span-4");
      expect(figure.lastElementChild?.tagName).toBe("FIGCAPTION");
    }
  });

  it("points the hint at the passports only when there are passports to press", () => {
    const render = (samples: typeof SAMPLES) =>
      renderToStaticMarkup(
        createElement(
          Provider,
          { locale: "en", messages: en, timeZone: "UTC" },
          createElement(Drop, { samples, look: "board" }),
        ),
      );
    expect(render(SAMPLES)).toContain("Press one of these real passports");
    const bare = render([]);
    expect(bare).not.toContain("Press one of these");
    expect(bare).toContain(en.verify.hint);
  });
});
