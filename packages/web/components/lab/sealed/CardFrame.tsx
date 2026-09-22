"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

const WIDTH = 1200;
const HEIGHT = 630;

/**
 * The social card at its real 1200 by 630, shrunk to whatever room the bench
 * has for it.
 *
 * The card has to be built at full size, because that is the size it is drawn
 * at when a chat app asks for it, and a card laid out in percentages would look
 * right here and wrong there. So it is built at full size and scaled, and the
 * frame keeps the page's room for it with an aspect ratio, which means nothing
 * moves while the measurement lands.
 */
export function CardFrame({ children }: { children: ReactNode }) {
  const frame = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);

  useEffect(() => {
    const box = frame.current;
    if (box === null) {
      return;
    }
    const watch = new ResizeObserver(([entry]) => setScale(entry.contentRect.width / WIDTH));
    watch.observe(box);
    return () => watch.disconnect();
  }, []);

  return (
    <div ref={frame} className="relative w-full overflow-hidden" style={{ aspectRatio: `${WIDTH} / ${HEIGHT}` }}>
      <div
        className="absolute start-0 top-0 origin-top-left"
        style={{ width: WIDTH, height: HEIGHT, transform: `scale(${scale})` }}
      >
        {children}
      </div>
    </div>
  );
}
