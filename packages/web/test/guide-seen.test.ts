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
  signedInBefore,
} from "@/components/guide/seen";
import { guideKeys, guideSteps, nextStep } from "@/components/guide/steps";

/**
 * The first-visit guide is the one thing on the site that is allowed to
 * interrupt somebody, so the rule that decides whether it appears is worth more
 * tests than the drawing it opens: once per device, never for a returning
 * wallet, and never a loop on a browser that keeps
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
    expect(guideShouldShowHere()).toBe(false);
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
    expect(guideShouldShowHere()).toBe(false);
  });

  it("lets a device that has never signed in through", () => {
    expect(guideShouldShowHere()).toBe(true);
  });
});

describe("where the guide may appear", () => {
  const fresh = { seen: false, returning: false };

  it("appears for a new device", () => {
    expect(guideShouldShow(fresh)).toBe(true);
  });

  it("never appears twice", () => {
    expect(guideShouldShow({ ...fresh, seen: true })).toBe(false);
  });
});

describe("the three steps", () => {
  it("run check, make, find, in that order", () => {
    expect(guideSteps.map((step) => step.id)).toEqual(["check", "make", "find"]);
    expect(guideSteps.map((step) => step.href)).toEqual(["/verify", "/studio", "/mine"]);
  });

  it("walks forward and stops at the last one", () => {
    expect(nextStep(0)).toBe(1);
    expect(nextStep(1)).toBe(2);
    expect(nextStep(2)).toBeNull();
  });

  it("carry facts only: where it goes, what it points at, which drawing", () => {
    for (const step of guideSteps) {
      expect(step.href.startsWith("/")).toBe(true);
      expect(step.anchor).toBe(step.id === "check" ? "verify" : step.id === "make" ? "studio" : "mine");
      expect(["check", "make", "find"]).toContain(step.mark);
      // Every word comes from the message files. A string left here would be
      // English on all ten languages and nobody would see it until it shipped.
      expect(Object.keys(step).sort()).toEqual(["anchor", "href", "id", "mark"]);
    }
  });

  it("name every key the ten message files owe the guide", () => {
    expect(guideKeys()).toEqual([
      "guide.dialog",
      "guide.step",
      "guide.next",
      "guide.done",
      "guide.skip",
      "guide.again",
      "guide.steps.check.title",
      "guide.steps.check.line",
      "guide.steps.check.action",
      "guide.steps.check.elsewhere",
      "guide.steps.make.title",
      "guide.steps.make.line",
      "guide.steps.make.action",
      "guide.steps.make.elsewhere",
      "guide.steps.find.title",
      "guide.steps.find.line",
      "guide.steps.find.action",
      "guide.steps.find.elsewhere",
    ]);
  });
});
