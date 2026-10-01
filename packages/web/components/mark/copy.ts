import { getFormatter, getTranslations } from "next-intl/server";
import type { MarkState } from "./mark";
import type { OtherPassport, PassportMarkFacts } from "./read";
import { MARK_TONES, type MarkTone } from "./tones";

/** A link inside a block: where it goes and what it says. */
export interface MarkLink {
  href: string;
  label: string;
}

/** Every word the mark, the look-alike block and the later line draw, in the reader's language. */
export interface MarkCopy {
  state: MarkState | "unread";
  tone: MarkTone;
  label: string;
  /** The mark's word, or null when the mark could not be read. */
  word: string | null;
  line: string;
  link: MarkLink | null;
  lookalike:
    | { kind: "found" | "searching"; tone: "amber" | "quiet"; heading: string; line: string; order: string | null; link: MarkLink }
    | { kind: "none"; line: string }
    | null;
  /** The quiet line on an earlier passport. The line itself links to the later one. */
  later: { line: string; count: string | null; href: string } | null;
}

/**
 * The words for one passport's facts. Kept apart from the drawing so a test
 * and the screenshot fixtures can feed in any state.
 */
export async function markCopy(facts: PassportMarkFacts, locale: string): Promise<MarkCopy> {
  // The request's own language, which the page has already set.
  const t = await getTranslations();
  const format = await getFormatter({ locale });
  const day = (seconds: number): string => format.dateTime(new Date(seconds * 1000), { dateStyle: "medium" });
  const titleOf = (other: OtherPassport | null): string => other?.title ?? t("passport.untitled");
  const open = (other: OtherPassport): MarkLink => ({ href: `/passport/${other.id}`, label: t("mark.openEarlier") });

  const { mark } = facts;
  const state = mark.state;
  let line: string;
  let link: MarkLink | null = null;
  switch (mark.state) {
    case "unread":
      line = t("mark.unread");
      break;
    case "mismatch":
      // A verdict on chain carries only the look fingerprint's distance, so a
      // miss with that one inside the shared limit can only be the layout
      // fingerprint's, and its line names no number for it.
      line = mark.secondPrint ? t("mark.secondPrint") : t("mark.states.mismatch.line");
      break;
    case "lookalike":
      line = t("mark.states.lookalike.line", {
        title: titleOf(facts.earlier),
        date: facts.earlier === null ? "" : day(facts.earlier.registeredAt),
      });
      // The look-alike block beside the mark carries the same link, so it is offered once.
      link = facts.earlier === null || facts.lookalike.kind === "found" ? null : open(facts.earlier);
      break;
    case "challenged":
      line =
        facts.challenge === null
          ? t("mark.states.challenged.word")
          : t("mark.states.challenged.line", { bond: facts.challenge.bond, date: day(facts.challenge.answerBy) });
      break;
    case "waiting":
      line = t("mark.states.waiting.line", { when: format.dateTime(new Date(facts.registeredAt * 1000), "moment") });
      break;
    case "checked":
      line = t("mark.states.checked.line", { bits: mark.verdict.phashBits, date: day(mark.verdict.at) });
      break;
    default:
      line = t(`mark.states.${mark.state}.line`);
  }

  const view = facts.lookalike;
  let lookalike: MarkCopy["lookalike"] = null;
  if (view.kind === "found") {
    lookalike = {
      kind: "found",
      tone: "amber",
      heading: t("lookalike.found.heading"),
      line: view.sealed
        ? t("lookalike.sealed")
        : t("lookalike.found.line", {
            title: titleOf(view.earlier),
            date: day(view.earlier.registeredAt),
            bits: view.bits,
            at: day(view.at),
          }),
      order: t("lookalike.order"),
      link: open(view.earlier),
    };
  } else if (view.kind === "searching") {
    lookalike = {
      kind: "searching",
      tone: "quiet",
      heading: t("lookalike.searching.heading"),
      line: t("lookalike.searching.line", { title: titleOf(view.earlier), date: day(view.earlier.registeredAt) }),
      order: null,
      link: open(view.earlier),
    };
  } else if (view.kind === "none") {
    lookalike = { kind: "none", line: t("lookalike.none") };
  }

  const first = facts.later.first;
  const later =
    first === null
      ? null
      : {
          line: t("lookalike.later.line", { title: titleOf(first), date: day(first.registeredAt) }),
          count: facts.later.count > 1 ? t("lookalike.later.count", { count: facts.later.count }) : null,
          href: `/passport/${first.id}`,
        };

  return {
    state,
    tone: MARK_TONES[state],
    label: t("mark.label"),
    word: state === "unread" ? null : t(`mark.states.${state}.word`),
    line,
    link,
    lookalike,
    later,
  };
}
