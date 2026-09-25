"use client";

import { motion } from "framer-motion";
import { useEffect, useRef, useState, type ComponentProps } from "react";
import { useIsReducedMotion } from "@/components/motion/useIsReducedMotion";
import { progress } from "@/components/story/signals";
import { Link, usePathname } from "@/lib/i18n/routing";
import { TabMark } from "./TabMark";
import { BAR_HEIGHT, activeTab, type Tab, type TabKey } from "./tabs";

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

/** Flat is five equal tabs. Raised lifts the middle one onto a disc above the bar. */
export type BarShape = "flat" | "raised";

/** What the bar can see of the page it is standing on, in one frame. */
export interface BarView {
  /** True while the first-visit guide is open somewhere in the document. */
  guideOpen: boolean;
  /** True while the pinned film is on the page, which is the home route alone. */
  filmPlaying: boolean;
  /** How much of the window the film covers, 0 to 1. See filmShare. */
  filmShown: number;
  /** How far the film's closing card has come in, 0 to 1. */
  close: number;
}

/**
 * How much of the window a box covers, 0 to 1, from its top and bottom edges.
 *
 * The home page opens on its first screen with the film under it, and the film
 * is mounted on the first scroll, long before it reaches the window. Being on
 * the page is not the same as being in view.
 */
export function filmShare(top: number, bottom: number, room: number): number {
  if (room <= 0) {
    return 0;
  }
  return Math.min(1, Math.max(0, (Math.min(bottom, room) - Math.max(top, 0)) / room));
}

/**
 * Whether the bar is seen and whether it can be reached, decided from those
 * four facts and nothing else.
 *
 * The film owns the whole window: it is pinned, it takes the wheel, and a bar
 * across the bottom of it would sit over the captions and the drop panel. So
 * while the film is in view the bar rides the story's own closing signal and
 * arrives with the closing card and the footer. The first screen above the film
 * is the page a phone visitor lands on, so there the bar is simply awake: it
 * gives way as the film climbs into the window and comes back if the reader
 * scrolls back up to the first screen.
 *
 * The guide overrules it. A first visitor is being walked through the three
 * things they can do here, and two of those steps point at tabs; a bar that is
 * invisible and inert while the film is still playing would leave the walk
 * pointing at nothing. So while the guide is open the bar is there, whatever
 * the film is doing, and it goes back to the film's rule the moment the guide
 * closes.
 *
 * Anything invisible is also taken out of the tab order: a reader on a keyboard
 * should not land on five links they cannot see.
 */
export function barLook(view: BarView): { opacity: number; inert: boolean } {
  if (view.guideOpen || !view.filmPlaying) {
    return { opacity: 1, inert: false };
  }
  const opacity = Math.min(1, Math.max(0, 1 - view.filmShown, view.close));
  return { opacity, inert: opacity <= 0.5 };
}

/**
 * The bar a thumb lives on: five places, always there, at the bottom of the
 * screen where a thumb already is.
 *
 * Amazon and Flipkart taught most phone readers this shape, so it needs no
 * learning. What it replaces is a menu button, which asks for a tap before it
 * will say what a site even has in it.
 */
export function BottomBar({
  tabs,
  label,
  shape = "flat",
  at,
  film,
}: {
  tabs: Tab[];
  /** What a screen reader calls this bar. The caller owns the language. */
  label: string;
  shape?: BarShape;
  /** The route to light, for a frame that is drawing a page it is not standing on. */
  at?: string;
  /** Whether this page can carry the pinned film. Left off, the route decides. */
  film?: boolean;
}) {
  const here = usePathname();
  const route = at ?? here;
  const active = activeTab(route);
  const reduced = useIsReducedMotion();
  const shell = useRef<HTMLElement>(null);
  const overFilm = film ?? route === "/";

  // barLook decides; this loop only reads the page for it, every frame, because
  // the number it reads is written by the scene's own render loop and putting
  // it in React state would re-render the bar sixty times a second. On a route
  // with no film there is nothing to read: the bar is simply there, which is
  // also what a reader who asked for less motion gets, because the still cut
  // carries no film element.
  useEffect(() => {
    if (!overFilm) {
      return;
    }
    let frame = 0;
    let was: boolean | null = null;

    const loop = () => {
      const node = shell.current;
      if (node !== null) {
        const film = document.querySelector('[data-story="film"]');
        const box = film?.getBoundingClientRect();
        const look = barLook({
          guideOpen: document.querySelector("[data-guide-open]") !== null,
          filmPlaying: film !== null,
          filmShown: box === undefined ? 0 : filmShare(box.top, box.bottom, window.innerHeight),
          close: progress.close,
        });
        // The opacity is written on every frame, not only when it changes: the
        // entrance animation writes the same property from its own loop, and a
        // frame this one skips is a frame that animation wins. The tab order is
        // only touched when the answer changes, because that one moves focus.
        node.style.opacity = String(look.opacity);
        if (look.inert !== was) {
          was = look.inert;
          node.inert = look.inert;
        }
      }
      frame = requestAnimationFrame(loop);
    };

    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, [overFilm]);

  const raised = shape === "raised" ? "make" : null;

  return (
    <motion.nav
      ref={shell}
      aria-label={label}
      data-bar={shape}
      initial={reduced ? { opacity: 0 } : { opacity: 0, y: BAR_HEIGHT }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: reduced ? 0.2 : 0.5, ease: [0.16, 1, 0.3, 1] }}
      style={{
        // The phone's own home indicator strip, so the last word is never under
        // a thumb rail. A bench frame asks for the strip with --bar-safe.
        paddingBottom: "max(env(safe-area-inset-bottom), var(--bar-safe, 0px))",
      }}
      className="fixed inset-x-0 bottom-0 z-40 border-t border-line bg-bg"
    >
      <ul className="mx-auto flex w-full max-w-[560px] items-stretch" style={{ height: BAR_HEIGHT }}>
        {tabs.map((tab) => (
          <li key={tab.key} className="relative flex-1">
            {tab.key === raised ? (
              <RaisedTab tab={tab} active={active === tab.key} reduced={reduced} />
            ) : (
              <FlatTab tab={tab} active={active === tab.key} reduced={reduced} />
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
function FlatTab({ tab, active, reduced }: { tab: Tab; active: boolean; reduced: boolean }) {
  return (
    <TabLink
      tab={tab}
      aria-current={active ? "page" : undefined}
      data-tab={tab.key}
      data-guide-anchor={tab.anchor}
      data-active={active ? "true" : undefined}
      className={`group flex h-full w-full flex-col items-center justify-center gap-1 transition-colors duration-200 ${
        active ? "text-accent" : "text-text-faint hover:text-text"
      }`}
    >
      {active && !reduced ? <Lit /> : null}
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

/** The rule that slides across the top of the bar to the tab being read. */
function Lit() {
  return (
    <motion.span
      layoutId="shell-bar-lit"
      aria-hidden
      className="absolute inset-x-5 top-0 h-[2px] bg-accent"
      transition={{ type: "spring", stiffness: 420, damping: 34 }}
    />
  );
}
