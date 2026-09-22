"use client";

import { useEffect, useState, type ReactNode } from "react";
import { Reveal } from "@/components/lab/sponsors/Reveal";
import { BottomBar } from "@/components/shell/BottomBar";
import { PhoneHeader } from "@/components/shell/PhoneHeader";
import { BAR_HEIGHT, BAR_ROOM } from "@/components/shell/tabs";
import { progress } from "@/components/story/signals";
import { InstallFrames, type InstallShape } from "./InstallFrames";
import { PHONES, PhoneFrame } from "./PhoneFrame";
import { PAGE_ROUTE, PAGE_WORDS, RAISED_TABS, TABS, type PageKey } from "./words";

const PAGES: PageKey[] = ["home", "explore", "verify", "make", "mine"];

const DRAWINGS = {
  a: { title: "A. Five tabs", line: "Home, Explore, Verify, Make, Mine. One row, one weight, nothing raised." },
  b: {
    title: "B. Four and a raised Make",
    line: "The thing this site wants pressed stands half above the bar, the way Flipkart and Instagram put it.",
  },
} as const;

/**
 * Both drawings of the phone shell, side by side, with a real page in each.
 *
 * Nothing here is a mock: the film, the sheet, the drop panel and the studio
 * card are the app's own components reading the live index. Each frame is an
 * iframe of this same route in its full bleed mode, so the page inside has a
 * 375 or 360 pixel viewport of its own and lays itself out exactly as a phone
 * would. The page being framed lives in the address, so opening the sheet asks
 * the index for the sheet and for nothing else.
 */
export function PhoneBench({
  page,
  content,
  install,
  full,
  size,
  ground,
  safe,
}: {
  /** The page being framed. In the bench view the frames load it; only full bleed renders it here. */
  page: PageKey;
  content: ReactNode;
  install: InstallShape;
  /** Set by ?full=a or ?full=b: one drawing filling the window, for the browser's phone emulation. */
  full: "a" | "b" | null;
  size: number;
  /** Which palette the frames are drawn in, asked for in the address. */
  ground: "dark" | "light";
  /** True where something around this window is pretending to have a home indicator. */
  safe: boolean;
}) {
  const [playing, setPlaying] = useState(false);
  const phone = PHONES[size] ?? PHONES[0];

  if (full !== null) {
    return <FullBleed drawing={full} page={page} content={content} ground={ground} safe={safe} />;
  }

  const at = (change: Partial<{ page: PageKey; size: number; ground: string; full: string }>) => {
    const query = new URLSearchParams({
      page: change.page ?? page,
      size: String(change.size ?? size),
      ground: change.ground ?? ground,
    });
    if (change.full !== undefined) {
      query.set("full", change.full);
    }
    return `?${query.toString()}`;
  };

  return (
    <div className="min-h-dvh bg-bg text-text">
      <div className="mx-auto w-full max-w-[100rem] px-5 pb-32 pt-16 sm:px-8 lg:px-14">
        <Reveal>
          <p className="flex items-center gap-3 font-mono text-[11px] uppercase tracking-[0.24em] text-accent">
            <span className="motif h-[9px] w-[9px]" />
            Phone bench
          </p>
        </Reveal>

        <Reveal delay={0.08}>
          <h1 className="mt-7 max-w-[15ch] font-display text-[clamp(3rem,10vw,9rem)] font-semibold uppercase leading-[0.85] tracking-[-0.055em]">
            A bar under the thumb
          </h1>
        </Reveal>

        <Reveal delay={0.16}>
          <p className="mt-8 max-w-[62ch] text-base leading-relaxed text-text-muted">
            Two drawings of the same idea: the five places this site has, on screen all the time, where a thumb already
            is. The menu button goes, the top bar shrinks to the wordmark and the two chips, and every page keeps its
            own first action above the bar. The pages in the frames are the real ones, reading the live registry.
          </p>
        </Reveal>

        <Reveal delay={0.22}>
          <div className="mt-10 border-y border-line py-6">
            <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
              <Choice label="Page" chosen={PAGE_WORDS[page]} options={PAGES.map((key) => ({ word: PAGE_WORDS[key], href: at({ page: key }) }))} />
              <Choice
                label="Screen"
                chosen={phone.label}
                options={PHONES.map((one, index) => ({ word: one.label, href: at({ size: index }) }))}
              />
              <Choice
                label="Ground"
                chosen={ground === "dark" ? "Dark" : "Light"}
                options={[
                  { word: "Dark", href: at({ ground: "dark" }) },
                  { word: "Light", href: at({ ground: "light" }) },
                ]}
              />
            </div>
            <p className="mt-4 max-w-[74ch] text-sm leading-relaxed text-text-faint">
              Each frame is a window of its own, so what is in it is the real page at a phone&rsquo;s own width,
              laid out the way a phone lays it out. The Ground chip sets both frames. The theme chip inside a frame
              is the site&rsquo;s own control and the site keeps one theme for the whole origin, so pressing it flips
              both frames together, measured rather than assumed.
            </p>
          </div>
        </Reveal>

        {page === "home" && (
          <Reveal delay={0.24}>
            <FilmNote playing={playing} onPlay={setPlaying} />
          </Reveal>
        )}

        <div className="mt-14 flex flex-wrap items-start justify-center gap-x-16 gap-y-14">
          {(["a", "b"] as const).map((drawing, index) => (
            <Reveal key={drawing} delay={0.1 + index * 0.08}>
              <figure className="flex flex-col items-center">
                <PhoneFrame
                  src={`${at({ full: drawing })}&safe=1`}
                  phone={phone}
                  title={`Drawing ${drawing.toUpperCase()}, ${PAGE_WORDS[page]}, ${phone.label}`}
                />
                <figcaption className="mt-6 max-w-[34ch] text-center">
                  <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-accent">
                    {DRAWINGS[drawing].title}
                  </p>
                  <p className="mt-3 text-sm leading-relaxed text-text-muted">{DRAWINGS[drawing].line}</p>
                  <a
                    href={at({ full: drawing })}
                    className="tap mt-4 inline-block font-mono text-[11px] uppercase tracking-[0.18em] text-text-faint transition-colors duration-200 hover:text-accent"
                  >
                    Open full bleed
                  </a>
                </figcaption>
              </figure>
            </Reveal>
          ))}
        </div>

        <Reveal>
          <Measurements phone={phone.label} />
        </Reveal>

        <InstallFrames install={install} />
      </div>
    </div>
  );
}

/**
 * One drawing filling the window: what the browser's phone emulation opens, and
 * the only view on this bench where the page inside is laid out as a phone
 * would lay it out.
 *
 * The site's own header and footer come off this route while it is in this
 * mode, because two headers stacked would be measuring a screen nobody will
 * have.
 */
function FullBleed({
  drawing,
  page,
  content,
  ground,
  safe,
}: {
  drawing: "a" | "b";
  page: PageKey;
  content: ReactNode;
  ground: "dark" | "light";
  safe: boolean;
}) {
  // The ground goes on this document's own root, which is where the site keeps
  // it and the only place Tailwind's dark variant reads. A class on a wrapper
  // would paint the palette and still hand every component inside the dark
  // branch. next-themes writes the same attribute from its own mount effect,
  // which runs after this one, so the pin is written again on the next frame.
  // Inside a frame this is the frame's document alone: the theme chip in the
  // bar below changes this window and not its neighbour.
  useEffect(() => {
    const root = document.documentElement;
    const pin = () => {
      root.classList.remove("dark", "light");
      root.classList.add(ground);
    };
    pin();
    const frame = requestAnimationFrame(pin);
    return () => cancelAnimationFrame(frame);
  }, [ground]);

  const room: Record<string, string> = { paddingBottom: BAR_ROOM };
  if (safe) {
    room["--bar-safe"] = "34px";
  }

  const other = (key: PageKey | null, swap: boolean) =>
    `?full=${swap ? (drawing === "a" ? "b" : "a") : drawing}&page=${key ?? page}&ground=${ground}${safe ? "&safe=1" : ""}`;

  return (
    <div style={room}>
      {/* The site's own bar and footer come off this route in this mode: two
          headers stacked would be measuring a screen nobody will have. The
          scrollbar goes with them, because a phone draws none and a laptop one
          would take 15 px off the page inside a frame. */}
      <style>
        {".app-header, body footer { display: none !important; }" +
          "html { scrollbar-width: none; } html::-webkit-scrollbar { display: none; }"}
      </style>

      {/* No bench chrome at all inside a frame, where the caption under the
          frame already names the drawing and every pixel of the 812 belongs to
          the phone. Opened on its own this strip is how the page is changed,
          and it is shut until it is wanted. Every chip is a link, because this
          mode renders one page and one page only. */}
      {!safe && (
      <details className="border-b border-line bg-bg-raised px-4 py-2">
        <summary className="tap cursor-pointer font-mono text-[10px] uppercase tracking-[0.2em] text-text-faint transition-colors duration-200 hover:text-accent">
          Bench, drawing {drawing.toUpperCase()}, {PAGE_WORDS[page]}
        </summary>
        <nav className="mt-3 flex flex-wrap gap-2">
          {PAGES.map((key) => (
            <a
              key={key}
              href={other(key, false)}
              className={`tap rounded-[8px] border px-3 py-2 font-mono text-[10px] uppercase tracking-[0.16em] transition-colors duration-200 ${
                key === page
                  ? "border-accent text-accent"
                  : "border-line text-text-faint hover:border-accent hover:text-accent"
              }`}
            >
              {PAGE_WORDS[key]}
            </a>
          ))}
          <a
            href={other(null, true)}
            className="tap rounded-[8px] border border-line px-3 py-2 font-mono text-[10px] uppercase tracking-[0.16em] text-text-faint transition-colors duration-200 hover:border-accent hover:text-accent"
          >
            Drawing {drawing === "a" ? "B" : "A"}
          </a>
          <a
            href={`?page=${page}&ground=${ground}`}
            className="tap rounded-[8px] border border-line px-3 py-2 font-mono text-[10px] uppercase tracking-[0.16em] text-text-faint transition-colors duration-200 hover:border-accent hover:text-accent"
          >
            Both frames
          </a>
        </nav>
      </details>
      )}

      <PhoneHeader brand="Moolam" />
      {content}
      <BottomBar
        tabs={drawing === "b" ? RAISED_TABS : TABS}
        label="Sections"
        shape={drawing === "b" ? "raised" : "flat"}
        at={PAGE_ROUTE[page]}
        film={page === "home"}
      />
    </div>
  );
}

/**
 * What happens to the bar while the film is playing.
 *
 * On the home page the bar reads the number the scene writes as the film
 * closes, so it is gone while the story is being scrolled and arrives with the
 * closing card and the footer. The still cut in the frames has no scene to
 * write it, so this writes it by hand and gives the bar a small window of its
 * own to be fixed inside.
 */
function FilmNote({ playing, onPlay }: { playing: boolean; onPlay: (next: boolean) => void }) {
  return (
    <div className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-4 border border-line bg-bg-raised px-5 py-4">
      {playing && <div data-story="film" hidden />}
      <p className="max-w-[44ch] text-sm leading-relaxed text-text-muted">
        The film owns the whole window, so the bar rides the story&rsquo;s own closing signal: gone while the story is
        being scrolled, back with the closing card and the footer. Switch the film on and drag the last beat in.
      </p>
      <label className="flex items-center gap-3 font-mono text-[11px] uppercase tracking-[0.18em] text-text-faint">
        <input type="checkbox" checked={playing} onChange={(event) => onPlay(event.target.checked)} />
        The film is running
      </label>
      <input
        type="range"
        min={0}
        max={100}
        defaultValue={0}
        aria-label="How far the closing card has come in"
        onChange={(event) => {
          progress.close = Number(event.target.value) / 100;
        }}
        className="h-[44px] w-[200px]"
      />

      <div
        className="relative h-[110px] w-[280px] overflow-hidden border border-line bg-bg"
        style={{ transform: "translateZ(0)" }}
      >
        <p className="px-4 pt-4 font-mono text-[10px] uppercase tracking-[0.2em] text-text-faint">
          The bar, following the film
        </p>
        <BottomBar tabs={TABS} label="The bar following the film" shape="flat" at="/" film />
      </div>
    </div>
  );
}

function Measurements({ phone }: { phone: string }) {
  const rows = [
    ["Bar height", `${BAR_HEIGHT} px, with the phone's own home indicator strip under it`],
    ["Smallest target", `${BAR_HEIGHT} px tall by 72 to 75 px wide at ${phone}, and the raised disc is 56 across`],
    ["Room left under the page", BAR_ROOM],
    ["Docs", "keep the bar and light no tab. The benches draw no bar at all."],
  ];

  return (
    <dl className="mt-20 grid gap-px border border-line bg-line sm:grid-cols-2">
      {rows.map(([label, value]) => (
        <div key={label} className="bg-bg p-6">
          <dt className="font-mono text-[10px] uppercase tracking-[0.2em] text-text-faint">{label}</dt>
          <dd className="mt-2 text-sm leading-relaxed text-text">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** A row of chips, each one an address, because the page in the frames is rendered on the server. */
function Choice({
  label,
  options,
  chosen,
}: {
  label: string;
  options: { word: string; href: string }[];
  chosen: string;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-text-faint">{label}</span>
      {options.map((option) => (
        <a
          key={option.word}
          href={option.href}
          aria-current={option.word === chosen ? "page" : undefined}
          className={`tap rounded-[8px] border px-3 py-2 font-mono text-[10px] uppercase tracking-[0.16em] transition-colors duration-200 ${
            option.word === chosen
              ? "border-accent text-accent"
              : "border-line text-text-faint hover:border-accent hover:text-accent"
          }`}
        >
          {option.word}
        </a>
      ))}
    </div>
  );
}
