"use client";

export interface Phone {
  label: string;
  width: number;
  height: number;
}

/** The two screens the drawings are measured on. */
export const PHONES: Phone[] = [
  { label: "375 x 812", width: 375, height: 812 },
  { label: "360 x 780", width: 360, height: 780 },
];

/**
 * A phone on a laptop, and it has to be an iframe.
 *
 * A box 375 px wide inside a 1440 px window is not a phone: a media query reads
 * the window and never the box, so the page inside lays itself out for a
 * desktop and is clipped. An iframe has a viewport of its own, so the page in
 * it takes the phone's own layout, the header sticks to the frame and the bar
 * is fixed against a real 812 px window. What it loads is this bench's own full
 * bleed address, which is the shell with one real page inside it.
 *
 * The site refuses to be framed everywhere else: x-frame-options is DENY on
 * every path and SAMEORIGIN, in development only, on the lab routes.
 */
export function PhoneFrame({ src, phone, title }: { src: string; phone: Phone; title: string }) {
  return (
    <div
      className="relative overflow-hidden border border-line-strong bg-bg"
      style={{ width: phone.width, height: phone.height }}
    >
      {/* key on the address: changing the page or the ground is a new document
          rather than a navigation inside the old one, so nothing of the last
          page is left in the frame while the next one arrives. */}
      <iframe
        key={src}
        src={src}
        title={title}
        width={phone.width}
        height={phone.height}
        loading="eager"
        className="block border-0"
      />

      {/* The home indicator the bar leaves its safe strip for, drawn here
          because a laptop has none of its own. */}
      <span
        aria-hidden
        className="pointer-events-none absolute bottom-[11px] left-1/2 h-[5px] w-[134px] -translate-x-1/2 rounded-full bg-text/35"
      />
    </div>
  );
}
