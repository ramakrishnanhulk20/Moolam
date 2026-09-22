/**
 * The three things a first-time visitor can do here, in the order they make
 * sense: check something, make something, come back to it.
 *
 * Only the facts live here: which step, where it goes, what it points at and
 * which drawing it carries. Every word the guide says comes from the message
 * files through `useTranslations("guide")`, so all ten languages get the guide
 * rather than ten copies of the English one.
 */

/** Which mark is drawn beside a step. One per step, hand-made, no icon pack. */
export type GuideMark = "check" | "make" | "find";

export type GuideStepId = "check" | "make" | "find";

export interface GuideStep {
  /** Stable name. It is the message key, the React key and the anchor's value. */
  id: GuideStepId;
  /** Where the step's own link goes, as a locale-relative path. */
  href: string;
  /**
   * The value of `data-guide-anchor` on the real thing this step talks about:
   * the header's link on a laptop, the bottom bar's tab on a phone. The walk
   * lights the first one of those that is actually on the screen, and says so
   * plainly when neither is.
   */
  anchor: string;
  mark: GuideMark;
}

export const guideSteps: GuideStep[] = [
  { id: "check", href: "/verify", anchor: "verify", mark: "check" },
  { id: "make", href: "/studio", anchor: "studio", mark: "make" },
  { id: "find", href: "/mine", anchor: "mine", mark: "find" },
];

/** The step after this one, or null at the end of the walk. */
export function nextStep(index: number): number | null {
  return index + 1 < guideSteps.length ? index + 1 : null;
}

/** What a step says, in the order a card reads it out. */
export const STEP_PARTS = ["title", "line", "action", "elsewhere"] as const;

/** The guide's own words, the ones that are not about any one step. */
export const GUIDE_PARTS = ["dialog", "step", "next", "done", "skip", "again"] as const;

/**
 * Every message key the guide needs, in full.
 *
 * One list, so the components, the tests and the count script that checks all
 * ten language files are reading the same thing and a key cannot be added in
 * one place and forgotten in another.
 */
export function guideKeys(): string[] {
  return [
    ...GUIDE_PARTS.map((part) => `guide.${part}`),
    ...guideSteps.flatMap((step) => STEP_PARTS.map((part) => `guide.steps.${step.id}.${part}`)),
  ];
}
