"use client";

import { useTranslations } from "next-intl";
import { useHeadingLeading } from "./leading";

const POINTS = ["wallet", "passkey", "gas"] as const;

/**
 * The first screen anyone lands on. It says what signing in actually does,
 * because "connect wallet" is the step most people bounce off, and here there
 * is no wallet to connect: an account is made for them.
 *
 * It is also the card the page paints while the wallet is on its way, so it
 * enters with the CSS rise rather than a motion component: the served HTML then
 * carries it visible, and a phone paints it before any script has run.
 */
export function SignedOut({ onSignIn }: { onSignIn: () => void }) {
  const t = useTranslations("studio");
  const leading = useHeadingLeading("leading-[1.15]", "leading-[1.35]");

  return (
    <section data-signed-out className="rise relative border border-line bg-bg-raised p-7 sm:p-10">
      <p className="flex items-center gap-3 font-mono text-[11px] uppercase tracking-[0.24em] text-accent">
        <span className="motif h-[9px] w-[9px]" />
        {t("signedOut.kicker")}
      </p>

      {/* The page's own title above is the one heading that shouts, so the
          card's is a card's: the same words, in sentence case, at a size that
          holds them to two lines. */}
      <h2
        data-card-heading="card"
        className={`mt-4 max-w-[30ch] font-display text-[clamp(1.25rem,2vw,1.6rem)] font-semibold tracking-[-0.02em] ${leading}`}
      >
        {t("signedOut.heading")}
      </h2>
      {/* The one thing this page exists for, and it used to sit under four
          explanations where nobody ever saw it: the launch audit found no
          control of any kind in the first screen at 1440x900, on the page whose
          whole job is to get a sign in. It follows the headline, the sentence
          under it says what pressing it costs, and the rest of the card is what
          a creator gets once they have. */}
      <div className="rise mt-7 flex flex-wrap items-center gap-x-6 gap-y-3" style={{ animationDelay: "120ms" }}>
        <button
          type="button"
          onClick={onSignIn}
          className="rounded-[8px] bg-accent px-7 py-4 text-sm font-semibold uppercase tracking-[0.14em] text-accent-ink transition-transform duration-200 hover:-translate-y-0.5"
        >
          {t("signedOut.button")}
        </button>
        <p className="max-w-[30ch] text-base leading-relaxed text-text-faint">{t("signedOut.methods")}</p>
      </div>

      <p className="mt-7 max-w-[54ch] text-base leading-relaxed text-text-muted">{t("signedOut.body")}</p>

      <ul className="mt-10 grid gap-y-7 border-t border-line pt-7 sm:grid-cols-3">
        {POINTS.map((point, index) => (
          <li
            key={point}
            style={{ animationDelay: `${150 + index * 80}ms` }}
            className={`rise sm:px-6 sm:first:ps-0 ${index === POINTS.length - 1 ? "sm:pe-0" : ""} ${
              index === 0 ? "" : "sm:border-s sm:border-line"
            }`}
          >
            <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-text-faint">
              {t(`signedOut.points.${point}.label`)}
            </p>
            <p className="mt-2 text-base leading-relaxed text-text">{t(`signedOut.points.${point}.body`)}</p>
          </li>
        ))}

        {/* The fourth thing a creator gets is the one nothing else on the web
            offers them, and it is a sentence rather than a phrase, so it takes
            the full width under the other three instead of squeezing them. */}
        <li
          style={{ animationDelay: "390ms" }}
          className="rise sm:col-span-3 sm:border-t sm:border-line sm:pt-7"
        >
          <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-accent">
            {t("signedOut.points.consent.label")}
          </p>
          <p className="mt-2 max-w-[68ch] text-base leading-relaxed text-text">{t("signedOut.points.consent.body")}</p>
        </li>
      </ul>
    </section>
  );
}
