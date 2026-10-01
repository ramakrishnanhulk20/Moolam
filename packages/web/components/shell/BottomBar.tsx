"use client";

import { motion } from "framer-motion";
import { createContext, useContext, useEffect, useState, type ComponentProps } from "react";
import { useIsReducedMotion } from "@/components/motion/useIsReducedMotion";
import { Link, usePathname } from "@/lib/i18n/routing";
import { MenuMark, TabMark } from "./TabMark";
import { BAR_HEIGHT, activeTab, type BarItem, type BarKey, type MenuTab, type Tab, type TabKey } from "./tabs";

/**
 * The tabs whose page is fetched when a thumb or a pointer reaches for it,
 * rather than the moment the bar is drawn.
 *
 * Verify's page brings the whole check with it (viem, the verify client, the
 * consent ABI, noble), and a tab in view pulled all of it into the first
 * seconds of the home page on a phone, where Lighthouse counts it. Explore's
 * payload and code landed by 2.4 s on the live home page on 25 September. The
 * two wallet tabs are never fetched at all and stay that way.
 */
const ON_INTENT: ReadonlySet<TabKey> = new Set<TabKey>(["explore", "verify"]);

/**
 * A link that fetches its page once a reader shows they are about to open it:
 * a pointer over it, focus on it, or a thumb landing on it.
 *
 * This is the switch Next 16's own prefetching guide gives: hold prefetch off,
 * then hand it back to Next's default (null) on intent. Next then sees a link
 * in view that may prefetch and fetches it straight away, a few hundred
 * milliseconds before the click lands.
 */
export function IntentLink({
  onPointerEnter,
  onFocus,
  onTouchStart,
  ...rest
}: Omit<ComponentProps<typeof Link>, "prefetch">) {
  const [wanted, setWanted] = useState(false);
  return (
    <Link
      {...rest}
      prefetch={wanted ? null : false}
      onPointerEnter={(event) => {
        onPointerEnter?.(event);
        setWanted(true);
      }}
      onFocus={(event) => {
        onFocus?.(event);
        setWanted(true);
      }}
      onTouchStart={(event) => {
        onTouchStart?.(event);
        setWanted(true);
      }}
    />
  );
}

/** A tab's link, fetched on intent when the tab is one of ON_INTENT and as its own flag says otherwise. */
function TabLink({ tab, ...rest }: { tab: Tab } & Omit<ComponentProps<typeof Link>, "href" | "prefetch">) {
  if (tab.prefetch !== false && ON_INTENT.has(tab.key)) {
    return <IntentLink href={tab.href} {...rest} />;
  }
  return <Link href={tab.href} prefetch={tab.prefetch} {...rest} />;
}

/**
 * Whether the bar has already risen into this tab.
 *
 * The bar lives in the locale's layout, and a language switch draws that whole
 * layout again, so every switch mounted a new bar and slid it up from 56 px
 * below as if the page had just opened. The entrance belongs to the first time
 * the bar appears in a tab. A module outlives every remount and is fresh on a
 * full load, which is exactly that span.
 */
let barHasEntered = false;

/** The bar's first frame: below its place on the first mount in a tab, already in place on every mount after. */
export function barEntrance(entered: boolean, reduced: boolean): false | { opacity: number; y?: number } {
  if (entered) {
    return false;
  }
  return reduced ? { opacity: 0 } : { opacity: 0, y: BAR_HEIGHT };
}

/** Marks the entrance as played, for the next mount in this tab. */
export function markBarEntered(): void {
  barHasEntered = true;
}

/**
 * What the Menu tab needs from the sheet it opens. The sheet owns the state
 * and hands it down, so the bar and the sheet are one piece without the bar
 * knowing what the menu holds.
 */
export interface MenuTabControl {
  open: boolean;
  /** True when the page being read is one of the menu's own. */
  holds: boolean;
  onPress: () => void;
  /** Hands the sheet the Menu button, so Escape can give it the focus back. */
  holdButton: (node: HTMLButtonElement | null) => void;
}

export const MenuTabContext = createContext<MenuTabControl | null>(null);

/** Flat is five equal tabs. Raised lifts the middle one onto a disc above the bar. */
export type BarShape = "flat" | "raised";

/**
 * The bar a thumb lives on: five places, always there, at the bottom of the
 * screen where a thumb already is.
 *
 * Amazon and Flipkart taught most phone readers this shape, so it needs no
 * learning, Menu as one of the tabs included. The four places a reader goes
 * most are named on the bar itself; everything else, the business side above
 * all, is one press on Menu away.
 *
 * It stays through the film on the home page too. It used to give way while
 * the film was in the window and come back with the closing card, which left a
 * phone reader ten screens of scrolling with no way to Mine or anywhere else.
 * The film leaves the bar its room instead (.story-lower in globals.css).
 */
export function BottomBar({
  tabs,
  label,
  shape = "flat",
  at,
}: {
  tabs: BarItem[];
  /** What a screen reader calls this bar. The caller owns the language. */
  label: string;
  shape?: BarShape;
  /** The route to light, for a frame that is drawing a page it is not standing on. */
  at?: string;
}) {
  const here = usePathname();
  const route = at ?? here;
  const menu = useContext(MenuTabContext);
  const routeTab = activeTab(route);
  // A page whose tab is not on the bar, Explore's since it moved into the
  // sheet, is marked on Menu instead, so the reader always sees where they are.
  const active = tabs.some((tab) => tab.key === routeTab) ? routeTab : null;
  const menuHolds = active === null && menu?.holds === true;
  // While the sheet is up the rule stands over Menu, the tab that raised it.
  const lit: BarKey | null = menu?.open ? "menu" : menuHolds ? "menu" : active;
  const reduced = useIsReducedMotion();
  const raised = shape === "raised" ? "make" : null;
  // Read once, on this mount's first render, so a bar that is mid-entrance is
  // not stopped short by its own effect below.
  const [entered] = useState(() => barHasEntered);

  useEffect(() => {
    markBarEntered();
  }, []);

  return (
    <motion.nav
      aria-label={label}
      data-bar={shape}
      initial={barEntrance(entered, reduced)}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: reduced ? 0.2 : 0.5, ease: [0.16, 1, 0.3, 1] }}
      style={{
        // The phone's own home indicator strip, so the last word is never under
        // a thumb rail. A frame pretending to be a phone asks for the strip with --bar-safe.
        paddingBottom: "max(env(safe-area-inset-bottom), var(--bar-safe, 0px))",
      }}
      className="fixed inset-x-0 bottom-0 z-40 border-t border-line bg-bg"
    >
      <ul className="mx-auto flex w-full max-w-[560px] items-stretch" style={{ height: BAR_HEIGHT }}>
        {tabs.map((tab) => (
          <li key={tab.key} className="relative flex-1">
            {tab.key === "menu" ? (
              menu === null ? null : (
                <MenuCell
                  tab={tab}
                  open={menu.open}
                  onPress={menu.onPress}
                  holdButton={menu.holdButton}
                  current={menuHolds}
                  lit={lit === "menu"}
                  reduced={reduced}
                />
              )
            ) : tab.key === raised ? (
              <RaisedTab tab={tab} active={active === tab.key} reduced={reduced} />
            ) : (
              <FlatTab tab={tab} active={active === tab.key} lit={lit === tab.key} reduced={reduced} />
            )}
          </li>
        ))}
      </ul>
    </motion.nav>
  );
}

/**
 * One tab: the mark, the word under it, and the whole cell as the target.
 *
 * The cell is 75 px by 56 px at 375, so there is no invisible pad to hang off
 * it the way the small chips elsewhere on the site need: the thumb lands on
 * everything it can see.
 */
function FlatTab({ tab, active, lit, reduced }: { tab: Tab; active: boolean; lit: boolean; reduced: boolean }) {
  return (
    <TabLink
      tab={tab}
      aria-current={active ? "page" : undefined}
      data-tab={tab.key}
      data-guide-anchor={tab.anchor}
      data-active={active ? "true" : undefined}
      className={`group flex h-full w-full flex-col items-center justify-center gap-1 transition-colors duration-200 ${
        lit ? "text-accent" : "text-text-faint hover:text-text"
      }`}
    >
      {lit ? <Lit still={reduced} /> : null}
      <span className="transition-transform duration-200 group-hover:-translate-y-0.5">
        <TabMark name={tab.key} />
      </span>
      <span className="max-w-full truncate px-0.5 font-mono text-[10px] uppercase leading-none tracking-[0.1em]">
        {tab.label}
      </span>
    </TabLink>
  );
}

/**
 * The Menu tab: the same cell, mark and word as its neighbours, but a button.
 * The sheet rises out of the bar right over it, so the answer starts where the
 * thumb pressed, and a second press on it puts the sheet away.
 */
function MenuCell({
  tab,
  open,
  onPress,
  holdButton,
  current,
  lit,
  reduced,
}: {
  tab: MenuTab;
  open: boolean;
  onPress: () => void;
  holdButton: MenuTabControl["holdButton"];
  current: boolean;
  lit: boolean;
  reduced: boolean;
}) {
  return (
    <button
      ref={holdButton}
      type="button"
      onClick={onPress}
      aria-haspopup="dialog"
      aria-expanded={open}
      data-tab="menu"
      data-active={current ? "true" : undefined}
      className={`group flex h-full w-full flex-col items-center justify-center gap-1 transition-colors duration-200 ${
        lit ? "text-accent" : "text-text-faint hover:text-text"
      }`}
    >
      {lit ? <Lit still={reduced} /> : null}
      <span className="transition-transform duration-200 group-hover:-translate-y-0.5">
        <MenuMark open={open} still={reduced} />
      </span>
      <span className="max-w-full truncate px-0.5 font-mono text-[10px] uppercase leading-none tracking-[0.1em]">
        {tab.label}
      </span>
    </button>
  );
}

/**
 * The middle tab on a disc, half of it standing above the bar.
 *
 * Flipkart and Instagram both put the one thing they want pressed here, and it
 * is the only round corner in a product that is otherwise all square ones. The
 * disc is 56 px across, so the target is the shape itself rather than a box
 * drawn round it.
 */
function RaisedTab({ tab, active, reduced }: { tab: Tab; active: boolean; reduced: boolean }) {
  return (
    <TabLink
      tab={tab}
      aria-current={active ? "page" : undefined}
      data-tab={tab.key}
      data-guide-anchor={tab.anchor}
      data-active={active ? "true" : undefined}
      className="group flex h-full w-full flex-col items-center justify-end gap-1 pb-2 text-text-faint transition-colors duration-200 hover:text-accent"
    >
      <span
        className={`absolute -top-7 flex h-14 w-14 items-center justify-center rounded-full bg-accent text-accent-ink shadow-[0_6px_20px_-6px_rgba(0,0,0,0.55)] ${
          reduced ? "" : "transition-transform duration-200 group-hover:-translate-y-0.5 group-hover:scale-[1.04]"
        } ${active ? "ring-2 ring-accent ring-offset-2 ring-offset-bg" : ""}`}
      >
        <TabMark name={tab.key} size={24} />
      </span>
      <span
        className={`max-w-full truncate px-0.5 font-mono text-[10px] uppercase leading-none tracking-[0.1em] ${
          active ? "text-accent" : ""
        }`}
      >
        {tab.label}
      </span>
    </TabLink>
  );
}

/**
 * The rule across the top of the bar over the tab being read.
 *
 * It slides from tab to tab. With less motion asked for it stays and simply
 * stands over the new tab, because colour alone should never be the only sign
 * of where a reader is.
 */
function Lit({ still }: { still: boolean }) {
  if (still) {
    return <span aria-hidden data-lit className="absolute inset-x-5 top-0 h-[2px] bg-accent" />;
  }
  return (
    <motion.span
      data-lit
      layoutId="shell-bar-lit"
      aria-hidden
      className="absolute inset-x-5 top-0 h-[2px] bg-accent"
      transition={{ type: "spring", stiffness: 420, damping: 34 }}
    />
  );
}
