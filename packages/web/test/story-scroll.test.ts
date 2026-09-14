import { beforeEach, describe, expect, it } from "vitest";
import { forwardTouchMove, forwardTouchStart, forwardWheel, scroller } from "@/components/story/signals";

/**
 * The film is pinned: the scene's own scroll element is only as big as the shot,
 * which on a phone is the top 45 percent of the window. Every gesture below that
 * band has to be carried to it, and a gesture the browser is already scrolling
 * with must not be carried twice.
 */

const inside = { name: "a node inside the shot" } as unknown as Node;
const outside = { name: "a caption below the shot" } as unknown as Node;

let el: { scrollTop: number; contains: (node: Node) => boolean };

function touch(clientY: number, target: Node) {
  return { target, touches: { length: 1, 0: { clientY } } };
}

beforeEach(() => {
  el = { scrollTop: 0, contains: (node: Node) => node === inside };
  scroller.el = el as unknown as HTMLElement;
});

describe("the pinned film hands its gestures to the story", () => {
  it("moves the story when the wheel turns over the captions", () => {
    forwardWheel({ deltaY: 120, target: outside });
    expect(el.scrollTop).toBe(120);
  });

  it("leaves a wheel over the shot alone, which the browser is already scrolling", () => {
    forwardWheel({ deltaY: 120, target: inside });
    expect(el.scrollTop).toBe(0);
  });

  it("moves the story by the distance a thumb drags over the captions", () => {
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

  it("leaves a drag that began on the shot alone", () => {
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
