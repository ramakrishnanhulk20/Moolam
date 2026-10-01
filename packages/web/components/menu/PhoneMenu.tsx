"use client";

import { AnimatePresence, motion } from "framer-motion";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useReducer, useRef, type ReactNode } from "react";
import { MenuTabContext, type MenuTabControl } from "@/components/shell/BottomBar";
import { BAR_AIR, BAR_ROOM, MAKE_RISE } from "@/components/shell/tabs";
import { useIsReducedMotion } from "@/components/motion/useIsReducedMotion";
import { usePathname } from "@/lib/i18n/routing";
import { LeadTile, Tile } from "./Tiles";
import { CLOSED, MENU, SIDES, currentItem, menuReducer, type ItemKey, type MenuState, type Side } from "./menu";
import { EASE } from "./MenuPanel";
import { stepLink } from "./useMenu";

/** The sheet's two side tabs stand clear of the raised Make disc, which overlaps the sheet's foot. */
const SIDES_FOOT = MAKE_RISE + BAR_AIR;

/**
 * The phone's menu: the Menu tab on the bottom bar, and the sheet that rises
 * out of the bar when it is pressed, For personal and For business as its tabs.
 *
 * The press rule decides the shape. The sheet grows upward from the bar, right
 * over the tab that was pressed, and opens on the side that holds the page
 * being read, so the answer starts at the thumb and the other side is one
 * reach away. Nothing floats over the page while it is shut. The tab bar
 * stays live under it: pressing a tab goes there and the new route closes the
 * sheet; pressing Menu again puts it away.
 *
 * The bar is handed in as children so the layout still draws it, and the
 * Menu tab inside it reads this sheet's state from MenuTabContext.
 */
export function PhoneMenu({ at, initial = CLOSED, children }: { at?: string; initial?: MenuState; children?: ReactNode }) {
  const t = useTranslations("menu");
  const [state, dispatch] = useReducer(menuReducer, initial);
  const here = usePathname();
  const reduced = useIsReducedMotion();
  const current = currentItem(at ?? here);
  const menuTab = useRef<HTMLButtonElement | null>(null);
  const tabs = useRef<Partial<Record<Side, HTMLButtonElement | null>>>({});
  const lastRoute = useRef(here);
  const open = state.open;
  const holdsSide = current?.side ?? null;
  const holdButton = useCallback((node: HTMLButtonElement | null) => {
    menuTab.current = node;
  }, []);

  const control = useMemo<MenuTabControl>(
    () => ({
      open: open !== null,
      holds: holdsSide !== null,
      onPress: () => dispatch(open !== null ? { type: "outside" } : { type: "press", side: holdsSide ?? SIDES[0] }),
      holdButton,
    }),
    [open, holdsSide, holdButton],
  );

  useEffect(() => {
    if (lastRoute.current !== here) {
      lastRoute.current = here;
      dispatch({ type: "route" });
    }
  }, [here]);

  const wasOpen = useRef<Side | null>(null);
  useEffect(() => {
    if (open !== null && wasOpen.current === null) {
      tabs.current[open]?.focus();
    }
    if (open === null && wasOpen.current !== null && document.activeElement === document.body) {
      menuTab.current?.focus();
    }
    wasOpen.current = open;
  }, [open]);

  useEffect(() => {
    if (open === null) {
      return;
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        dispatch({ type: "key", key: "Escape" });
        menuTab.current?.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  const sideTab = (side: Side) => {
    const chosen = open === side;
    const holdsCurrent = current?.side === side;
    return (
      <button
        key={side}
        ref={(node) => {
          tabs.current[side] = node;
        }}
        type="button"
        role="tab"
        aria-selected={chosen}
        aria-controls="menu-sheet-panel"
        data-sheet-side={side}
        data-holds-current={holdsCurrent ? "true" : undefined}
        onClick={() => (chosen ? undefined : dispatch({ type: "press", side }))}
        className={`relative flex min-h-12 flex-1 items-center justify-center gap-2 rounded-[8px] px-3 text-[15px] font-medium outline-none transition-colors duration-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${
          chosen ? "text-accent-ink" : holdsCurrent ? "text-accent" : "text-text hover:text-accent"
        }`}
      >
        {chosen ? (
          <motion.span
            layoutId="menu-sheet-tab"
            aria-hidden
            transition={reduced ? { duration: 0 } : { type: "spring", stiffness: 480, damping: 38 }}
            className="absolute inset-0 rounded-[8px] bg-accent"
          />
        ) : null}
        {holdsCurrent && !chosen ? (
          <span aria-hidden className="relative h-[6px] w-[6px] bg-accent" />
        ) : null}
        <span className="relative">{t(`sides.${side}`)}</span>
      </button>
    );
  };

  return (
    <div data-menu-sheet>
      <MenuTabContext.Provider value={control}>{children}</MenuTabContext.Provider>

      <AnimatePresence initial={false}>
        {open !== null ? (
          <motion.div
            key="scrim"
            aria-hidden
            onPointerDown={() => dispatch({ type: "outside" })}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="fixed inset-0 z-30 touch-none bg-bg/70 backdrop-blur-[2px]"
            style={{ bottom: BAR_ROOM }}
          />
        ) : null}
        {open !== null ? (
          <motion.div
            key="sheet"
            role="dialog"
            aria-modal="false"
            aria-label={t(`sides.${open}`)}
            data-menu-panel={open}
            initial={reduced ? { opacity: 0 } : { clipPath: "inset(100% 0 0 0 round 14px 14px 0 0)" }}
            animate={reduced ? { opacity: 1 } : { clipPath: "inset(0% 0 0 0 round 14px 14px 0 0)" }}
            exit={reduced ? { opacity: 0 } : { clipPath: "inset(100% 0 0 0 round 14px 14px 0 0)" }}
            transition={{ duration: reduced ? 0.15 : 0.4, ease: EASE }}
            className="grain fixed inset-x-0 z-30 flex flex-col rounded-t-[14px] border-t border-line-strong bg-bg"
            style={{ bottom: BAR_ROOM }}
          >
            <div className="flex items-center justify-between px-5 pb-1 pt-3">
              <span aria-hidden className="motif h-[10px] w-[10px]" />
              <span aria-hidden className="h-1 w-10 rounded-full bg-line-strong" />
              <button
                type="button"
                onClick={() => dispatch({ type: "outside" })}
                aria-label={t("close")}
                className="tap -mr-2 grid h-9 w-9 place-items-center rounded-[8px] text-text-muted outline-none transition-colors duration-200 hover:text-accent focus-visible:outline-2 focus-visible:outline-accent"
              >
                <svg aria-hidden width={14} height={14} viewBox="0 0 14 14" stroke="currentColor" strokeWidth={1.6} strokeLinecap="square">
                  <line x1="2" y1="2" x2="12" y2="12" />
                  <line x1="12" y1="2" x2="2" y2="12" />
                </svg>
              </button>
            </div>
            <div
              id="menu-sheet-panel"
              role="tabpanel"
              data-lenis-prevent
              onKeyDown={(event) => {
                const links = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("[data-menu-link]"));
                const next = stepLink(links.indexOf(document.activeElement as HTMLElement), event.key, links.length);
                if (next !== null) {
                  event.preventDefault();
                  links[next].focus();
                }
              }}
              className="max-h-[min(64dvh,560px)] overflow-y-auto overscroll-contain px-4 pb-6 [mask-image:linear-gradient(to_bottom,black_calc(100%-28px),transparent)]"
            >
              <AnimatePresence mode="popLayout" initial={false}>
                <SheetSide
                  key={open}
                  side={open}
                  currentKey={current?.key ?? null}
                  reduced={reduced}
                  onChoose={() => dispatch({ type: "chosen" })}
                />
              </AnimatePresence>
            </div>
            <div
              role="tablist"
              aria-label={t("label")}
              className="mx-4 flex gap-1 rounded-[10px] border border-line-strong bg-bg p-1"
              style={{ marginBottom: SIDES_FOOT }}
            >
              {SIDES.map((side) => sideTab(side))}
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

function SheetSide({
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
  const from = SIDES.indexOf(side) === 0 ? -24 : 24;
  const [lead, ...rest] = MENU[side];

  return (
    <motion.div
      data-menu-side={side}
      initial={reduced ? { opacity: 0 } : { opacity: 0, x: from }}
      animate={{ opacity: 1, x: 0 }}
      exit={reduced ? { opacity: 0 } : { opacity: 0, x: -from }}
      transition={{ duration: reduced ? 0.1 : 0.26, ease: EASE }}
    >
      <p className="pb-3 pt-1 font-display text-[2.25rem] font-semibold leading-[0.9] tracking-[-0.035em] text-text">
        {t(`sides.${side}`)}
      </p>
      <ul className="grid grid-cols-2 gap-2">
        <li className="col-span-2 [&_a]:min-h-[9.5rem] [&_a]:p-5">
          <LeadTile item={lead} current={lead.key === currentKey} onChoose={onChoose} />
        </li>
        {rest.map((item) => (
          <li key={item.key} className="[&_a]:min-h-[8rem] [&_a]:gap-3 [&_a]:p-4">
            <Tile item={item} current={item.key === currentKey} onChoose={onChoose} />
          </li>
        ))}
      </ul>
    </motion.div>
  );
}
