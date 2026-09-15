"use client";

import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
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
 */
export function CloseCard({ data, pinned = true }: { data: StoryData; pinned?: boolean }) {
  const t = useTranslations("story.close");
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
        const next = progress.close <= 0.5;
        if (next !== hidden) {
          hidden = next;
          node.inert = next;
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
    return () => cancelAnimationFrame(frame);
  }, [pinned]);

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
      {/* The film wrapper carries every gesture over the pinned screen back to
          the story's scroller, this card included. */}
      <div
        className={`mx-auto w-full max-w-[100rem] ${pinned ? "pointer-events-auto" : ""}`}
      >
        <p className="flex items-center gap-3 font-mono text-[11px] uppercase tracking-[0.24em] text-accent">
          <span className="motif h-[9px] w-[9px]" />
          {t("kicker")}
        </p>

        <h2 className="mt-2 max-w-[20ch] font-display text-[clamp(2rem,7vw,6rem)] font-semibold uppercase leading-[0.9] tracking-[-0.05em] sm:mt-5 sm:max-w-[14ch]">
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
          <Link
            href="/studio"
            className="group inline-flex items-center gap-2 rounded-[8px] bg-accent px-2 py-2.5 text-[10px] font-semibold uppercase tracking-[0.06em] text-accent-ink transition-transform duration-200 hover:scale-[1.03] sm:px-6 sm:py-3.5 sm:text-[11px] sm:tracking-[0.18em]"
          >
            {t("register")}
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

        {/* A phone has the lower half of the window for the whole card, so the
            room the third figure used to take is given back to the line under
            the row rather than added to it. */}
        <dl className="mt-1.5 grid grid-cols-2 gap-x-4 border-t border-line pt-1.5 sm:mt-10 sm:flex sm:flex-wrap sm:gap-x-12 sm:gap-y-6 sm:pt-6">
          {figures.map((figure) => (
            <div key={figure.key}>
              <dt className="font-mono text-[9px] uppercase leading-[1.3] tracking-[0.12em] text-text-faint sm:text-[11px] sm:tracking-[0.16em]">
                {figure.label}
              </dt>
              <dd className="mt-1 font-display text-[clamp(1.4rem,3.4vw,2.8rem)] font-semibold leading-[0.9] tracking-[-0.045em] tabular-nums">
                {figure.value}
              </dd>
            </div>
          ))}
        </dl>

        {/* Where the two counts were written. It sat in the row as a third
            figure, where a chain id read as a count of something. */}
        <p className="mt-1 font-mono text-[9px] uppercase leading-[1.3] tracking-[0.12em] text-text-faint sm:mt-4 sm:text-[11px] sm:tracking-[0.16em]">
          {t("chain", { chainId: CHAIN_ID })}
        </p>

        {data.error !== null && <p className="mt-6 max-w-[52ch] text-sm text-failed">{t("error", { reason: data.error })}</p>}
      </div>
    </div>
  );
}
