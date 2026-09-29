"use client";

import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { diagramWidth, drawnSize } from "@/lib/docs/diagram";
import type { DiagramVariant } from "@/lib/docs/render";

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 3;

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

/** A word from the docs messages, with the English one until that line lands. */
type Say = (key: string, plain: string) => string;

/**
 * The whole viewport, one drawing, and a way to move around it.
 *
 * The drawing opens whole, at whatever zoom it takes to fit the screen, and from
 * there it is pinched, wheeled and dragged. Panning and zooming write straight
 * to the transform rather than through state, so a wheel turn never costs a
 * React render.
 */
function FullSize({ svg, say, label, close }: { svg: string; say: Say; label: string; close: () => void }) {
  const dialog = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const ink = useRef<HTMLDivElement>(null);
  const readout = useRef<HTMLSpanElement>(null);
  const shut = useRef<HTMLButtonElement>(null);
  const view = useRef({ k: 1, x: 0, y: 0 });
  // A 2,752 px drawing on a 375 px phone has to start under half a per cent of
  // its size to be seen whole, so the bottom of the zoom range is whatever it
  // takes to fit, and never more than the ordinary half.
  const floor = useRef(MIN_ZOOM);
  const fitted = useRef(1);
  const points = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ gap: number; k: number } | null>(null);
  const calm = useReducedMotion() === true;

  const paint = useCallback(() => {
    const { k, x, y } = view.current;
    if (ink.current !== null) {
      ink.current.style.transform = `translate3d(${x}px, ${y}px, 0) scale(${k})`;
    }
    if (readout.current !== null) {
      readout.current.textContent = `${Math.round(k * 100)}%`;
    }
  }, []);

  /** Zoom so that the point under the cursor, or under the pinch, stays there. */
  const zoomAt = useCallback(
    (wanted: number, px: number, py: number) => {
      const now = view.current;
      const k = clamp(wanted, floor.current, MAX_ZOOM);
      view.current = {
        k,
        x: px - ((px - now.x) * k) / now.k,
        y: py - ((py - now.y) * k) / now.k,
      };
      paint();
    },
    [paint],
  );

  /** Screen coordinates become coordinates measured from the middle of the stage. */
  const onStage = useCallback((clientX: number, clientY: number) => {
    const box = stage.current?.getBoundingClientRect();
    if (box === undefined) {
      return { x: 0, y: 0 };
    }
    return { x: clientX - box.left - box.width / 2, y: clientY - box.top - box.height / 2 };
  }, []);

  /** The zoom at which the whole drawing sits inside the stage with room to spare. */
  const fit = useCallback(() => {
    const board = stage.current;
    const drawn = ink.current?.querySelector("svg");
    if (board === null || drawn === undefined || drawn === null) {
      return 1;
    }
    const box = drawn.getBoundingClientRect();
    const wide = box.width / Math.max(view.current.k, 0.0001);
    const tall = box.height / Math.max(view.current.k, 0.0001);
    if (wide <= 0 || tall <= 0) {
      return 1;
    }
    return Math.min(1, (board.clientWidth - 32) / wide, (board.clientHeight - 32) / tall);
  }, []);

  useEffect(() => {
    const was = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    shut.current?.focus();
    // A phone redraw is drawn at the width of the column it sits in, which here
    // would be the width of the whole stage. Full size means its own size, and
    // mermaid leaves that on the drawing as a cap.
    const drawn = ink.current?.querySelector("svg");
    if (drawn !== null && drawn !== undefined) {
      const own = Number.parseFloat(drawn.style.maxWidth);
      if (Number.isFinite(own) && own > 0) {
        drawn.style.width = `${own}px`;
        drawn.style.maxWidth = "none";
      }
    }
    // The drawing opens whole. Anything smaller than the stage opens at its own
    // size rather than being blown up to fill it.
    const start = fit();
    fitted.current = start;
    floor.current = Math.min(MIN_ZOOM, start);
    view.current = { k: start, x: 0, y: 0 };
    paint();
    return () => {
      document.body.style.overflow = was;
    };
  }, [fit, paint]);

  // React listens to a wheel passively, and a passive listener cannot stop the
  // page moving behind the overlay, so this one is attached by hand.
  useEffect(() => {
    const board = stage.current;
    if (board === null) {
      return;
    }
    function onWheel(event: WheelEvent) {
      event.preventDefault();
      const at = onStage(event.clientX, event.clientY);
      zoomAt(view.current.k * Math.exp(-event.deltaY * 0.0016), at.x, at.y);
    }
    board.addEventListener("wheel", onWheel, { passive: false });
    return () => board.removeEventListener("wheel", onWheel);
  }, [onStage, zoomAt]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        close();
        return;
      }
      if (event.key !== "Tab" || dialog.current === null) {
        return;
      }
      // Focus stays inside the overlay: the page behind it cannot be reached
      // with the keyboard while a drawing is open.
      const stops = dialog.current.querySelectorAll<HTMLElement>("button, [href]");
      if (stops.length === 0) {
        return;
      }
      const first = stops[0];
      const last = stops[stops.length - 1];
      const inside = document.activeElement !== null && dialog.current.contains(document.activeElement);
      if (!inside) {
        // Dragging the drawing takes focus off the controls and onto nothing, so
        // the next Tab is sent back to the top of the overlay, not into the page.
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
        return;
      }
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);

  function trackDown(event: ReactPointerEvent<HTMLDivElement>) {
    event.currentTarget.setPointerCapture(event.pointerId);
    points.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (points.current.size === 2) {
      const [one, two] = [...points.current.values()];
      pinch.current = { gap: Math.hypot(one.x - two.x, one.y - two.y), k: view.current.k };
    }
  }

  function trackMove(event: ReactPointerEvent<HTMLDivElement>) {
    const before = points.current.get(event.pointerId);
    if (before === undefined) {
      return;
    }
    points.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const holding = pinch.current;
    if (points.current.size >= 2 && holding !== null && holding.gap > 0) {
      const [one, two] = [...points.current.values()];
      const gap = Math.hypot(one.x - two.x, one.y - two.y);
      const middle = onStage((one.x + two.x) / 2, (one.y + two.y) / 2);
      zoomAt((holding.k * gap) / holding.gap, middle.x, middle.y);
      return;
    }
    const now = view.current;
    view.current = { ...now, x: now.x + (event.clientX - before.x), y: now.y + (event.clientY - before.y) };
    paint();
  }

  function trackUp(event: ReactPointerEvent<HTMLDivElement>) {
    points.current.delete(event.pointerId);
    if (points.current.size < 2) {
      pinch.current = null;
    }
  }

  const step = (factor: number) => zoomAt(view.current.k * factor, 0, 0);
  const reset = () => {
    view.current = { k: fitted.current, x: 0, y: 0 };
    paint();
  };

  // docs-lightbox-control holds the 44 px hit area a thumb needs.
  const control =
    "docs-lightbox-control rounded-[8px] border border-line px-3 font-mono text-[12px] uppercase tracking-[0.18em] text-text-muted transition-colors duration-200 hover:border-accent hover:text-accent";
  const round =
    "docs-lightbox-control rounded-[8px] border border-line font-mono text-base text-text-muted transition-colors duration-200 hover:border-accent hover:text-accent";

  return (
    <motion.div
      ref={dialog}
      role="dialog"
      aria-modal="true"
      aria-label={label}
      data-lenis-prevent
      className="fixed inset-0 z-[90] flex flex-col bg-bg/95 backdrop-blur-sm"
      initial={{ opacity: calm ? 1 : 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: calm ? 1 : 0 }}
      transition={{ duration: calm ? 0 : 0.18, ease: "easeOut" }}
    >
      {/* The controls wrap onto a second line rather than off the edge: in German
          they need about 418 px, and a phone has 343 px, so Close, the only way
          out, would otherwise sit mostly off the screen. */}
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3 sm:px-6">
        <span className="hidden font-mono text-[12px] uppercase tracking-[0.22em] text-text-faint sm:inline">
          {label}
        </span>
        <div className="ml-auto flex flex-wrap items-center justify-end gap-1.5">
          <button
            type="button"
            onClick={() => step(1 / 1.25)}
            aria-label={say("zoomOut", "Zoom out")}
            className={round}
          >
            <span aria-hidden>-</span>
          </button>
          <span
            ref={readout}
            className="w-14 text-center font-mono text-[12px] uppercase tracking-[0.18em] tabular-nums text-text-faint"
          >
            100%
          </span>
          <button
            type="button"
            onClick={() => step(1.25)}
            aria-label={say("zoomIn", "Zoom in")}
            className={round}
          >
            <span aria-hidden>+</span>
          </button>
          <button type="button" onClick={reset} className={control}>
            {say("zoomReset", "Reset")}
          </button>
          <button ref={shut} type="button" data-close onClick={close} className={control}>
            {say("close", "Close")}
          </button>
        </div>
      </div>

      <div
        ref={stage}
        onPointerDown={trackDown}
        onPointerMove={trackMove}
        onPointerUp={trackUp}
        onPointerCancel={trackUp}
        className="docs-lightbox-stage flex flex-1 cursor-grab items-center justify-center overflow-hidden active:cursor-grabbing"
      >
        <div ref={ink} className="docs-lightbox-ink" dangerouslySetInnerHTML={{ __html: svg }} />
      </div>
    </motion.div>
  );
}

/**
 * The frame around one architecture drawing.
 *
 * A drawing wider than the column is scaled down to the column's width only
 * while its labels stay readable (see DIAGRAM_SCALE_FLOOR). Past that it holds
 * the floor and the frame scrolls sideways, with the fade and the mono hint to
 * say so, and Open full size stays in reach at the top of the frame. A phone
 * redraw is drawn to the width of the column, so neither ever shows on one.
 */
export function DiagramFrame({
  svg,
  variant = "both",
  caption = null,
}: {
  svg: string;
  variant?: DiagramVariant;
  caption?: string | null;
}) {
  const t = useTranslations("docs");
  // The docs messages are edited elsewhere in this build. Until these lines land
  // in them, the frame says its piece in English rather than printing a key.
  const say: Say = (key, plain) => (t.has(key) ? t(key) : plain);

  // A drawing is named by the line written under it. Without that, every one of
  // the twelve on the architecture page announced itself as "Diagram,
  // scrollable" and a reader tabbing through them could not tell which half of
  // which flow they had landed in.
  const nameIt = (key: string, tail: string, unnamed: string) =>
    caption === null ? unnamed : t.has(key) ? t(key, { name: caption }) : `${caption}, ${tail}`;

  const regionLabel = nameIt("diagramNamed", "diagram, scrollable", say("diagramRegion", "Diagram, scrollable"));
  const fullLabel = nameIt("diagramNamedFull", "diagram, full size", say("diagramFull", "Diagram, full size"));

  // A phone redraw is drawn to its column by mermaid itself and keeps that.
  const drawn = variant === "phone" ? null : drawnSize(svg);
  const inkStyle = drawn === null ? undefined : { width: diagramWidth(drawn.width) };

  const [open, setOpen] = useState(false);
  const [more, setMore] = useState(false);
  const [moved, setMoved] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const box = scroller.current;
    if (box === null) {
      return;
    }
    const measure = () => {
      setMore(box.scrollWidth - box.clientWidth - box.scrollLeft > 8);
      if (box.scrollLeft > 4) {
        setMoved(true);
      }
    };
    measure();
    const watch = new ResizeObserver(measure);
    watch.observe(box);
    box.addEventListener("scroll", measure, { passive: true });
    return () => {
      watch.disconnect();
      box.removeEventListener("scroll", measure);
    };
  }, [svg]);

  return (
    <figure className="docs-diagram" data-variant={variant} data-more={more} data-moved={moved}>
      {caption === null ? null : <figcaption className="docs-diagram-caption">{caption}</figcaption>}
      <div className="docs-diagram-head">
        <button ref={opener} type="button" onClick={() => setOpen(true)} className="docs-diagram-open">
          {say("diagramOpen", "Open full size")}
        </button>
      </div>

      <div
        ref={scroller}
        // Lenis owns the wheel on every page and would swallow a sideways turn
        // of a trackpad before this frame ever saw it.
        data-lenis-prevent
        tabIndex={0}
        role="region"
        aria-label={regionLabel}
        className="docs-diagram-scroll"
      >
        <div className="docs-diagram-ink" style={inkStyle} dangerouslySetInnerHTML={{ __html: svg }} />
      </div>

      <span aria-hidden className="docs-diagram-fade" />
      <span aria-hidden className="docs-diagram-hint">
        {say("diagramScroll", "scroll")}
      </span>

      {typeof document === "undefined"
        ? null
        : createPortal(
            <AnimatePresence>
              {open ? (
                <FullSize
                  svg={svg}
                  say={say}
                  label={fullLabel}
                  close={() => {
                    setOpen(false);
                    opener.current?.focus();
                  }}
                />
              ) : null}
            </AnimatePresence>,
            document.body,
          )}
    </figure>
  );
}
