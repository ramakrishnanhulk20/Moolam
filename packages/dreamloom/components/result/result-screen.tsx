"use client";

import { AnimatePresence, motion, useReducedMotion, useScroll, useTransform } from "framer-motion";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { AccountChip } from "@/components/account/account-chip";
import { Wordmark } from "@/components/wordmark";
import { Arrow, PRIMARY_BUTTON, ProblemNote } from "./bits";
import { Celebration } from "./celebration";
import { CheckoutOverlay } from "./checkout-card";
import { ChoosePanel } from "./choose-panel";
import { CosignWait } from "./cosign-wait";
import { cosignLink, moolamOrigin, passportLink } from "./moolam-links";
import { MoveFlow } from "./move-flow";
import { NotHere } from "./not-here";
import { PassportPanel } from "./passport-panel";
import { failureWords, readPicture, readRemembered, type PictureView } from "./picture-api";
import { PictureFrame } from "./picture-frame";
import { RememberAddress } from "./remember-address";
import { checkout, takeAnswer } from "./window-flow";

/** Often enough that a landed passport shows within seconds, rarely enough to be no load on Dreamloom's server. */
export const POLL_MS = 5_000;

type Load =
  | { kind: "loading" }
  | { kind: "missing" }
  | { kind: "error"; words: string }
  | { kind: "ready"; picture: PictureView };

/** How long a passport held under an email is watched for its claim, counted from when this page first saw it waiting. */
export const CLAIM_WATCH_MS = 15 * 60_000;

const WAITING = new Set(["cosign-open", "cosign-signed"]);
const LANDED = new Set(["registered", "moved"]);

/** A passport Dreamloom registered and sent to an email: the person may claim it at Moolam in another tab at any moment. */
export function waitsForClaim(picture: Pick<PictureView, "state" | "delivery">): boolean {
  return picture.state === "registered" && picture.delivery?.kind === "waiting";
}

export interface WatchClock {
  set: (run: () => void, ms: number) => unknown;
  clear: (timer: unknown) => void;
  now: () => number;
}

export interface WatchPage {
  visibilityState: string;
  addEventListener: (type: "visibilitychange", listener: () => void) => void;
  removeEventListener: (type: "visibilitychange", listener: () => void) => void;
}

/**
 * Re-reads the picture every POLL_MS until CLAIM_WATCH_MS has passed, so a claim made at Moolam shows
 * without a reload. A person who comes back to the tab gets one read at once, even after the timed
 * watch has ended, because that is one request, not a load. The returned function ends both.
 */
export function watchForClaim(read: () => void, clock: WatchClock, page: WatchPage): () => void {
  const startedAt = clock.now();
  const timer = clock.set(() => {
    read();
    if (clock.now() - startedAt >= CLAIM_WATCH_MS) clock.clear(timer);
  }, POLL_MS);
  const back = () => {
    if (page.visibilityState === "visible") read();
  };
  page.addEventListener("visibilitychange", back);
  return () => {
    clock.clear(timer);
    page.removeEventListener("visibilitychange", back);
  };
}

const BROWSER_CLOCK: WatchClock = {
  set: (run, ms) => window.setInterval(run, ms),
  clear: (timer) => window.clearInterval(timer as number),
  now: () => Date.now(),
};

export function ResultScreen({ id, moolamSite, ownOrigin }: { id: string; moolamSite: string; ownOrigin: string }) {
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [note, setNote] = useState<string | null>(null);
  /** Set while Moolam's co-sign window is open from this visit, with whether the browser refused it. */
  const [signWindow, setSignWindow] = useState<{ blocked: boolean } | null>(null);
  const [checkedAt, setCheckedAt] = useState<number | null>(null);
  const [celebrate, setCelebrate] = useState(0);
  /** The address this session asked Dreamloom to send later pictures to, or null. */
  const [remembered, setRemembered] = useState<string | null>(null);
  /** Words for a picture that got its passport while the move to the remembered address did not follow. */
  const [claimSnag, setClaimSnag] = useState<string | null>(null);
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

  useEffect(() => {
    let live = true;
    void readRemembered().then((address) => {
      if (live) setRemembered(address);
    });
    return () => {
      live = false;
    };
  }, []);

  const changed = useCallback(() => void refresh(), [refresh]);

  const state = load.kind === "ready" ? load.picture.state : null;
  const waiting = state !== null && WAITING.has(state);
  const claimPending = load.kind === "ready" && waitsForClaim(load.picture);
  const origin = moolamOrigin(moolamSite);
  const signLink = load.kind === "ready" ? cosignLink(load.picture.cosignUrl, moolamSite) : null;

  // Moolam's window shuts itself once the AI-use terms are written. Closing it here as soon as the
  // store says registered can cut off the person's second transaction, the AI-use terms.
  useEffect(() => {
    if (state === null || waiting) return;
    setSignWindow(null);
  }, [state, waiting]);

  const reopenSign = useCallback(() => {
    if (signLink === null) return;
    setSignWindow({ blocked: checkout.reopen(signLink) === "blocked" });
  }, [signLink]);

  const cancelSign = useCallback(() => {
    checkout.close();
    setSignWindow(null);
  }, []);

  useEffect(() => {
    if (!waiting) return;
    const timer = window.setInterval(() => void refresh(), POLL_MS);
    const hear = (event: MessageEvent) => {
      if (takeAnswer(event, origin, "sign", checkout) === null) return;
      setSignWindow(null);
      void refresh();
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

  useEffect(() => {
    if (!claimPending) return;
    return watchForClaim(() => void refresh(), BROWSER_CLOCK, document);
  }, [claimPending, refresh]);

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
                checkedAt={checkedAt}
                note={note}
                remembered={remembered}
                claimSnag={claimSnag}
                onRemembered={setRemembered}
                onClaimSnag={setClaimSnag}
                onCosignOpened={(blocked) => setSignWindow({ blocked })}
                onReopenSign={reopenSign}
                onChanged={changed}
              />
            )}
          </div>
        </main>
      )}
      <CheckoutOverlay
        open={signWindow !== null && waiting}
        place="sign"
        link={signLink}
        blocked={signWindow?.blocked ?? false}
        onReopen={reopenSign}
        onCancel={cancelSign}
      />
    </div>
  );
}

function ReadySide({
  id,
  picture,
  moolamSite,
  ownOrigin,
  checkedAt,
  note,
  remembered,
  claimSnag,
  onRemembered,
  onClaimSnag,
  onCosignOpened,
  onReopenSign,
  onChanged,
}: {
  id: string;
  picture: PictureView;
  moolamSite: string;
  ownOrigin: string;
  checkedAt: number | null;
  note: string | null;
  remembered: string | null;
  claimSnag: string | null;
  onRemembered: (address: string | null) => void;
  onClaimSnag: (words: string) => void;
  onCosignOpened: (blocked: boolean) => void;
  onReopenSign: () => void;
  onChanged: () => void;
}) {
  const heading = picture.state === "registered" && picture.mode === "platform" ? HELD : HEADINGS[picture.state];
  const canMove = picture.state === "registered" && picture.mode === "platform";
  const waitsByEmail = picture.state === "registered" && picture.delivery?.kind === "waiting";
  // A passport that went straight to the person's Moolam account needs no offer to remember an address.
  const claimedTo = picture.state === "moved" && picture.delivery?.kind !== "straight" ? picture.movedTo : undefined;

  return (
    <div>
      <Heading key={picture.state} kicker={heading.kicker} lead={heading.lead} glow={heading.glow} line={heading.line} />
      <div className="mt-8 sm:mt-10">
        {picture.state === "woven" && (
          <ChoosePanel
            id={id}
            prompt={picture.prompt}
            moolamSite={moolamSite}
            remembered={remembered}
            onRemembered={onRemembered}
            onCosignOpened={onCosignOpened}
            onClaimSnag={onClaimSnag}
            onChanged={onChanged}
          />
        )}
        {WAITING.has(picture.state) && (
          <CosignWait
            signed={picture.state === "cosign-signed"}
            canReopen={cosignLink(picture.cosignUrl, moolamSite) !== null}
            checkedAt={checkedAt}
            title={picture.title}
            onReopen={onReopenSign}
          />
        )}
        {LANDED.has(picture.state) && (
          <PassportPanel picture={picture} moolamSite={moolamSite}>
            {canMove ? (
              <MoveFlow id={id} moolamSite={moolamSite} ownOrigin={ownOrigin} waitsByEmail={waitsByEmail} onChanged={onChanged} />
            ) : claimedTo !== undefined ? (
              <RememberAddress address={claimedTo} remembered={remembered} onRemembered={onRemembered} />
            ) : undefined}
          </PassportPanel>
        )}
        {canMove && claimSnag !== null && (
          <div role="status" className="mt-5">
            <ProblemNote>{claimSnag}</ProblemNote>
          </div>
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
    line: "Give it a Moolam passport: a public record that credits you, the person who imagined it, and says how AI may use it.",
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
    line: "Anyone can now check that you imagined this picture and how AI may use it.",
  },
  moved: {
    kicker: "Passport claimed",
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

/** A passport Dreamloom registered sits in Dreamloom's wallet, so it never reads as the visitor's own until they claim it. */
const HELD = {
  kicker: "Passport issued",
  lead: "Held until",
  glow: "you claim it.",
  line: "Dreamloom holds this passport for you until you claim it into your own Moolam account.",
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
      className="mx-auto flex max-w-[88rem] flex-wrap items-center justify-between gap-x-4 gap-y-3 px-5 pt-5 sm:px-10 sm:pt-7"
    >
      <a href="/" className="rounded-full transition-opacity hover:opacity-75">
        <Wordmark />
      </a>
      <AccountChip />
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
