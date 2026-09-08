"use client";

import { useTranslations } from "next-intl";
import { useEffect, useRef } from "react";
import { beat, forwardTouchMove, forwardTouchStart, forwardWheel } from "@/components/story/signals";
import type { StoryData } from "@/components/story/data";
import { CHAIN_ID } from "@/lib/chain/client";
import { Link } from "@/lib/i18n/routing";

/**
 * The last screen: what this is, where to go, and how much of it is real.
 *
 * The two figures are the registry's own totals through the live index, so the
 * page never claims a number nobody wrote on chain. It fades in over the
 * settling field and takes itself out of the tab order until it is there.
 */
export function CloseCard({ data, pinned = true }: { data: StoryData; pinned?: boolean }) {
  const t = useTranslations("story.close");
  const shell = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!pinned) {
      return;
    }
    let frame = 0;
    let hidden: boolean | null = null;

    const loop = () => {
      const node = shell.current;
      if (node !== null) {
        node.style.opacity = String(beat.close);
        const next = beat.close <= 0.5;
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
    { key: "chain", value: CHAIN_ID.toString(), label: t("chain") },
  ];

  return (
    <div
      ref={shell}
      inert={pinned ? true : undefined}
      aria-hidden={pinned ? "true" : undefined}
      style={pinned ? { opacity: 0 } : undefined}
      className={
        pinned ? "pointer-events-none absolute inset-0 z-30 flex items-center px-5 opacity-0 sm:px-8 lg:px-14" : ""
      }
    >
      <div
        onWheel={pinned ? forwardWheel : undefined}
        onTouchStart={pinned ? forwardTouchStart : undefined}
        onTouchMove={pinned ? forwardTouchMove : undefined}
        className={`mx-auto w-full max-w-[100rem] ${pinned ? "pointer-events-auto" : ""}`}
      >
        <p className="flex items-center gap-3 font-mono text-[11px] uppercase tracking-[0.24em] text-accent">
          <span className="motif h-[9px] w-[9px]" />
          {t("kicker")}
        </p>

        <h2 className="mt-5 max-w-[14ch] font-display text-[clamp(2.4rem,7vw,6rem)] font-semibold uppercase leading-[0.9] tracking-[-0.05em]">
          {t("title")}
        </h2>

        <p className="mt-5 max-w-[42ch] text-base leading-relaxed text-text-muted">{t("body")}</p>

        <div className="mt-8 flex flex-wrap gap-3">
          <Link
            href="/studio"
            className="group inline-flex items-center gap-2 rounded-[8px] bg-accent px-6 py-3.5 text-[11px] font-semibold uppercase tracking-[0.18em] text-accent-ink transition-transform duration-200 hover:scale-[1.03]"
          >
            {t("register")}
            <span aria-hidden className="transition-transform duration-200 group-hover:translate-x-1">
              &rarr;
            </span>
          </Link>
          <Link
            href="/verify"
            className="rounded-[8px] border border-line px-6 py-3.5 text-[11px] uppercase tracking-[0.18em] text-text-muted transition-colors duration-200 hover:border-accent hover:text-accent"
          >
            {t("verify")}
          </Link>
        </div>

        <dl className="mt-10 flex flex-wrap gap-x-12 gap-y-6 border-t border-line pt-6">
          {figures.map((figure) => (
            <div key={figure.key}>
              <dt className="font-mono text-[11px] uppercase tracking-[0.16em] text-text-faint">{figure.label}</dt>
              <dd className="mt-1 font-display text-[clamp(1.8rem,3.4vw,2.8rem)] font-semibold leading-[0.9] tracking-[-0.045em] tabular-nums">
                {figure.value}
              </dd>
            </div>
          ))}
        </dl>

        {data.error !== null && <p className="mt-6 max-w-[52ch] text-sm text-failed">{t("error", { reason: data.error })}</p>}
      </div>
    </div>
  );
}
