"use client";

import { useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { GuideCards } from "@/components/guide/GuideCards";
import { GuideWalk } from "@/components/guide/GuideWalk";
import { ShowGuideAgain } from "@/components/guide/ShowGuideAgain";
import {
  RETURNING_KEY,
  forgetGuideSeen,
  guideSeen,
  guideShouldShow,
  markGuideSeen,
  signedInBefore,
} from "@/components/guide/seen";
import type { GuideStep } from "@/components/guide/steps";
import { Reveal } from "@/components/lab/sponsors/Reveal";
import { Surface } from "@/components/lab/sponsors/Surface";
import { StillHome } from "./StillHome";

type Width = "desktop" | "phone";
type Where = "frame" | "window" | null;

/**
 * The two marks as one short string, "10" for seen and never signed in.
 *
 * A primitive rather than an object because useSyncExternalStore compares what
 * it is handed by identity: a fresh object every render would never settle.
 */
function readKeys(): string {
  return `${guideSeen() ? "1" : "0"}${signedInBefore() ? "1" : "0"}`;
}

const keyWatchers = new Set<() => void>();

function watchKeys(listener: () => void): () => void {
  keyWatchers.add(listener);
  // Another tab writing the same keys counts too, which is the only change this
  // page cannot cause itself.
  window.addEventListener("storage", listener);
  return () => {
    keyWatchers.delete(listener);
    window.removeEventListener("storage", listener);
  };
}

function tellKeyWatchers(): void {
  for (const listener of keyWatchers) {
    listener();
  }
}

/**
 * The guide bench: the same three things drawn two ways, over a stand-in for
 * the home page, so Ram can pick one.
 *
 * Every control here is a switch on the drawing, never a fake state on the
 * product: the flags panel at the bottom reads and writes the real keys this
 * device carries.
 */
export function GuideBench() {
  const [width, setWidth] = useState<Width>("desktop");
  const [returning, setReturning] = useState(false);
  const [cards, setCards] = useState<Where>(null);
  const [walk, setWalk] = useState<Where>(null);
  const [went, setWent] = useState<string | null>(null);

  const cardsFrame = useRef<HTMLDivElement>(null);
  const walkFrame = useRef<HTMLDivElement>(null);

  const open = (set: (where: Where) => void, frame: HTMLDivElement | null, where: Exclude<Where, null>) => {
    if (frame !== null) {
      // The spotlight points at the header inside the frame, so the frame has
      // to be on screen before the window is covered, and clear of the app's
      // own sticky bar: centred, the frame header sits behind it and the light
      // falls on the real header instead of the drawing of one.
      window.scrollTo({ top: frame.getBoundingClientRect().top + window.scrollY - 130, behavior: "auto" });
    }
    setWent(null);
    set(where);
  };

  const took = (step: GuideStep) => {
    setWent(`Pressed "${step.action}". On the real page this goes to ${step.href} and the guide closes.`);
  };

  return (
    <Surface>
      <div className="px-5 pb-32 pt-10 sm:px-8 lg:px-14">
        <header className="mx-auto w-full max-w-[100rem]">
          <Reveal>
            <p className="flex items-center gap-3 font-mono text-[11px] uppercase tracking-[0.24em] text-accent">
              <span className="motif h-[9px] w-[9px]" />
              Guide bench
            </p>
          </Reveal>

          <Reveal delay={0.08}>
            <h1 className="mt-7 max-w-[15ch] font-display text-[clamp(3rem,10vw,9rem)] font-semibold uppercase leading-[0.85] tracking-[-0.055em]">
              Where do I even look?
            </h1>
          </Reveal>

          <Reveal delay={0.16}>
            <p className="mt-10 max-w-[62ch] text-base leading-relaxed text-text-muted">
              Somebody lands on Moolam for the first time and the film tells them what this is, beautifully, without
              once saying which of the six words in the header they should press. This is the fix, drawn twice: three
              cards on one screen, and a three step walk with the light on the real thing. Both are shown here over a
              stand-in for the home page. Nothing on the real screens has changed.
            </p>
          </Reveal>

          <Reveal delay={0.24}>
            <div className="mt-10 flex flex-wrap items-center gap-x-8 gap-y-4 border-y border-line py-4">
              <Switch
                label="Window"
                options={[
                  { id: "desktop", label: "1440 x 900" },
                  { id: "phone", label: "375 x 812" },
                ]}
                value={width}
                onPick={(id) => setWidth(id as Width)}
              />
              <Switch
                label="Header"
                options={[
                  { id: "new", label: "First visit" },
                  { id: "returning", label: "Signed in before" },
                ]}
                value={returning ? "returning" : "new"}
                onPick={(id) => setReturning(id === "returning")}
              />
              <p className="max-w-[42ch] font-mono text-[10px] uppercase leading-[1.5] tracking-[0.14em] text-text-faint">
                My pictures only appears for a device that has signed in, which a first visit is not
              </p>
            </div>
          </Reveal>
        </header>

        <div className="mx-auto mt-24 flex w-full max-w-[100rem] flex-col gap-28 lg:mt-32 lg:gap-40">
          <Act
            number="A"
            title="Three cards, one screen"
            caption="Everything at once, along the bottom, with the page still playing behind the blur. One read, one choice, gone. Escape or a press on the ground closes it and the device is marked."
          >
            <Controls
              onOpen={(where) => open(setCards, cardsFrame.current, where)}
              onClose={() => setCards(null)}
              open={cards}
            />
            <Frame ref={cardsFrame} width={width}>
              <StillHome width={width} returning={returning} />
              <GuideCards
                open={cards !== null}
                stage={cards === "window" ? "window" : "frame"}
                onClose={() => setCards(null)}
                onGo={took}
              />
            </Frame>
          </Act>

          <Act
            number="B"
            title="A three step walk"
            caption="One at a time, with a hole cut in the dim over the thing being named, so the words point at something real instead of describing it. Next, Skip, and a dot row. Escape closes it."
          >
            <Controls
              onOpen={(where) => open(setWalk, walkFrame.current, where)}
              onClose={() => setWalk(null)}
              open={walk}
            />
            <Frame ref={walkFrame} width={width}>
              <StillHome width={width} returning={returning} />
              <GuideWalk
                open={walk !== null}
                stage={walk === "window" ? "window" : "frame"}
                onClose={() => setWalk(null)}
                scope={walkFrame}
              />
            </Frame>
          </Act>

          <Act
            number="C"
            title="The rule, and the way back"
            caption="Who sees it and who never does, read from this device as it stands right now. The entry belongs in the footer, beside Privacy and Terms, and it forgets the mark and opens the guide on the spot."
          >
            <Flags onShow={() => setCards("window")} />
          </Act>
        </div>

        {went === null ? null : (
          <p
            role="status"
            className="fixed bottom-6 left-1/2 z-[80] -translate-x-1/2 rounded-[8px] border border-accent bg-[color:var(--bg-raised)] px-5 py-3 text-sm text-text"
          >
            {went}
          </p>
        )}
      </div>
    </Surface>
  );
}

function Frame({
  ref,
  width,
  children,
}: {
  ref: React.RefObject<HTMLDivElement | null>;
  width: Width;
  children: ReactNode;
}) {
  return (
    <div
      ref={ref}
      className={`relative mt-8 overflow-hidden rounded-[8px] border border-line-strong ${
        width === "phone" ? "h-[812px] w-[375px] max-w-full" : "aspect-[1440/900] w-full"
      }`}
    >
      {children}
    </div>
  );
}

function Controls({
  open,
  onOpen,
  onClose,
}: {
  open: Where;
  onOpen: (where: Exclude<Where, null>) => void;
  onClose: () => void;
}) {
  return (
    <div className="mt-8 flex flex-wrap items-center gap-2">
      <Press onClick={() => onOpen("frame")} strong={open === "frame"}>
        Play it in the frame
      </Press>
      <Press onClick={() => onOpen("window")} strong={open === "window"}>
        Over the whole window
      </Press>
      <Press onClick={onClose}>Close</Press>
      <span className="ml-2 font-mono text-[10px] uppercase tracking-[0.16em] text-text-faint">
        the window mode is the real one: it holds the page still
      </span>
    </div>
  );
}

/**
 * The two keys that decide everything, read from this browser.
 *
 * Read through useSyncExternalStore so the server's answer is used for the
 * render being hydrated and the real one lands straight after, which is how the
 * rest of the app reads anything only a browser knows.
 */
function Flags({ onShow }: { onShow: () => void }) {
  const mark = useSyncExternalStore(watchKeys, readKeys, () => "??");
  const state = mark === "??" ? null : { seen: mark[0] === "1", returning: mark[1] === "1" };

  const write = (change: () => void) => {
    change();
    tellKeyWatchers();
  };

  const verdict =
    state === null
      ? null
      : guideShouldShow({ seen: state.seen, returning: state.returning, path: "/en" })
        ? "A first visit to the home page would get the guide."
        : "The guide would stay shut on the home page.";

  return (
    <div className="mt-10 grid gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:gap-16">
      <div>
        <dl className="grid gap-px border border-line bg-line">
          <Row label="moolam:guide:seen" value={state === null ? "reading" : state.seen ? "set" : "not set"} />
          <Row
            label="moolam:wallet:returning"
            value={state === null ? "reading" : state.returning ? "set" : "not set"}
          />
          <Row label="this page" value="a bench page, so never" />
        </dl>
        <p className="mt-5 text-sm leading-relaxed text-text-muted">{verdict}</p>

        <div className="mt-6 flex flex-wrap gap-2">
          <Press onClick={() => write(markGuideSeen)}>Mark as seen</Press>
          <Press onClick={() => write(forgetGuideSeen)}>Forget this device</Press>
          <Press
            onClick={() =>
              write(() => {
                try {
                  window.localStorage.setItem(RETURNING_KEY, "1");
                } catch {
                  // A browser that keeps nothing simply stays a new device.
                }
              })
            }
          >
            Pretend signed in
          </Press>
          <Press
            onClick={() =>
              write(() => {
                try {
                  window.localStorage.removeItem(RETURNING_KEY);
                } catch {
                  // Same again: nothing to undo on a browser that kept nothing.
                }
              })
            }
          >
            Pretend never signed in
          </Press>
        </div>
        <p className="mt-4 max-w-[52ch] text-[12px] leading-relaxed text-text-faint">
          The last two write the real wallet key on this browser, the one the header and the passport pages read. Press
          the fourth to put it back.
        </p>
      </div>

      <div className="border border-line p-6">
        <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-text-faint">As it would sit in the footer</p>
        <div className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-line pt-5 font-mono text-[11px] uppercase tracking-[0.16em] text-text-faint">
          <span>Privacy</span>
          <span>Terms</span>
          <ShowGuideAgain onOpen={onShow} />
        </div>
        <p className="mt-6 max-w-[48ch] text-sm leading-relaxed text-text-muted">
          Pressing it here forgets the mark on this device and opens drawing A over the whole window, which is exactly
          what it will do on the real footer.
        </p>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-6 bg-bg px-4 py-3">
      <dt className="font-mono text-[11px] tracking-[0.1em] text-text-faint">{label}</dt>
      <dd className="font-mono text-[11px] uppercase tracking-[0.16em] text-accent">{value}</dd>
    </div>
  );
}

function Press({ children, onClick, strong = false }: { children: ReactNode; onClick: () => void; strong?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`tap rounded-[8px] border px-4 py-2.5 font-mono text-[10px] uppercase tracking-[0.16em] transition-colors duration-200 ${
        strong
          ? "border-accent text-accent"
          : "border-line text-text-muted hover:border-accent hover:text-accent focus-visible:border-accent focus-visible:text-accent"
      }`}
    >
      {children}
    </button>
  );
}

function Switch({
  label,
  options,
  value,
  onPick,
}: {
  label: string;
  options: { id: string; label: string }[];
  value: string;
  onPick: (id: string) => void;
}) {
  return (
    <div className="flex items-center gap-3">
      <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-text-faint">{label}</span>
      <div className="flex items-center gap-1 rounded-[8px] border border-line p-1">
        {options.map((option) => (
          <button
            key={option.id}
            type="button"
            onClick={() => onPick(option.id)}
            className={`rounded-[6px] px-3 py-2 font-mono text-[10px] uppercase tracking-[0.16em] transition-colors duration-200 ${
              value === option.id ? "bg-accent text-accent-ink" : "text-text-faint hover:text-accent"
            }`}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function Act({
  number,
  title,
  caption,
  children,
}: {
  number: string;
  title: string;
  caption: string;
  children: ReactNode;
}) {
  return (
    <section>
      <Reveal>
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:gap-16">
          <div className="flex min-w-0 items-start gap-6">
            <span className="font-mono text-[11px] tracking-[0.2em] text-accent">{number}</span>
            <h2 className="max-w-[14ch] font-display text-[clamp(2rem,5vw,4.2rem)] font-semibold uppercase leading-[0.9] tracking-[-0.045em]">
              {title}
            </h2>
          </div>
          <p className="max-w-[54ch] text-sm leading-relaxed text-text-muted lg:mt-3">{caption}</p>
        </div>
      </Reveal>
      {children}
    </section>
  );
}
