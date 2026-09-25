"use client";

import { useTranslations } from "next-intl";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { progress } from "@/components/story/signals";
import type { StoryData } from "@/components/story/data";
import { CHAIN_ID } from "@/lib/chain/client";
import { Link } from "@/lib/i18n/routing";

/**
 * The last screen: what this is, where to go, and how much of it is real.
 *
 * The two figures are the registry's own totals through the live index, so the
 * page never claims a number nobody wrote on chain. It fades in over the
 * settling field and takes itself out of the tab order until it is there. Under
 * the light theme the story-close rule in globals.css gives this card the app's
 * own palette and ground, so the film ends by handing the page back.
 *
 * In the chapter cut this is the page's one final call, so its first button is
 * named exactly as the first screen's, and on a laptop the two counts leave the
 * foot of the text for the card's empty right half, at display size.
 */
export function CloseCard({
  data,
  pinned = true,
  chapter = false,
}: {
  data: StoryData;
  pinned?: boolean;
  chapter?: boolean;
}) {
  const t = useTranslations("story.close");
  const first = useTranslations("home.first");
  const shell = useRef<HTMLDivElement>(null);
  const [wide, setWide] = useState(false);

  // From 640 px the card owns the whole window, header included, and the film
  // hands the scroll on at the end, which lifts it by the footer's height. The
  // top inset below is what keeps the headline clear of the bar after that lift,
  // and it only applies to the wide framing: on a phone the card already sits in
  // the lower half of the window.
  useEffect(() => {
    const query = window.matchMedia("(min-width: 640px)");
    const read = () => setWide(query.matches);
    read();
    query.addEventListener("change", read);
    return () => query.removeEventListener("change", read);
  }, []);

  useEffect(() => {
    if (!pinned) {
      return;
    }
    let frame = 0;
    let hidden: boolean | null = null;

    const loop = () => {
      const node = shell.current;
      if (node !== null) {
        node.style.opacity = String(progress.close);
        if (chapter) {
          // The counts rise into place on the same curve the card fades in on.
          node.style.setProperty("--close", String(progress.close));
        }
        const next = progress.close <= 0.5;
        if (next !== hidden) {
          hidden = next;
          node.inert = next;
          if (chapter) {
            // The chapter cut's header wears the film's dark look while the
            // film is in view and hands it back here, where the page's own
            // ground has arrived. The rule is CHAPTER_LOOK in LandingStory.tsx.
            if (next) {
              document.body.removeAttribute("data-chapter-close");
            } else {
              document.body.setAttribute("data-chapter-close", "true");
            }
          }
          if (next) {
            node.setAttribute("aria-hidden", "true");
          } else {
            node.removeAttribute("aria-hidden");
          }
        }
      }
      frame = requestAnimationFrame(loop);
    };

    frame = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(frame);
      document.body.removeAttribute("data-chapter-close");
    };
  }, [pinned, chapter]);

  const figures = [
    {
      key: "passports",
      value: data.passportCount === null ? t("unread") : data.passportCount.toString(),
      label: t("passports"),
    },
    {
      key: "attestations",
      value: data.attestationCount === null ? t("unread") : data.attestationCount.toString(),
      label: t("attestations"),
    },
  ];

  return (
    <div
      ref={shell}
      inert={pinned ? true : undefined}
      aria-hidden={pinned ? "true" : undefined}
      style={
        pinned
          ? {
              opacity: 0,
              // The bar's height twice: the stylesheet already holds one for the
              // bar itself, and the second is the room the card needs after the
              // film hands the scroll on. safe center keeps the card centred
              // while it fits and never lets it start above that inset.
              ...(wide ? { paddingTop: "calc(var(--header-h) * 2)", alignItems: "safe center" } : {}),
            }
          : undefined
      }
      className={pinned ? "story-close story-lower pointer-events-none z-30 px-5 opacity-0 sm:px-8 lg:px-14" : ""}
    >
      {/* On a phone the card takes the lower half of the window and the shot
          keeps the top, and the shot's foot is the fog's plain black. Against
          the light page's ground that read as a black band sitting on the card.
          In the chapter cut the ground reaches up into the shot instead, so the
          film's tail dissolves into the page. Under the dark theme the ground
          is the film's own black and this draws nothing anyone can see. */}
      {chapter && pinned && (
        <div
          aria-hidden
          data-close-fade
          className="pointer-events-none absolute inset-x-0 bottom-full h-[26svh] sm:hidden"
          style={{
            background:
              "linear-gradient(180deg, transparent 0%, color-mix(in srgb, var(--bg) 38%, transparent) 42%, color-mix(in srgb, var(--bg) 86%, transparent) 78%, var(--bg) 100%)",
          }}
        />
      )}
      {/* The film wrapper carries every gesture over the pinned screen back to
          the story's scroller, this card included. */}
      <div
        data-close-card={chapter ? "chapter" : undefined}
        className={`mx-auto w-full max-w-[100rem] ${pinned ? "pointer-events-auto" : ""}${chapter ? " lg:grid lg:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)] lg:items-center lg:gap-16" : ""}`}
      >
        <Half split={chapter}>
          <p className="flex items-center gap-3 font-mono text-[11px] uppercase tracking-[0.24em] text-accent">
            <span className="motif h-[9px] w-[9px]" />
            {t("kicker")}
          </p>

          <h2
            className={`mt-2 max-w-[20ch] font-display text-[clamp(2rem,7vw,6rem)] font-semibold uppercase leading-[0.9] tracking-[-0.05em] sm:mt-5 sm:max-w-[14ch]${chapter ? " lg:text-[clamp(3rem,5.2vw,5.6rem)]" : ""}`}
          >
            {t("title")}
          </h2>

          <p className="mt-2 text-sm leading-snug text-text-muted sm:mt-5 sm:max-w-[42ch] sm:text-base sm:leading-relaxed">
            {t("body")}
          </p>

          {/* A phone has the lower half of the window for all of this, so the two
              calls sit on one line there and grow back at 640 px. The padding and
              the letter-spacing are cut to the bone below 640 px because the
              longest labels on the site (Portuguese and Tamil) wrapped this row
              onto two lines, which pushed the card's last line off the fold. */}
          <div className="mt-3 flex flex-wrap gap-1.5 sm:mt-8 sm:gap-3">
            {/* The studio carries the wallet SDK. Left to prefetch, this card pulled about
                130 kB of it behind every reading of the film, so it loads on the tap. */}
            <Link
              href="/studio"
              prefetch={false}
              className="group inline-flex items-center gap-2 rounded-[8px] bg-accent px-2 py-2.5 text-[10px] font-semibold uppercase tracking-[0.06em] text-accent-ink transition-transform duration-200 hover:scale-[1.03] sm:px-6 sm:py-3.5 sm:text-[11px] sm:tracking-[0.18em]"
            >
              {chapter ? first("make") : t("register")}
              <span aria-hidden className="transition-transform duration-200 group-hover:translate-x-1">
                &rarr;
              </span>
            </Link>
            <Link
              href="/verify"
              className="rounded-[8px] border border-line px-2 py-2.5 text-[10px] uppercase tracking-[0.06em] text-text-muted transition-colors duration-200 hover:border-accent hover:text-accent sm:px-6 sm:py-3.5 sm:text-[11px] sm:tracking-[0.18em]"
            >
              {t("verify")}
            </Link>
          </div>
        </Half>

        <Half split={chapter} figures>
          {/* A phone has the lower half of the window for the whole card, so the
              room the third figure used to take is given back to the line under
              the row rather than added to it. */}
          <dl
            className={`mt-1.5 grid grid-cols-2 gap-x-4 border-t border-line pt-1.5 sm:mt-10 sm:flex sm:flex-wrap sm:gap-x-12 sm:gap-y-6 sm:pt-6${chapter ? " lg:mt-0 lg:flex-col lg:flex-nowrap lg:gap-y-10 lg:border-t-0 lg:pt-0" : ""}`}
          >
            {figures.map((figure) => (
              <div key={figure.key}>
                <dt
                  className={`font-mono text-[9px] uppercase leading-[1.3] tracking-[0.12em] text-text-faint sm:text-[11px] sm:tracking-[0.16em]${chapter ? " lg:flex lg:items-center lg:gap-3 lg:text-[12px] lg:tracking-[0.2em]" : ""}`}
                >
                  {chapter && (
                    // .motif sets its own display, so the phone's hiding is on a wrapper.
                    <span aria-hidden className="hidden lg:inline-flex">
                      <span className="motif h-[9px] w-[9px]" />
                    </span>
                  )}
                  {figure.label}
                </dt>
                <dd
                  className={`mt-1 font-display text-[clamp(1.4rem,3.4vw,2.8rem)] font-semibold leading-[0.9] tracking-[-0.045em] tabular-nums${chapter ? " lg:mt-3 lg:text-[clamp(5rem,9.5vw,10rem)] lg:leading-[0.82] lg:tracking-[-0.06em]" : ""}`}
                >
                  {figure.value}
                </dd>
              </div>
            ))}
          </dl>

          {/* Where the two counts were written. It sat in the row as a third
              figure, where a chain id read as a count of something.

              The way out to the evidence rides on this line rather than on the
              row of calls above it. At 375 px the two calls already fill that
              row: 330 of 335 px in Portuguese, 323 in Tamil, so a third item
              there wraps and pushes the card's last line towards the fold. This
              line is 141 px of 335 in the longest language, so the link fits
              beside it and every box above stays where it was. */}
          <p
            className={`mt-1 font-mono text-[9px] uppercase leading-[1.3] tracking-[0.12em] text-text-faint sm:mt-4 sm:text-[11px] sm:tracking-[0.16em]${chapter ? " lg:mt-10 lg:border-t lg:border-line lg:pt-5" : ""}`}
          >
            {t("chain", { chainId: CHAIN_ID })}
            <span aria-hidden className="px-2 opacity-50">
              &middot;
            </span>
            <Link href="/docs/proof" className="transition-colors duration-200 hover:text-accent focus-visible:text-accent">
              {t("proof")}
            </Link>
          </p>

          {data.error !== null && <p className="mt-6 max-w-[52ch] text-sm text-failed">{t("error", { reason: data.error })}</p>}
        </Half>
      </div>
    </div>
  );
}

/**
 * One half of the chapter cut's card on a laptop, and nothing at all otherwise:
 * the stated cut's card keeps exactly the markup it has always had.
 *
 * The figures half stands against a hairline of its own and rises the last
 * few pixels into place as the card fades in, read from the --close variable
 * the card's frame loop writes, so React never renders for it.
 */
function Half({ split, figures = false, children }: { split: boolean; figures?: boolean; children: ReactNode }) {
  if (!split) {
    return <>{children}</>;
  }
  if (!figures) {
    return <div data-close-half="text">{children}</div>;
  }
  return (
    <div
      data-close-half="figures"
      className="lg:border-s lg:border-line lg:ps-12 xl:ps-16"
      style={{ transform: "translate3d(0, calc((1 - var(--close, 1)) * 36px), 0)" }}
    >
      {children}
    </div>
  );
}
