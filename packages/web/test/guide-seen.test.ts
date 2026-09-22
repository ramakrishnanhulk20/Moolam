// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  GUIDE_SEEN_KEY,
  RETURNING_KEY,
  forgetGuideSeen,
  guideSeen,
  guideShouldShow,
  guideShouldShowHere,
  markGuideSeen,
  onLabPage,
  signedInBefore,
} from "@/components/guide/seen";
import { guideSteps, nextStep } from "@/components/guide/steps";

/**
 * The first-visit guide is the one thing on the site that is allowed to
 * interrupt somebody, so the rule that decides whether it appears is worth more
 * tests than the drawing it opens: once per device, never for a returning
 * wallet, never on a bench page, and never a loop on a browser that keeps
 * nothing.
 */

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the mark a device carries once the guide has been shown", () => {
  it("is not there on a browser that has never been here", () => {
    expect(guideSeen()).toBe(false);
  });

  it("is written on close and read back", () => {
    markGuideSeen();
    expect(window.localStorage.getItem(GUIDE_SEEN_KEY)).toBe("1");
    expect(guideSeen()).toBe(true);
  });

  it("is taken back when somebody asks for the guide again", () => {
    markGuideSeen();
    forgetGuideSeen();
    expect(window.localStorage.getItem(GUIDE_SEEN_KEY)).toBeNull();
    expect(guideSeen()).toBe(false);
  });

  it("counts a browser that refuses storage as seen, so the guide never loops", () => {
    const blocked = () => {
      throw new Error("The user denied permission to access the database.");
    };
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(blocked);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(blocked);
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(blocked);

    expect(guideSeen()).toBe(true);
    expect(() => markGuideSeen()).not.toThrow();
    expect(() => forgetGuideSeen()).not.toThrow();
    expect(signedInBefore()).toBe(false);
    expect(guideShouldShowHere("/en")).toBe(false);
  });
});

describe("the returning wallet rule", () => {
  it("reads the same key the wallet writes", () => {
    const source = readFileSync("components/providers/WalletProvider.tsx", "utf8");
    expect(source).toContain(`RETURNING_KEY = "${RETURNING_KEY}"`);
  });

  it("holds a device back once it has signed in here", () => {
    window.localStorage.setItem(RETURNING_KEY, "1");
    expect(signedInBefore()).toBe(true);
    expect(guideShouldShowHere("/en")).toBe(false);
  });

  it("lets a device that has never signed in through", () => {
    expect(guideShouldShowHere("/en")).toBe(true);
  });
});

describe("where the guide may appear", () => {
  const fresh = { seen: false, returning: false, path: "/en" };

  it("appears on a real page for a new device", () => {
    expect(guideShouldShow(fresh)).toBe(true);
    expect(guideShouldShow({ ...fresh, path: "/ta/explore" })).toBe(true);
  });

  it("never appears twice", () => {
    expect(guideShouldShow({ ...fresh, seen: true })).toBe(false);
  });

  it("never appears on a bench page", () => {
    expect(onLabPage("/en/lab")).toBe(true);
    expect(onLabPage("/en/lab/guide")).toBe(true);
    expect(onLabPage("/en/collaborate")).toBe(false);
    expect(guideShouldShow({ ...fresh, path: "/en/lab/guide" })).toBe(false);
  });
});

describe("the three steps", () => {
  it("run check, make, find, in that order", () => {
    expect(guideSteps.map((step) => step.id)).toEqual(["check", "make", "find"]);
    expect(guideSteps.map((step) => step.href)).toEqual(["/verify", "/studio", "/mine"]);
    expect(guideSteps.map((step) => step.number)).toEqual(["01", "02", "03"]);
  });

  it("walks forward and stops at the last one", () => {
    expect(nextStep(0)).toBe(1);
    expect(nextStep(1)).toBe(2);
    expect(nextStep(2)).toBeNull();
  });

  it("says one plain line and names one real route for each step", () => {
    for (const step of guideSteps) {
      expect(step.line.length).toBeLessThan(140);
      expect(step.line.endsWith(".")).toBe(true);
      expect(step.href.startsWith("/")).toBe(true);
      expect(step.anchor).not.toBe("");
      expect(step.action).not.toBe("");
    }
  });
});
