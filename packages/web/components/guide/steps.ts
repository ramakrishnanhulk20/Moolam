/**
 * The three things a first-time visitor can do here, in the order they make
 * sense: check something, make something, come back to it.
 *
 * Both drawings of the guide read this one list, so the words and the order
 * cannot drift apart between them. English only for now: the guide lives on the
 * bench, and the bench is not translated. When it rolls into the real screens
 * every string here becomes a key under `guide.*` in the ten message files.
 */

/** Which mark is drawn on a step's card. One per step, hand-made, no icon pack. */
export type GuideMark = "check" | "make" | "find";

export interface GuideStep {
  /** Stable name, used for keys and for the anchor the walk lights up. */
  id: "check" | "make" | "find";
  /** The figure in the corner of the card and in the walk's dot row. */
  number: string;
  title: string;
  /** One line of plain words. No jargon, no promise the product does not keep. */
  line: string;
  /** What the button says. */
  action: string;
  /** Where the button goes, as a locale-relative path. */
  href: string;
  /**
   * The value of `data-guide-anchor` on the real thing this step talks about.
   * The walk measures that element and cuts the spotlight over it. When the
   * page carries no such element the walk says so rather than pointing at
   * nothing: "My pictures" only appears for a device that has signed in before,
   * which a first-time visitor is not.
   */
  anchor: string;
  mark: GuideMark;
}

export const guideSteps: GuideStep[] = [
  {
    id: "check",
    number: "01",
    title: "Check any picture",
    line: "Drop in an image and Moolam says whether it holds a passport on Monad, and what its creator allowed.",
    action: "Check a picture",
    href: "/verify",
    anchor: "verify",
    mark: "check",
  },
  {
    id: "make",
    number: "02",
    title: "Make one and get its passport",
    line: "Register an image in the studio. Two signatures, about a second, and it carries a record nobody can quietly edit.",
    action: "Open the studio",
    href: "/studio",
    anchor: "studio",
    mark: "make",
  },
  {
    id: "find",
    number: "03",
    title: "Find yours",
    line: "Every picture you registered on this device, in one place, each with its passport and its history.",
    action: "My pictures",
    href: "/mine",
    anchor: "mine",
    mark: "find",
  },
];

/** The step after this one, or null at the end of the walk. */
export function nextStep(index: number): number | null {
  return index + 1 < guideSteps.length ? index + 1 : null;
}
