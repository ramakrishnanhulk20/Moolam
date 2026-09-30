import { describe, expect, it } from "vitest";
import { chosenTitle, defaultTitle as serverDefault } from "@/lib/server/title";
import { TITLE_MAX, defaultTitle, titleProblem } from "@/components/result/title-rule";

const CASES = [
  "",
  "   ",
  "a",
  "  a fox  ",
  "x".repeat(120),
  "x".repeat(121),
  `  ${"x".repeat(120)}  `,
  "a​b",
  "left‮right",
  "a\tb",
  "a\nb",
  "a b",
  "a b",
  "a b",
  "café",
  "\u{1F600}".repeat(60),
  "\u{1F600}".repeat(61),
  "",
  "͸",
  "\uD800",
  "\u0000",
  "­",
  "Kolam at dawn, 3 colours",
];

describe("the page's title rule agrees with the server's", () => {
  it("uses the same limit", () => {
    expect(TITLE_MAX).toBe(120);
  });

  for (const value of CASES) {
    it(`agrees on ${JSON.stringify(value).slice(0, 40)}`, () => {
      expect(titleProblem(value) === null).toBe(chosenTitle(value) !== null);
    });
  }

  const PROMPTS = [
    "A tiny fox librarian reading by candlelight",
    "  line one\nline two\t\ttabbed  ",
    "x".repeat(600),
    `${"y".repeat(119)}\u{1F600} and more`,
    "​​​",
    "a‮b",
    "   ",
  ];

  for (const prompt of PROMPTS) {
    it(`fills the same default title from ${JSON.stringify(prompt).slice(0, 40)}`, () => {
      expect(defaultTitle(prompt)).toBe(serverDefault(prompt));
      expect(chosenTitle(defaultTitle(prompt))).not.toBeNull();
    });
  }
});
