"use client";

import { useEffect, useRef } from "react";
import { FIELD, approach, displace } from "./displacement";

/**
 * A lattice of dots that parts around the cursor and settles back when it leaves.
 *
 * Canvas rather than elements: a full-bleed panel at this spacing is around two
 * thousand dots, and that many nodes with a transform each would drop frames on
 * a laptop.
 *
 * The loop is idle until the pointer has moved and stops again once every dot has
 * come to rest, so a panel nobody touches costs nothing.
 */
export function DotField({ className = "" }: { className?: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const parent = canvas?.parentElement;
    if (!canvas || !parent) {
      return;
    }

    const context = canvas.getContext("2d");
    if (!context) {
      return;
    }

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    interface Dot {
      homeX: number;
      homeY: number;
      x: number;
      y: number;
      glow: number;
    }

    let dots: Dot[] = [];
    let width = 0;
    let height = 0;
    let frame = 0;
    let pointer: { x: number; y: number } | null = null;
    let accent = "255, 125, 85";
    let ground = "244, 242, 238";

    const readColours = () => {
      const style = getComputedStyle(parent);
      accent = channels(style.getPropertyValue("--accent")) ?? accent;
      ground = channels(style.getPropertyValue("--text")) ?? ground;
    };

    const build = () => {
      const rect = parent.getBoundingClientRect();
      width = rect.width;
      height = rect.height;
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      context.setTransform(ratio, 0, 0, ratio, 0, 0);

      dots = [];
      // Inset by half a step so the lattice reads as centred rather than clipped.
      for (let y = FIELD.spacing / 2; y < height; y += FIELD.spacing) {
        for (let x = FIELD.spacing / 2; x < width; x += FIELD.spacing) {
          dots.push({ homeX: x, homeY: y, x, y, glow: 0 });
        }
      }
      readColours();
      draw();
    };

    const draw = () => {
      context.clearRect(0, 0, width, height);
      for (const dot of dots) {
        const alpha = 0.1 + dot.glow * 0.75;
        context.fillStyle = dot.glow > 0.02 ? `rgba(${accent}, ${alpha})` : `rgba(${ground}, ${alpha})`;
        context.beginPath();
        context.arc(dot.x, dot.y, FIELD.dotRadius + dot.glow * 1.2, 0, Math.PI * 2);
        context.fill();
      }
    };

    const step = () => {
      let moving = false;

      for (const dot of dots) {
        const target = pointer
          ? displace(dot.homeX, dot.homeY, pointer.x, pointer.y)
          : { dx: 0, dy: 0, intensity: 0 };

        const nextX = approach(dot.x, dot.homeX + target.dx);
        const nextY = approach(dot.y, dot.homeY + target.dy);
        const nextGlow = approach(dot.glow, target.intensity);

        if (
          Math.abs(nextX - dot.x) > 0.01 ||
          Math.abs(nextY - dot.y) > 0.01 ||
          Math.abs(nextGlow - dot.glow) > 0.002
        ) {
          moving = true;
        }

        dot.x = nextX;
        dot.y = nextY;
        dot.glow = nextGlow;
      }

      draw();
      frame = moving ? requestAnimationFrame(step) : 0;
    };

    const wake = () => {
      if (!frame && !reduced) {
        frame = requestAnimationFrame(step);
      }
    };

    const onPointerMove = (event: PointerEvent) => {
      const rect = parent.getBoundingClientRect();
      pointer = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      wake();
    };

    const onPointerLeave = () => {
      pointer = null;
      wake();
    };

    build();

    const sizes = new ResizeObserver(build);
    sizes.observe(parent);

    // The theme lives in a class on html and the accent in an attribute on a
    // wrapper, so both have to be watched or the field keeps yesterday's colour.
    const palette = new MutationObserver(() => {
      readColours();
      draw();
    });
    palette.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    palette.observe(parent, { attributes: true, attributeFilter: ["data-accent"] });

    parent.addEventListener("pointermove", onPointerMove);
    parent.addEventListener("pointerleave", onPointerLeave);

    return () => {
      if (frame) {
        cancelAnimationFrame(frame);
      }
      sizes.disconnect();
      palette.disconnect();
      parent.removeEventListener("pointermove", onPointerMove);
      parent.removeEventListener("pointerleave", onPointerLeave);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      className={`pointer-events-none absolute inset-0 h-full w-full ${className}`}
    />
  );
}

/** Turns a `#rrggbb` custom property into the "r, g, b" an rgba() string wants. */
function channels(value: string): string | null {
  const hex = value.trim();
  if (!/^#[0-9a-f]{6}$/i.test(hex)) {
    return null;
  }
  const number = Number.parseInt(hex.slice(1), 16);
  return `${(number >> 16) & 255}, ${(number >> 8) & 255}, ${number & 255}`;
}
