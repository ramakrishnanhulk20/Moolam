// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { createElement, type FunctionComponent, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import en from "@/messages/en.json";
import { KEEP_CLEAR, LAPTOP, cardWidth, keepClearOn, overlaps, placeCard, type Box } from "@/components/guide/place";

/**
 * The walk's card never covers the hero's two calls.
 *
 * Every box below was measured in Chromium on the live home page on
 * 2026-09-25, on a fresh visit with the walk at step one: the two calls, the
 * Verify anchor the light sits on, and the card itself. At 375 by 812 the card
 * sat at y 538 to 783 and the calls at y 586 to 623, which is the fault.
 */

vi.mock("@/lib/i18n/routing", () => ({
  Link: ({ href, children, ...rest }: { href: string | { pathname: string }; children?: ReactNode }) =>
    createElement("a", { href: typeof href === "string" ? href : href.pathname, ...rest }, children),
}));

const { heroCalls, spotFor } = await import("@/components/guide/GuideWalk");
const { HeroCredits } = await import("@/components/story/HeroCredits");

/** The light the walk draws round an anchor: the anchor, padded 8 on every side. */
function lit(anchor: Box): Box {
  return { x: anchor.x - 8, y: anchor.y - 8, width: anchor.width + 16, height: anchor.height + 16 };
}

const MEASURED = [
  {
    screen: "375x812",
    stage: { width: 375, height: 812 },
    calls: [
      { x: 20, y: 587, width: 151, height: 35 },
      { x: 179, y: 586, width: 101, height: 37 },
    ],
    anchor: { x: 225, y: 756, width: 75, height: 56 },
    card: 245,
    before: { x: 39, y: 538 },
  },
  {
    screen: "360x740",
    stage: { width: 360, height: 740 },
    calls: [
      { x: 20, y: 555, width: 151, height: 35 },
      { x: 179, y: 554, width: 101, height: 37 },
    ],
    anchor: { x: 216, y: 684, width: 72, height: 56 },
    card: 245,
    before: { x: 24, y: 466 },
  },
  {
    screen: "1440x900",
    stage: { width: 1440, height: 900 },
    calls: [
      { x: 56, y: 775, width: 219, height: 45 },
      { x: 287, y: 774, width: 159, height: 47 },
    ],
    anchor: { x: 824, y: 21, width: 103, height: 20 },
    card: 257,
    before: { x: 804, y: 75 },
  },
];

describe("the card and the hero's two calls, on measured screens", () => {
  for (const one of MEASURED) {
    it(`leaves both calls clear at ${one.screen}, with the light still on the anchor`, () => {
      const spot = lit(one.anchor);
      const place = placeCard({ stage: one.stage, spot, height: one.card, keepClear: one.calls });
      const card = { x: place.x, y: place.y, width: place.width, height: one.card };

      for (const call of one.calls) {
        expect(overlaps(card, call), `card ${JSON.stringify(card)} on call ${JSON.stringify(call)}`).toBe(false);
      }
      // Still on the screen, and not lying over the thing it is pointing at.
      expect(card.y).toBeGreaterThanOrEqual(16);
      expect(card.y + card.height).toBeLessThanOrEqual(one.stage.height - 16);
      expect(card.x).toBeGreaterThanOrEqual(16);
      expect(card.x + card.width).toBeLessThanOrEqual(one.stage.width - 16);
      expect(overlaps(card, spot)).toBe(false);
    });
  }

  it("would have covered them on both phones without the calls marked, as the audit measured", () => {
    for (const one of MEASURED.slice(0, 2)) {
      const place = placeCard({ stage: one.stage, spot: lit(one.anchor), height: one.card });
      const card = { x: place.x, y: place.y, width: place.width, height: one.card };
      expect(one.calls.some((call) => overlaps(card, call))).toBe(true);
    }
  });

  it("puts the phone card on the side of the calls away from the bar: above them", () => {
    const [phone, small] = MEASURED;
    const top = (one: (typeof MEASURED)[number]) =>
      placeCard({ stage: one.stage, spot: lit(one.anchor), height: one.card, keepClear: one.calls });

    // 12 px of air above the higher call, and the whole width less the gutters.
    expect(top(phone)).toMatchObject({ x: 16, y: 586 - 12 - 245, below: false });
    expect(top(small)).toMatchObject({ x: 16, y: 554 - 12 - 245, below: false });
  });

  it("changes nothing where the calls were never in the way", () => {
    const desk = MEASURED[2];
    const place = placeCard({ stage: desk.stage, spot: lit(desk.anchor), height: desk.card, keepClear: desk.calls });
    // Where the live site already drew it, hanging under the header's Verify.
    expect(place).toMatchObject({ x: desk.before.x, y: desk.before.y, below: true });
  });

  it("keeps a card with nothing to light off the calls too", () => {
    for (const one of MEASURED) {
      const place = placeCard({ stage: one.stage, spot: null, height: one.card + 60, keepClear: one.calls });
      const card = { x: place.x, y: place.y, width: place.width, height: one.card + 60 };
      expect(one.calls.some((call) => overlaps(card, call))).toBe(false);
      expect(card.y).toBeGreaterThanOrEqual(16);
    }
  });
});

/**
 * The same rule on the first screen, which is where the walk opens now.
 *
 * Measured in headless Chromium against the dev server on 2026-09-25, a fresh
 * context with the walk at step one and no film mounted. The calls are the
 * Choose an image button and Make one; the words are the headline and its
 * line. "drawn" is where the browser put the card, and card is its measured
 * height, which is taller in Tamil. Below a laptop the card is the screen's
 * width less 16 px each side, up to 400, with 16 px of padding inside and
 * its title free of the laptop's 16ch cap.
 */
const FIRST_SCREEN = [
  {
    screen: "en 1440x900",
    stage: { width: 1440, height: 900 },
    calls: [
      { x: 369, y: 511, width: 187, height: 44 },
      { x: 56, y: 832, width: 149, height: 44 },
    ],
    headline: { x: 56, y: 127, width: 534, height: 223 },
    line: { x: 56, y: 370, width: 564, height: 84 },
    anchor: { x: 821, y: 21, width: 103, height: 20 },
    card: 257,
    drawn: { x: 801, y: 75 },
  },
  {
    screen: "en 375x812",
    stage: { width: 375, height: 812 },
    calls: [
      { x: 45, y: 572, width: 187, height: 44 },
      { x: 20, y: 883, width: 149, height: 44 },
    ],
    headline: { x: 20, y: 141, width: 335, height: 150 },
    line: { x: 20, y: 314, width: 335, height: 104 },
    anchor: { x: 225, y: 756, width: 75, height: 56 },
    card: 237,
    drawn: { x: 16, y: 323 },
  },
  {
    screen: "en 360x740",
    stage: { width: 360, height: 740 },
    calls: [
      { x: 45, y: 609, width: 187, height: 44 },
      { x: 20, y: 916, width: 149, height: 44 },
    ],
    headline: { x: 20, y: 141, width: 320, height: 187 },
    line: { x: 20, y: 352, width: 320, height: 104 },
    anchor: { x: 216, y: 684, width: 72, height: 56 },
    card: 237,
    drawn: { x: 16, y: 360 },
  },
  {
    screen: "ta 360x740",
    stage: { width: 360, height: 740 },
    calls: [
      { x: 45, y: 679, width: 242, height: 44 },
      { x: 20, y: 1020, width: 210, height: 44 },
    ],
    headline: { x: 20, y: 141, width: 320, height: 204 },
    line: { x: 20, y: 369, width: 320, height: 156 },
    anchor: { x: 216, y: 684, width: 72, height: 56 },
    card: 278,
    drawn: { x: 16, y: 382 },
  },
  {
    screen: "ta 375x812",
    stage: { width: 375, height: 812 },
    calls: [
      { x: 45, y: 653, width: 242, height: 44 },
      { x: 20, y: 998, width: 210, height: 44 },
    ],
    headline: { x: 20, y: 141, width: 335, height: 204 },
    line: { x: 20, y: 369, width: 335, height: 130 },
    anchor: { x: 225, y: 756, width: 75, height: 56 },
    card: 258,
    drawn: { x: 16, y: 383 },
  },
];

/** What the walk hands placeCard on this screen: the line only on a laptop. */
function marksOn(one: (typeof FIRST_SCREEN)[number]): Box[] {
  return one.stage.width >= LAPTOP ? [...one.calls, one.headline, one.line] : [...one.calls, one.headline];
}

describe("how wide the card is drawn", () => {
  it("uses the phone's whole width less the gutters, and its own width on a laptop", () => {
    expect(cardWidth(375)).toBe(343);
    expect(cardWidth(360)).toBe(328);
    expect(cardWidth(767)).toBe(400);
    expect(cardWidth(1023)).toBe(400);
    expect(cardWidth(1024)).toBe(320);
    expect(cardWidth(1440)).toBe(320);
  });
});

describe("the card, the first screen's two calls and its words, on measured screens", () => {
  const [desk, phone, small, tamilSmall, tamilPhone] = FIRST_SCREEN;

  for (const one of [desk, phone, small, tamilSmall, tamilPhone]) {
    it(`leaves the headline, Choose an image, Make one and the lit tab clear in ${one.screen}, where the browser drew it`, () => {
      const spot = lit(one.anchor);
      const place = placeCard({ stage: one.stage, spot, height: one.card, keepClear: marksOn(one) });
      const card = { x: place.x, y: place.y, width: place.width, height: one.card };

      expect({ x: place.x, y: place.y }).toEqual(one.drawn);
      for (const box of [...one.calls, one.headline]) {
        expect(overlaps(card, box), `card ${JSON.stringify(card)} on ${JSON.stringify(box)}`).toBe(false);
      }
      expect(overlaps(card, spot)).toBe(false);
      expect(card.y).toBeGreaterThanOrEqual(16);
      expect(card.y + card.height).toBeLessThanOrEqual(one.stage.height - 16);
    });
  }

  it("keeps the line clear on a laptop too", () => {
    const place = placeCard({ stage: desk.stage, spot: lit(desk.anchor), height: desk.card, keepClear: marksOn(desk) });
    expect(overlaps({ x: place.x, y: place.y, width: place.width, height: desk.card }, desk.line)).toBe(false);
  });

  it("lies on the line on a phone, the one mark it may cover there", () => {
    for (const one of [phone, small, tamilSmall, tamilPhone]) {
      const place = placeCard({ stage: one.stage, spot: lit(one.anchor), height: one.card, keepClear: marksOn(one) });
      expect(overlaps({ x: place.x, y: place.y, width: place.width, height: one.card }, one.line)).toBe(true);
    }
  });

  it("moves a card that would lie on the words to the nearest clear side of them", () => {
    // A light up among the words asks for a card hanging over the headline's
    // line; the words are marked, so the card goes clear of them instead.
    const spot = { x: 300, y: 250, width: 100, height: 40 };
    const place = placeCard({ stage: desk.stage, spot, height: desk.card, keepClear: marksOn(desk) });
    const card = { x: place.x, y: place.y, width: place.width, height: desk.card };
    expect(overlaps(card, desk.line)).toBe(false);
    expect(overlaps(card, desk.headline)).toBe(false);
    expect(overlaps(card, spot)).toBe(false);
    // With nothing marked it would have hung over the line.
    const blind = placeCard({ stage: desk.stage, spot, height: desk.card });
    expect(overlaps({ x: blind.x, y: blind.y, width: blind.width, height: desk.card }, desk.line)).toBe(true);
  });

  it("leaves at least 8 px to spare on every measured phone, for fonts that render a little taller", () => {
    for (const one of [phone, small, tamilSmall, tamilPhone]) {
      const room = one.calls[0].y - 12 - (one.headline.y + one.headline.height + 12);
      expect(room - one.card, one.screen).toBeGreaterThanOrEqual(8);
    }
  });
});

describe("where the walk learns the calls are", () => {
  function onScreen(node: Element, rect: Box) {
    const box = {
      left: rect.x,
      top: rect.y,
      width: rect.width,
      height: rect.height,
      right: rect.x + rect.width,
      bottom: rect.y + rect.height,
      x: rect.x,
      y: rect.y,
      toJSON: () => "",
    } as DOMRect;
    node.getBoundingClientRect = () => box;
    node.getClientRects = () => [box] as unknown as DOMRectList;
  }

  it("is no longer on the film's credits: the first screen carries the marks", () => {
    const Provider = NextIntlClientProvider as unknown as FunctionComponent<{
      locale: string;
      messages: unknown;
      timeZone: string;
      children: ReactNode;
    }>;
    const markup = renderToStaticMarkup(
      createElement(
        Provider,
        { locale: "en", messages: en, timeZone: "Asia/Kolkata" },
        createElement(HeroCredits, { entered: true }),
      ),
    );
    expect(markup).toMatch(/<a[^>]*>Generate an image/);
    expect(markup).not.toContain("data-hero-call");
  });

  it("reads the words' mark with the calls', and leaves the line out on a phone", () => {
    expect(KEEP_CLEAR).toBe("[data-hero-call], [data-hero-words]");
    expect(keepClearOn(1440)).toBe(KEEP_CLEAR);
    const root = document.createElement("div");
    root.innerHTML =
      '<h1 data-hero-words="headline">Every image</h1><p data-hero-words="line">line</p>' +
      '<button data-hero-call="choose">c</button><p>helper</p>';
    document.body.append(root);
    const [head, line, choose, helper] = [...root.children];
    onScreen(head, { x: 20, y: 141, width: 335, height: 150 });
    onScreen(line, { x: 20, y: 314, width: 335, height: 104 });
    onScreen(choose, { x: 45, y: 572, width: 187, height: 44 });
    onScreen(helper, { x: 45, y: 628, width: 257, height: 39 });
    expect(heroCalls(root, { left: 0, top: 0, width: 1440, height: 900 })).toEqual([
      { x: 20, y: 141, width: 335, height: 150 },
      { x: 20, y: 314, width: 335, height: 104 },
      { x: 45, y: 572, width: 187, height: 44 },
    ]);
    expect(heroCalls(root, { left: 0, top: 0, width: 375, height: 812 })).toEqual([
      { x: 20, y: 141, width: 335, height: 150 },
      { x: 45, y: 572, width: 187, height: 44 },
    ]);
  });

  it("reads only the marked calls that are on the screen, against the stage", () => {
    // The film carries the credits twice, one copy for a phone and one for a
    // laptop, and only one is ever displayed.
    const root = document.createElement("div");
    root.innerHTML =
      '<a data-hero-call="generate">g</a><a data-hero-call="verify">v</a>' +
      '<a data-hero-call="generate">hidden copy</a><a>not a call</a>';
    document.body.append(root);
    const [generate, verify, , plain] = [...root.children];
    onScreen(generate, { x: 20, y: 587, width: 151, height: 35 });
    onScreen(verify, { x: 179, y: 586, width: 101, height: 37 });
    onScreen(plain, { x: 0, y: 0, width: 50, height: 50 });

    expect(heroCalls(root, { left: 0, top: 0, width: 375, height: 812 })).toEqual([
      { x: 20, y: 587, width: 151, height: 35 },
      { x: 179, y: 586, width: 101, height: 37 },
    ]);
    // A bench's frame sits somewhere on the page; its calls are measured from it.
    expect(heroCalls(root, { left: 10, top: 100, width: 375, height: 812 })[0]).toEqual({
      x: 10,
      y: 487,
      width: 151,
      height: 35,
    });
  });

  it("leaves a call the film has faded out", () => {
    const root = document.createElement("div");
    root.innerHTML = '<a data-hero-call="verify">v</a>';
    document.body.append(root);
    const call = root.firstElementChild as HTMLElement;
    onScreen(call, { x: 179, y: 586, width: 101, height: 37 });
    call.checkVisibility = () => false;

    expect(heroCalls(root, { left: 0, top: 0, width: 375, height: 812 })).toEqual([]);
  });

  it("keeps the light on the step's own anchor, whatever the card does", () => {
    const root = document.createElement("div");
    root.innerHTML = '<a data-guide-anchor="verify">Verify</a>';
    document.body.append(root);
    onScreen(root.firstElementChild as Element, MEASURED[0].anchor);
    expect(spotFor("verify", root, { left: 0, top: 0, width: 375, height: 812 })).toEqual(lit(MEASURED[0].anchor));
  });
});
