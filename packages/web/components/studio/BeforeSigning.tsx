"use client";

import { motion } from "framer-motion";
import { useFormatter, useTranslations } from "next-intl";
import type { Hex } from "viem";
import { useIsReducedMotion } from "@/components/motion/useIsReducedMotion";
import { Link } from "@/lib/i18n/routing";
import type { RegisterState } from "@/lib/studio/flow";
import { earlierPassport, seenOnline, type EarlierPassport, type SeenOnline } from "@/lib/studio/warning";
import { SwornLine } from "./SwornLine";

/**
 * The look-alike amber Ram picked for the mark on 1 October 2026, light and
 * dark. The pre-sign warning is the same news a passport page will carry, so it
 * wears the same colour rather than the accent or the failure red.
 */
const AMBER = "text-[#875400] dark:text-[#f2a93b]";
const AMBER_RULE = "border-[#875400] dark:border-[#f2a93b]";

const EASE = [0.16, 1, 0.3, 1] as const;

/**
 * What the prepare answer found, drawn where the creator is about to press
 * (L19, L20, L23).
 *
 * With `review` the run is paused on it: the sentence they sign under and the
 * two ways on sit under the findings, so the passkey opens only after they
 * have read them. Without it, "none" and "could not check" are one line at the
 * head of the run, drawn a frame before the passkey and kept through the send.
 *
 * Everything a stranger wrote arrives as text: the earlier passport's title is
 * one printable line, its id a link only by the passport id pattern, and the
 * web pages are addresses to read, never links to follow.
 */
export function BeforeSigning({
  state,
  pressing = false,
  onSign,
  onChooseAnother,
}: {
  state: RegisterState;
  pressing?: boolean;
  onSign: () => void;
  onChooseAnother: () => void;
}) {
  const t = useTranslations("studio");
  const reduced = useIsReducedMotion();
  const earlier = earlierPassport(state);
  const web = seenOnline(state);
  if (earlier === null) {
    return null;
  }

  const rise = (index: number) =>
    reduced
      ? { initial: false as const, animate: { opacity: 1, y: 0 }, transition: { duration: 0 } }
      : {
          initial: { opacity: 0, y: 24 },
          animate: { opacity: 1, y: 0 },
          transition: { duration: 0.6, ease: EASE, delay: 0.08 * index },
        };

  const warns = earlier.state === "found" || web !== null;
  const review = state.review;

  return (
    <section
      data-before-signing
      data-lookalike={earlier.state}
      data-web-check={web === null ? "none" : "found"}
      data-review={review ? "" : undefined}
      aria-live="polite"
      className={`relative mb-7 border-s-2 ps-5 sm:ps-6 ${warns ? AMBER_RULE : "border-line-strong"}`}
    >
      <motion.p
        {...rise(0)}
        className={`flex items-center gap-3 font-mono text-[11px] uppercase tracking-[0.24em] ${warns ? AMBER : "text-text-muted"}`}
      >
        {/* A caution, not a stop: the run can go on, so the failure octagon stays out of it. */}
        <span aria-hidden className={`h-[9px] w-[9px] shrink-0 ${warns ? "bg-current" : "border border-current"}`} />
        {t("lookalike.kicker")}
      </motion.p>

      <motion.div {...rise(1)}>
        <Earlier earlier={earlier} />
      </motion.div>

      {web === null ? null : (
        <motion.div {...rise(2)} className="mt-7 border-t border-line pt-6">
          <OnTheWeb web={web} />
        </motion.div>
      )}

      {review ? (
        <motion.div {...rise(3)} className="mt-8 border-t border-line pt-6">
          <SwornLine />
          <div className="mt-6 flex flex-wrap items-center gap-x-5 gap-y-3">
            <button
              type="button"
              data-press
              data-press-sign
              onClick={onSign}
              disabled={pressing}
              className="flex min-h-[4.5rem] w-full items-center justify-center rounded-[8px] bg-accent px-7 py-4 text-center text-sm font-semibold uppercase tracking-[0.14em] text-accent-ink transition-transform duration-200 hover:-translate-y-0.5 disabled:translate-y-0 disabled:opacity-60 sm:inline-flex sm:min-h-0 sm:w-auto"
            >
              {pressing ? t("register.steps.sign.running") : t("register.steps.sign.waiting")}
            </button>
            <button
              type="button"
              data-choose-another
              onClick={onChooseAnother}
              disabled={pressing}
              className="rounded-[8px] border border-line px-5 py-3 text-[11px] uppercase tracking-[0.2em] text-text-muted transition-colors duration-200 hover:border-accent hover:text-accent disabled:opacity-60"
            >
              {t("register.replace")}
            </button>
          </div>
        </motion.div>
      ) : null}
    </section>
  );
}

/** The look-alike answer in words, one of four, never nothing. */
function Earlier({ earlier }: { earlier: EarlierPassport }) {
  const t = useTranslations("studio.lookalike");
  const format = useFormatter();

  switch (earlier.state) {
    case "found": {
      // A real title is quoted so it reads as a name inside the sentence; the untitled placeholder is not.
      const title = earlier.title === "" ? t("untitled") : `“${earlier.title}”`;
      const date = format.dateTime(new Date(earlier.registeredAt * 1_000), { year: "numeric", month: "short", day: "numeric" });
      return (
        <div data-earlier="found">
          <h3 className={`mt-4 max-w-[24ch] font-display text-[clamp(1.45rem,2.6vw,2.1rem)] font-semibold uppercase leading-[0.98] tracking-[-0.025em] ${AMBER}`}>
            {t("found.heading")}
          </h3>
          <p className="mt-4 max-w-[58ch] text-base leading-relaxed text-text">{t("found.line", { title, date })}</p>
          <p className="mt-3 max-w-[58ch] text-base leading-relaxed text-text-muted">{t("found.note")}</p>
          <OpenPassport id={earlier.passportId} />
        </div>
      );
    }
    case "yours":
      return (
        <div data-earlier="yours">
          <h3 className="mt-4 max-w-[24ch] font-display text-[clamp(1.45rem,2.6vw,2.1rem)] font-semibold uppercase leading-[0.98] tracking-[-0.025em] text-text">
            {t("yours.heading")}
          </h3>
          <p className="mt-4 max-w-[58ch] text-base leading-relaxed text-text-muted">{t("yours.line")}</p>
          <OpenPassport id={earlier.passportId} />
        </div>
      );
    case "none":
      return (
        <p data-earlier="none" className="mt-3 max-w-[58ch] text-base leading-relaxed text-text-muted">
          {t("none", { time: format.dateTime(new Date(earlier.indexAt * 1_000), "moment") })}
        </p>
      );
    case "unchecked":
      return (
        <p data-earlier="unchecked" className="mt-3 max-w-[58ch] text-base leading-relaxed text-text">
          {t("unchecked")}
        </p>
      );
  }
}

/**
 * The earlier passport, opened beside the run rather than in place of it: the
 * pinned files and the fields waiting to be signed live in this tab only.
 */
function OpenPassport({ id }: { id: Hex | null }) {
  const t = useTranslations("studio.lookalike");
  if (id === null) {
    return null;
  }
  return (
    <Link
      href={`/passport/${id}`}
      target="_blank"
      rel="noopener"
      data-open-earlier
      className="group mt-5 inline-flex items-center gap-2 text-sm text-text underline decoration-line-strong underline-offset-4 transition-colors duration-200 hover:text-accent hover:decoration-accent"
    >
      {t("open")}
      <span aria-hidden className="transition-transform duration-200 group-hover:translate-x-0.5">
        &rarr;
      </span>
    </Link>
  );
}

/** The pages Google named, as the creator is about to sign them: plain addresses, never links. */
function OnTheWeb({ web }: { web: SeenOnline }) {
  const t = useTranslations("studio.webCheck");
  return (
    <div data-seen-online>
      <h3 className={`font-display text-[clamp(1.25rem,2vw,1.6rem)] font-semibold uppercase leading-[1.02] tracking-[-0.02em] ${AMBER}`}>
        {t("found.heading")}
      </h3>
      <p className="mt-3 max-w-[58ch] text-base leading-relaxed text-text">{t("found.line", { count: web.count })}</p>
      <ol className="mt-4 space-y-2">
        {web.pages.map((page, index) => (
          <li key={`${index}-${page}`} data-web-page className="flex gap-3 font-mono text-[12px] leading-relaxed text-text-muted">
            <span aria-hidden className="shrink-0 tabular-nums text-text-faint">
              {String(index + 1).padStart(2, "0")}
            </span>
            <span className="min-w-0 break-all">{page}</span>
          </li>
        ))}
      </ol>
      {web.more > 0 ? (
        <p data-web-more className="mt-3 text-base leading-relaxed text-text-faint">
          {t("found.more", { count: web.more })}
        </p>
      ) : null}
    </div>
  );
}
