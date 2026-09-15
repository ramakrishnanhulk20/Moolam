import { beforeEach, describe, expect, it } from "vitest";
import { forwardTouchMove, forwardTouchStart, forwardWheel, scroller } from "@/components/story/signals";

/**
 * The film is pinned, and its scroller now covers the whole pinned screen, so
 * the browser scrolls the story itself wherever a thumb or a wheel lands on it.
 * Two panels still sit above that scroller and take their own taps, the drop
 * panel and the closing card, and a gesture on one of those has to be carried
 * to the story. A gesture the browser is already scrolling with must not be
 * carried twice.
 */

const inside = { name: "a node inside the story's own scroller" } as unknown as Node;
const outside = { name: "a node on a panel above it" } as unknown as Node;

let el: { scrollTop: number; contains: (node: Node) => boolean };

function touch(clientY: number, target: Node) {
  return { target, touches: { length: 1, 0: { clientY } } };
}

beforeEach(() => {
  el = { scrollTop: 0, contains: (node: Node) => node === inside };
  scroller.el = el as unknown as HTMLElement;
});

describe("the pinned film hands its gestures to the story", () => {
  it("moves the story when the wheel turns over a panel above it", () => {
    forwardWheel({ deltaY: 120, target: outside });
    expect(el.scrollTop).toBe(120);
  });

  it("leaves a wheel over the story's own scroller alone, which the browser is already scrolling", () => {
    forwardWheel({ deltaY: 120, target: inside });
    expect(el.scrollTop).toBe(0);
  });

  it("moves the story by the distance a thumb drags over a panel above it", () => {
    forwardTouchStart(touch(600, outside));
    forwardTouchMove(touch(350, outside));
    forwardTouchMove(touch(100, outside));
    expect(el.scrollTop).toBe(500);
  });

  it("drags backwards when the thumb goes the other way", () => {
    el.scrollTop = 900;
    forwardTouchStart(touch(200, outside));
    forwardTouchMove(touch(500, outside));
    expect(el.scrollTop).toBe(600);
  });

  it("leaves a drag that began on the story's own scroller alone", () => {
    forwardTouchStart(touch(200, inside));
    forwardTouchMove(touch(100, inside));
    expect(el.scrollTop).toBe(0);
  });

  it("does nothing at all once the scene has gone", () => {
    scroller.el = null;
    forwardTouchStart(touch(600, outside));
    expect(() => {
      forwardWheel({ deltaY: 120, target: outside });
      forwardTouchMove(touch(100, outside));
    }).not.toThrow();
  });
});
