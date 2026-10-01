"use client";

import { AnimatePresence, motion } from "framer-motion";
import { useTranslations } from "next-intl";
import type { KeyboardEvent } from "react";
import { LeadTile, Tile } from "./Tiles";
import { MENU, SIDES, type ItemKey, type Side } from "./menu";

export const EASE = [0.16, 1, 0.3, 1] as const;

/**
 * The wide panel under the whole bar, its side's pages laid out as tiles. The
 * first tile leads, twice as tall; on the business side that is the business
 * page.
 *
 * The panel opens as a curtain drawn down from the bar, and the tiles rise in
 * after it one by one. Switching sides while it is open slides the old side
 * out towards where its trigger sits and the new one in from its own.
 */
export function MenuPanel({
  open,
  currentKey,
  reduced,
  panelProps,
  onChoose,
}: {
  open: Side | null;
  currentKey: ItemKey | null;
  reduced: boolean;
  panelProps: { onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void };
  onChoose: () => void;
}) {
  return (
    <AnimatePresence initial={false}>
      {/* The page under the panel steps back, so the eye goes to the tiles.
          It takes no presses: a press on it is an outside press and closes. */}
      {open !== null ? (
        <motion.div
          key="dim"
          aria-hidden
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: reduced ? 0.12 : 0.3 }}
          className="pointer-events-none absolute inset-x-0 top-[calc(100%+1px)] z-20 h-[100dvh] bg-bg/55"
        />
      ) : null}
      {open !== null ? (
        <motion.div
          key="panel"
          {...panelProps}
          id={`menu-${open}`}
          data-menu-panel={open}
          data-lenis-prevent
          initial={reduced ? { opacity: 0 } : { clipPath: "inset(0 0 100% 0)" }}
          animate={reduced ? { opacity: 1 } : { clipPath: "inset(0 0 0% 0)" }}
          exit={reduced ? { opacity: 0 } : { clipPath: "inset(0 0 100% 0)" }}
          transition={{ duration: reduced ? 0.15 : 0.42, ease: EASE }}
          className="grain absolute inset-x-0 top-[calc(100%+1px)] z-30 max-h-[calc(100dvh-64px)] overflow-y-auto overscroll-contain border-b border-line-strong bg-bg text-text shadow-[0_40px_80px_-40px_rgba(0,0,0,0.55)]"
        >
          <div className="mx-auto w-full max-w-[1400px] overflow-hidden px-8 py-9">
            <AnimatePresence mode="popLayout" initial={false}>
              <SideTiles key={open} side={open} currentKey={currentKey} reduced={reduced} onChoose={onChoose} />
            </AnimatePresence>
          </div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

function SideTiles({
  side,
  currentKey,
  reduced,
  onChoose,
}: {
  side: Side;
  currentKey: ItemKey | null;
  reduced: boolean;
  onChoose: () => void;
}) {
  const t = useTranslations("menu");
  const items = MENU[side];
  const index = SIDES.indexOf(side);
  // The personal side slides in from the left, where its trigger sits; the
  // business side from the right.
  const from = index === 0 ? -40 : 40;
  const cols =
    items.length > 5
      ? "lg:grid-cols-[1.25fr_1fr_1fr_1fr]"
      : "lg:grid-cols-[1.25fr_1fr_1fr]";

  return (
    <motion.div
      data-menu-side={side}
      initial={reduced ? { opacity: 0 } : { opacity: 0, x: from }}
      animate={{ opacity: 1, x: 0 }}
      exit={reduced ? { opacity: 0 } : { opacity: 0, x: -from }}
      transition={{ duration: reduced ? 0.12 : 0.32, ease: EASE }}
      className="grid gap-8 lg:grid-cols-[13rem_minmax(0,1fr)] lg:gap-10"
    >
      <div className="flex items-end justify-between gap-6 border-line lg:flex-col lg:items-stretch lg:border-r lg:pr-8">
        <div>
          <p className="flex items-center gap-2.5 font-mono text-[11px] uppercase tracking-[0.24em] text-text-faint">
            <span aria-hidden className="motif h-[9px] w-[9px]" />
            {`0${index + 1} / 0${SIDES.length}`}
          </p>
          <p className="mt-4 font-display text-[clamp(2.5rem,3.6vw,3.6rem)] font-semibold leading-[0.9] tracking-[-0.035em] text-text">
            {t(`sides.${side}`)}
          </p>
        </div>
        <p className="font-mono text-[11px] uppercase leading-relaxed tracking-[0.18em] text-text-faint">
          {t("arrows")}
          <br />
          {t("escape")}
        </p>
      </div>
      <ul className={`grid grid-cols-3 gap-3 lg:grid-rows-2 ${cols}`}>
        {items.map((item, at) => (
          <motion.li
            key={item.key}
            initial={reduced ? false : { opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, ease: EASE, delay: reduced ? 0 : 0.08 + at * 0.035 }}
            className={at === 0 ? "col-span-3 lg:col-span-1 lg:row-span-2 [&_a]:max-lg:min-h-[11rem]" : ""}
          >
            {at === 0 ? (
              <LeadTile item={item} current={item.key === currentKey} onChoose={onChoose} />
            ) : (
              <Tile item={item} current={item.key === currentKey} onChoose={onChoose} />
            )}
          </motion.li>
        ))}
      </ul>
    </motion.div>
  );
}
