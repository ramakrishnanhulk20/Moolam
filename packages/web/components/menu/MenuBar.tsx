"use client";

import { motion } from "framer-motion";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { useIsReducedMotion } from "@/components/motion/useIsReducedMotion";
import { usePathname } from "@/lib/i18n/routing";
import { Chevron } from "./marks";
import { CLOSED, SIDES, currentItem, type MenuState, type Side } from "./menu";
import { MenuPanel } from "./MenuPanel";
import { useLandOnHash, useMenu } from "./useMenu";

/**
 * The first-visit guide's names on the laptop bar. Verify and the studio both
 * live under For personal, so the guide's first two steps light that side:
 * the button carries one name and the box around it, which is the same size,
 * the other. My pictures has its own corner on the right.
 */
const GUIDE: Partial<Record<Side, { trigger: string; around: string }>> = {
  personal: { trigger: "verify", around: "studio" },
};

/**
 * The laptop bar: the wordmark, For personal and For business beside it, the
 * tagline, then the account and the two chips on the right. A side opens into
 * a wide panel of tiles under the whole bar.
 *
 * The wordmark and the right-hand corner are drawn by the layout and handed
 * in, so the server keeps the lockup's image rules and the chips stay where
 * the rest of the site expects them.
 */
export function MenuBar({
  home,
  tagline,
  right,
  at,
  initial = CLOSED,
}: {
  home: ReactNode;
  tagline: string;
  right: ReactNode;
  /** The route to mark, for a test drawing a page it is not standing on; the real route otherwise. */
  at?: string;
  initial?: MenuState;
}) {
  const t = useTranslations("menu");
  const here = usePathname();
  const reduced = useIsReducedMotion();
  const { state, dispatch, triggerProps, rootProps, panelProps } = useMenu(initial);
  const current = currentItem(at ?? here);
  // Drawn once on every page, at every width, so the landing lives here.
  useLandOnHash();

  return (
    <div {...rootProps} data-menu-bar className="relative">
      {/* 62 px and the header's one pixel rule make the 63 px --header-h in
          globals.css says a laptop header is. The film pulls itself up by
          exactly that number, so the two must stay equal at every width. */}
      <div className="mx-auto flex h-[62px] w-full max-w-[1400px] items-center gap-x-5 px-5 sm:px-8 xl:gap-x-8">
        {home}

        <nav aria-label={t("label")} className="flex shrink-0 items-center gap-1">
          {SIDES.map((side) => {
            const open = state.open === side;
            const holdsCurrent = current?.side === side;
            const guide = GUIDE[side];
            return (
              <div key={side} className="relative" data-guide-anchor={guide?.around}>
                <button
                  {...triggerProps(side)}
                  data-menu-trigger={side}
                  data-guide-anchor={guide?.trigger}
                  data-holds-current={holdsCurrent ? "true" : undefined}
                  className={`tap relative flex items-center gap-2 whitespace-nowrap rounded-[8px] px-3.5 py-2 text-sm font-medium outline-none transition-colors duration-200 hover:text-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${
                    open ? "bg-bg-raised text-text" : holdsCurrent ? "text-accent" : "text-text-muted"
                  }`}
                >
                  {t(`sides.${side}`)}
                  <Chevron open={open} />
                  {holdsCurrent ? <Lit reduced={reduced} /> : null}
                </button>
              </div>
            );
          })}
        </nav>

        {/* The tagline takes only the room the rest leaves, and steps out of
            the way when that is too little, rather than pushing the corner to
            a second row. The empty first item is what lets it drop: a tagline
            wider than its box wraps to the second line of this one-line box,
            which is clipped. */}
        <span className="hidden h-[1lh] min-w-0 grow basis-0 flex-wrap overflow-hidden text-xs uppercase tracking-[0.24em] text-text-faint lg:flex">
          <span aria-hidden className="h-[1lh] w-0" />
          <span className="whitespace-nowrap">{tagline}</span>
        </span>

        <div className="ml-auto flex shrink-0 items-center lg:ml-0">{right}</div>
      </div>
      <MenuPanel
        open={state.open}
        currentKey={current?.key ?? null}
        reduced={reduced}
        panelProps={panelProps}
        onChoose={() => dispatch({ type: "chosen" })}
      />
    </div>
  );
}

/** The short accent rule under the side that holds the page being read, the phone bar's mark laid on its side. */
function Lit({ reduced }: { reduced: boolean }) {
  const className = "pointer-events-none absolute -bottom-1 left-3.5 h-[2px] w-4 bg-accent";
  if (reduced) {
    return <span aria-hidden className={className} />;
  }
  return (
    <motion.span
      layoutId="menu-lit"
      aria-hidden
      className={className}
      transition={{ type: "spring", stiffness: 420, damping: 34 }}
    />
  );
}
