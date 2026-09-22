"use client";

import { motion } from "framer-motion";
import { useEffect, useRef } from "react";
import { useIsReducedMotion } from "@/components/motion/useIsReducedMotion";
import { progress } from "@/components/story/signals";
import { Link, usePathname } from "@/lib/i18n/routing";
import { TabMark } from "./TabMark";
import { BAR_HEIGHT, activeTab, barShown, type Tab } from "./tabs";

/** Flat is five equal tabs. Raised lifts the middle one onto a disc above the bar. */
export type BarShape = "flat" | "raised";

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
  const drawn = barShown(route);
  const reduced = useIsReducedMotion();
  const shell = useRef<HTMLElement>(null);
  const overFilm = film ?? route === "/";

  // The film owns the whole window: it is pinned, it takes the wheel, and a bar
  // across the bottom of it would sit over the captions and the drop panel. So
  // on that one route the bar rides the story's own closing signal, the number
  // the scene writes every frame, and arrives with the closing card and the
  // footer. On the still page there is no film element, the loop reads 1, and
  // the bar is simply there, which is what a reader who asked for less motion
  // should get.
  useEffect(() => {
    if (!overFilm || !drawn) {
      return;
    }
    let frame = 0;
    let gone: boolean | null = null;

    const loop = () => {
      const node = shell.current;
      if (node !== null) {
        const playing = document.querySelector('[data-story="film"]') !== null;
        const shown = playing ? progress.close : 1;
        node.style.opacity = String(shown);
        const next = shown <= 0.5;
        if (next !== gone) {
          gone = next;
          node.inert = next;
        }
      }
      frame = requestAnimationFrame(loop);
    };

    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, [overFilm, drawn]);

  // A bench draws its own bar, often two of them, and a third across the page
  // would be measuring the wrong thing.
  if (!drawn) {
    return null;
  }

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
    <Link
      href={tab.href}
      prefetch={tab.prefetch}
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
    </Link>
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
    <Link
      href={tab.href}
      prefetch={tab.prefetch}
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
    </Link>
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
