"use client";

import { AnimatePresence, motion, useReducedMotion, useScroll, useTransform } from "framer-motion";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Wordmark } from "@/components/wordmark";
import { Arrow, PRIMARY_BUTTON, ProblemNote } from "./bits";
import { Celebration } from "./celebration";
import { ChoosePanel } from "./choose-panel";
import { CosignWait } from "./cosign-wait";
import { cosignLink, moolamOrigin, passportLink } from "./moolam-links";
import { MoveFlow } from "./move-flow";
import { NotHere } from "./not-here";
import { PassportPanel } from "./passport-panel";
import { failureWords, readPicture, type PictureView } from "./picture-api";
import { PictureFrame } from "./picture-frame";
import { isRegisteredHint } from "./window-flow";

/** Often enough that a landed passport shows within seconds, rarely enough to be no load on Dreamloom's server. */
export const POLL_MS = 5_000;

type Load =
  | { kind: "loading" }
  | { kind: "missing" }
  | { kind: "error"; words: string }
  | { kind: "ready"; picture: PictureView };

const WAITING = new Set(["cosign-open", "cosign-signed"]);
const LANDED = new Set(["registered", "moved"]);

export function ResultScreen({ id, moolamSite, ownOrigin }: { id: string; moolamSite: string; ownOrigin: string }) {
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [note, setNote] = useState<string | null>(null);
  const [blocked, setBlocked] = useState(false);
  const [checkedAt, setCheckedAt] = useState<number | null>(null);
  const [celebrate, setCelebrate] = useState(0);
  const lastState = useRef<string | null>(null);
  const reading = useRef(false);

  const refresh = useCallback(async () => {
    if (reading.current) return;
    reading.current = true;
    const answer = await readPicture(id);
    reading.current = false;
    setCheckedAt(Date.now());
    if (answer.kind === "ready") {
      const before = lastState.current;
      lastState.current = answer.picture.state;
      // Only a passport that lands while the visitor is here gets the burst, not one found on a later visit.
      if (before !== null && !LANDED.has(before) && LANDED.has(answer.picture.state)) setCelebrate((count) => count + 1);
      if (answer.picture.state === "moved" && before === "registered") setCelebrate((count) => count + 1);
      // A new step changes the heading and stamps the picture, both at the top, where a phone may not be looking.
      if (before !== null && before !== answer.picture.state) {
        const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        window.scrollTo({ top: 0, behavior: still ? "auto" : "smooth" });
      }
      setNote(null);
      setLoad({ kind: "ready", picture: answer.picture });
      return;
    }
    if (answer.kind === "missing") {
      setLoad({ kind: "missing" });
      return;
    }
    // A failed check while the picture is already shown keeps the picture and says the check failed.
    setLoad((current) => (current.kind === "ready" ? current : answer));
    setNote(answer.words);
  }, [id]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const changed = useCallback(() => void refresh(), [refresh]);

  const state = load.kind === "ready" ? load.picture.state : null;
  const waiting = state !== null && WAITING.has(state);
  const origin = moolamOrigin(moolamSite);

  useEffect(() => {
    if (!waiting) return;
    const timer = window.setInterval(() => void refresh(), POLL_MS);
    const hear = (event: MessageEvent) => {
      if (isRegisteredHint(event, origin)) void refresh();
    };
    const back = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    window.addEventListener("message", hear);
    document.addEventListener("visibilitychange", back);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("message", hear);
      document.removeEventListener("visibilitychange", back);
    };
  }, [waiting, origin, refresh]);

  return (
    <div className="relative isolate overflow-clip">
      <Clouds />
      <Nav />
      {load.kind === "missing" ? (
        <NotHere />
      ) : (
        <main className="mx-auto grid max-w-[88rem] gap-8 px-5 pt-4 pb-20 sm:px-10 sm:pt-10 sm:pb-28 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.08fr)] lg:gap-16">
          <div className="lg:sticky lg:top-8 lg:self-start">
            {load.kind === "ready" ? (
              <div className="relative">
                <PictureFrame
                  id={id}
                  prompt={load.picture.prompt}
                  waiting={waiting}
                  passportHref={
                    load.picture.passportId === undefined ? null : passportLink(moolamSite, load.picture.passportId)
                  }
                />
                <AnimatePresence>{celebrate > 0 && <Celebration key={celebrate} />}</AnimatePresence>
              </div>
            ) : (
              <div className="rounded-[1.75rem] bg-card p-2.5 ring-1 ring-ink/5">
                <div className="shimmer aspect-square rounded-[1.35rem]" />
              </div>
            )}
            {load.kind === "ready" && (
              <motion.p
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.5, duration: 0.6 }}
                className="mt-5 line-clamp-3 px-2 text-base text-ink-soft"
              >
                <span className="font-semibold text-ink">Woven from </span>
                &ldquo;{load.picture.prompt}&rdquo;
              </motion.p>
            )}
          </div>

          <div className="min-w-0">
            {load.kind === "loading" && <LoadingSide />}
            {load.kind === "error" && <ErrorSide words={load.words} onRetry={() => void refresh()} />}
            {load.kind === "ready" && (
              <ReadySide
                id={id}
                picture={load.picture}
                moolamSite={moolamSite}
                ownOrigin={ownOrigin}
                blocked={blocked}
                checkedAt={checkedAt}
                note={note}
                onCosignOpened={setBlocked}
                onChanged={changed}
              />
            )}
          </div>
        </main>
      )}
    </div>
  );
}

function ReadySide({
  id,
  picture,
  moolamSite,
  ownOrigin,
  blocked,
  checkedAt,
  note,
  onCosignOpened,
  onChanged,
}: {
  id: string;
  picture: PictureView;
  moolamSite: string;
  ownOrigin: string;
  blocked: boolean;
  checkedAt: number | null;
  note: string | null;
  onCosignOpened: (blocked: boolean) => void;
  onChanged: () => void;
}) {
  const heading = HEADINGS[picture.state];
  const canMove = picture.state === "registered" && picture.mode === "platform";

  return (
    <div>
      <Heading key={picture.state} kicker={heading.kicker} lead={heading.lead} glow={heading.glow} line={heading.line} />
      <div className="mt-8 sm:mt-10">
        {picture.state === "woven" && (
          <ChoosePanel
            id={id}
            prompt={picture.prompt}
            moolamSite={moolamSite}
            onCosignOpened={onCosignOpened}
            onChanged={onChanged}
          />
        )}
        {WAITING.has(picture.state) && (
          <CosignWait
            signed={picture.state === "cosign-signed"}
            link={cosignLink(picture.cosignUrl, moolamSite)}
            blocked={blocked}
            checkedAt={checkedAt}
            title={picture.title}
          />
        )}
        {LANDED.has(picture.state) && (
          <PassportPanel picture={picture} moolamSite={moolamSite}>
            {canMove ? <MoveFlow id={id} moolamSite={moolamSite} ownOrigin={ownOrigin} onChanged={onChanged} /> : undefined}
          </PassportPanel>
        )}
        {picture.state === "failed" && <FailedPanel failure={picture.failure} />}
      </div>
      {note !== null && (
        <div role="status" className="mt-5">
          <ProblemNote>{note}</ProblemNote>
        </div>
      )}
    </div>
  );
}

const HEADINGS: Record<PictureView["state"], { kicker: string; lead: string; glow: string; line: string }> = {
  woven: {
    kicker: "Freshly woven",
    lead: "Your dream,",
    glow: "woven.",
    line: "Give it a Moolam passport: a public record of who made it and how AI may use it.",
  },
  "cosign-open": {
    kicker: "One step left",
    lead: "Now sign it",
    glow: "on Moolam.",
    line: "Sign on Moolam's page. This page moves on by itself when the passport lands.",
  },
  "cosign-signed": {
    kicker: "Almost there",
    lead: "Now sign it",
    glow: "on Moolam.",
    line: "Dreamloom has signed its part. Your passkey signature is the last one.",
  },
  registered: {
    kicker: "Passport issued",
    lead: "It has a",
    glow: "passport.",
    line: "Anyone can now check who made this picture and how AI may use it.",
  },
  moved: {
    kicker: "Passport moved",
    lead: "It is",
    glow: "yours now.",
    line: "The passport sits in your own Moolam account.",
  },
  failed: {
    kicker: "Something snagged",
    lead: "The loom",
    glow: "snagged.",
    line: "This picture did not get its passport here.",
  },
};

function Heading({ kicker, lead, glow, line }: { kicker: string; lead: string; glow: string; line: string }) {
  return (
    <motion.div initial="hidden" animate="shown" transition={{ staggerChildren: 0.1 }}>
      <motion.p
        variants={{ hidden: { opacity: 0, y: 16 }, shown: { opacity: 1, y: 0 } }}
        className="text-sm font-bold tracking-[0.14em] text-violet uppercase"
      >
        {kicker}
      </motion.p>
      <h1
        className="mt-3 font-display text-[clamp(2.75rem,7vw,6.5rem)] leading-[0.9] font-extrabold tracking-[-0.05em] text-ink"
        style={{ fontVariationSettings: '"opsz" 96, "wdth" 86' }}
      >
        <motion.span
          variants={{ hidden: { opacity: 0, y: 28 }, shown: { opacity: 1, y: 0 } }}
          transition={{ duration: 0.8, ease: [0.22, 1, 0.36, 1] }}
          className="block"
        >
          {lead}
        </motion.span>
        <motion.span
          variants={{ hidden: { opacity: 0, y: 28 }, shown: { opacity: 1, y: 0 } }}
          transition={{ duration: 0.8, ease: [0.22, 1, 0.36, 1] }}
          className="text-daybreak block pr-[0.04em] pb-[0.06em] sm:pl-[0.6em]"
        >
          {glow}
        </motion.span>
      </h1>
      <motion.p
        variants={{ hidden: { opacity: 0, y: 16 }, shown: { opacity: 1, y: 0 } }}
        className="mt-5 max-w-[36rem] text-lg text-ink-soft"
      >
        {line}
      </motion.p>
    </motion.div>
  );
}

function FailedPanel({ failure }: { failure: string | undefined }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 24 }}
      animate={{ opacity: 1, y: 0 }}
      className="rounded-[2rem] bg-card/95 p-5 shadow-[0_30px_70px_-40px_rgba(23,18,43,0.45)] ring-1 ring-ink/5 sm:p-8"
    >
      <p className="text-lg text-ink">{failureWords(failure)}</p>
      <a href="/" className={`${PRIMARY_BUTTON} mt-6 sm:w-auto`}>
        Weave another
        <Arrow />
      </a>
    </motion.div>
  );
}

function LoadingSide() {
  return (
    <div role="status" className="space-y-4">
      <p className="text-base font-semibold text-ink-soft">Fetching your picture...</p>
      <div aria-hidden className="shimmer h-20 w-4/5 rounded-2xl" />
      <div aria-hidden className="shimmer h-20 w-3/5 rounded-2xl" />
      <div aria-hidden className="shimmer mt-8 h-72 rounded-[2rem]" />
    </div>
  );
}

function ErrorSide({ words, onRetry }: { words: string; onRetry: () => void }) {
  return (
    <div className="rounded-[2rem] border-2 border-dashed border-ink/15 bg-card/70 px-6 py-10 sm:px-10">
      <p className="font-display text-2xl font-bold text-ink sm:text-3xl">Your picture did not load.</p>
      <p className="mt-3 max-w-[36rem] text-base text-ink-soft">{words}</p>
      <button
        type="button"
        onClick={onRetry}
        className="mt-6 min-h-12 cursor-pointer rounded-full bg-ink px-6 py-3 text-base font-semibold text-white transition hover:-translate-y-0.5 hover:bg-violet focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-violet"
      >
        Try again
      </button>
    </div>
  );
}

function Nav() {
  return (
    <motion.nav
      initial={{ opacity: 0, y: -12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
      className="mx-auto flex max-w-[88rem] items-center justify-between gap-4 px-5 pt-5 sm:px-10 sm:pt-7"
    >
      <a href="/" className="rounded-full transition-opacity hover:opacity-75">
        <Wordmark />
      </a>
      <NavLink href="/">Weave another</NavLink>
    </motion.nav>
  );
}

function NavLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      className="inline-flex min-h-11 items-center rounded-full border-2 border-ink/10 bg-card/70 px-4 py-2 text-sm font-semibold text-ink backdrop-blur transition hover:-translate-y-0.5 hover:border-violet hover:text-violet"
    >
      {children}
    </a>
  );
}

/** The home screen's colour clouds, drifting a little slower here so the picture stays the loudest thing. */
function Clouds() {
  const still = useReducedMotion() ?? false;
  const { scrollY } = useScroll();
  const far = useTransform(scrollY, [0, 900], [0, still ? 0 : 120]);
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 -z-10">
      <motion.div style={{ y: far }} className="absolute inset-0">
        <div className="dream-cloud absolute -top-40 -left-40 size-[34rem] rounded-full bg-violet/20 blur-3xl" />
        <div className="dream-cloud absolute top-20 right-[-14rem] size-[34rem] rounded-full bg-tangerine/15 blur-3xl" />
        <div className="dream-cloud absolute top-[38rem] left-1/4 size-[28rem] rounded-full bg-sun/30 blur-3xl" />
      </motion.div>
    </div>
  );
}
