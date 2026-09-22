"use client";

import { AdaptiveDpr, Preload, ScrollControls, useScroll } from "@react-three/drei";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { useReducedMotion } from "framer-motion";
import { useFormatter, useTranslations } from "next-intl";
import { Component, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import * as THREE from "three";
import { Copies, FocalPlate, PlateField, useField } from "@/components/story/scene/field";
import { fieldPictures } from "@/components/story/scene/order";
import { CloseCard } from "@/components/story/CloseCard";
import { HeroCredits } from "@/components/story/HeroCredits";
import { ScrollCue } from "@/components/story/ScrollCue";
import { StillStory } from "@/components/story/StillStory";
import { TryPanel } from "@/components/story/TryPanel";
import { pickSamples } from "@/lib/data/samples";
import {
  film,
  forwardTouchMove,
  forwardTouchStart,
  forwardWheel,
  keyReach,
  movePage,
  moveStory,
  probe,
  progress,
  scroller,
  whenRoom,
} from "@/components/story/signals";
import type { StoryData } from "@/components/story/data";
import { degradeSteps, measurement } from "@/components/story/measurements";
import { createTierState, nextTier, startTier, tierLevel } from "@/components/story/tier";
import {
  beatTable,
  captionCue,
  played,
  span,
  type Beat,
  type BeatName,
  type BeatTable,
  type Pose,
  type StoryVariant,
} from "@/components/story/beats";
import { InlineLedger, PlateLedger, type LedgerView } from "@/components/story/StatedLedger";
import { storyCut } from "@/components/story/stated";
import { fractionOf } from "@/components/consent/ledger";
import { shortHex } from "@/lib/chain/client";

/**
 * The camera, read off the beats table.
 *
 * Two poses per beat, blended with a smoothstep, then the camera eases toward
 * the blended point every frame so a fast scroll pulls the camera rather than
 * teleporting it. `framing` and `reach` are the phone's two corrections, applied
 * here so the table itself only ever describes the wide shot.
 */
function sampleKeys(
  keys: { at: number; pose: Pose }[],
  t: number,
  framing: number,
  reach: number,
  outPos: THREE.Vector3,
  outLook: THREE.Vector3,
) {
  const clamped = Math.min(1, Math.max(0, t));
  let a = keys[0];
  let b = keys[keys.length - 1];
  for (let index = 0; index < keys.length - 1; index += 1) {
    if (clamped >= keys[index].at && clamped <= keys[index + 1].at) {
      a = keys[index];
      b = keys[index + 1];
      break;
    }
  }
  const gap = b.at - a.at || 1;
  const raw = (clamped - a.at) / gap;
  const k = raw * raw * (3 - 2 * raw);
  outPos.set(
    a.pose.pos[0] + (b.pose.pos[0] - a.pose.pos[0]) * k,
    a.pose.pos[1] + (b.pose.pos[1] - a.pose.pos[1]) * k,
    (a.pose.pos[2] + (b.pose.pos[2] - a.pose.pos[2]) * k) * reach,
  );
  outLook.set(
    (a.pose.look[0] + (b.pose.look[0] - a.pose.look[0]) * k) * framing,
    a.pose.look[1] + (b.pose.look[1] - a.pose.look[1]) * k,
    a.pose.look[2] + (b.pose.look[2] - a.pose.look[2]) * k,
  );
}

function World({
  data,
  table,
  pictures,
  plateCount,
  particles,
  spread,
  framing,
  reach,
  credential,
  dropped,
  start,
  label,
  onTier,
}: {
  data: StoryData;
  /** The cut being played. Every offset, pose and page count below comes out of it. */
  table: BeatTable;
  pictures: string[];
  plateCount: number;
  spread: number;
  particles: number;
  /**
   * How far the shot pushes the plate off to one side, so the words have the
   * other. A phone stacks the words at the bottom of the frame instead, so it
   * takes almost none of it or the plate leaves the screen.
   */
  framing: number;
  /**
   * How much further back a phone stands. The phone frame is the top 45 percent
   * of the window rather than the whole of it, so this is the distance at which
   * a 1.7 unit plate fills that band without leaving it.
   */
  reach: number;
  credential: string;
  dropped: string | null;
  /** The tier this screen begins on, before any frame has been timed. */
  start: number;
  /** What a screen reader calls the film. It is a scrolling region of its own. */
  label: string;
  /** Called once per change, never per frame. */
  onTier: (tier: number) => void;
}) {
  const scroll = useScroll();
  const { camera } = useThree();
  const field = useField(plateCount, pictures, spread, table.beat.opening.arrive.pos);

  // The panels pinned over the scene sit outside this element, so they need a
  // handle on it to pass a wheel or a drag back to the story. The attribute is
  // what the overscroll rule in globals.css hangs on, and what a measurement
  // from outside the page can find the scroller by.
  //
  // The element drei builds is a bare div: it carries no name, nothing says it
  // scrolls, and the keys that drive a document went nowhere on it. The rest of
  // this is the story answering a keyboard the way the page around it does,
  // through the same scrollTop the wheel moves so the film keeps one source of
  // truth for where it is.
  useEffect(() => {
    const el = scroll.el;
    scroller.el = el;
    el.setAttribute("data-story-scroller", "true");
    el.setAttribute("tabindex", "0");
    el.setAttribute("role", "region");
    el.setAttribute("aria-label", label);

    const onKey = (event: KeyboardEvent) => {
      const reach = keyReach(
        event.key,
        event.shiftKey,
        {
          top: el.scrollTop,
          max: el.scrollHeight - el.clientHeight,
          height: window.innerHeight,
          pageTop: window.scrollY,
        },
        // One press is one beat of the cut being played, not of some other one.
        table.pages,
      );
      if (reach === null) {
        return;
      }
      // Tab and everything else is the browser's. These keys are the story's,
      // and the browser's own answer to them would move the same scroller a
      // second time.
      event.preventDefault();
      if (reach.story !== null) {
        moveStory(el, reach.story);
      }
      if (reach.page !== null) {
        movePage(reach.page);
      }
    };

    el.addEventListener("keydown", onKey);
    return () => {
      el.removeEventListener("keydown", onKey);
      scroller.el = null;
    };
  }, [label, scroll, table.pages]);

  const pos = useMemo(() => new THREE.Vector3(), []);
  const look = useMemo(() => new THREE.Vector3(), []);
  const smoothLook = useRef(new THREE.Vector3());

  const fade = useRef(1);
  const approach = useRef(0);
  const made = useRef(0);
  const sealed = useRef(0);
  const shared = useRef(0);
  const verified = useRef(0);
  const answer = useRef(0);
  const probing = useRef(0);

  // The tier controller lives in a ref: the frame times arrive sixty times a
  // second and only the handful of them that move the tier are worth a render.
  const tier = useRef(createTierState(start));
  useEffect(() => {
    tier.current = createTierState(start);
  }, [start]);

  useFrame(({ clock }, delta) => {
    const t = scroll.offset;
    const k = Math.min(1, delta * 3.2);
    const beat = table.beat;

    sampleKeys(table.cameraKeys, t, framing, reach, pos, look);
    camera.position.lerp(pos, k);
    smoothLook.current.lerp(look, k);
    camera.lookAt(smoothLook.current);

    approach.current = span(t, beat.opening.captionEnd, beat.made.start);
    made.current = played(t, beat.made);
    sealed.current = played(t, beat.sealed);
    shared.current = played(t, beat.shared, 0.85);
    verified.current = played(t, beat.verified, 0.85);

    // The field dims while the camera is in among one plate, and comes back up
    // for the last beat, which is about how many of them there are.
    fade.current =
      1 - 0.68 * span(t, beat.opening.captionEnd, beat.made.start) * (1 - span(t, beat.close.start, beat.close.start + 0.04));

    const offer = captionCue(t, beat.offer, table.fade).shown;
    probing.current = offer * (probe.state === "idle" ? 0.35 : 1);
    answer.current = probe.state === "matched" ? 1 : probe.state === "refused" ? 2 : verified.current > 0.98 ? 1 : 0;

    progress.scroll = t;
    progress.made = made.current;
    progress.sealed = sealed.current;
    // The rule has to be drawn and the four marks landed while the words are
    // still there to read, so this one runs over almost the whole caption.
    progress.stated = beat.stated === undefined ? 0 : played(t, beat.stated, 0.92);
    progress.shared = shared.current;
    progress.verified = verified.current;
    progress.trusted = played(t, beat.trusted);
    progress.offer = offer;
    progress.close = captionCue(t, beat.close, table.fade).shown;

    const measured = nextTier(tier.current, delta * 1000, clock.elapsedTime * 1000);
    if (measured.tier !== tier.current.tier) {
      onTier(measured.tier);
    }
    tier.current = measured;
  });

  return (
    <>
      <color attach="background" args={["#0B0B0C"]} />
      <fogExp2 attach="fog" args={["#0B0B0C", 0.052]} />

      <PlateField field={field} fade={fade} />
      <FocalPlate
        url={data.focal?.picture ?? null}
        dropped={dropped}
        particles={particles}
        edge={table.beat.stated !== undefined}
        refs={{ approach, made, sealed, verified, answer, probe: probing }}
      />
      <Copies
        focalUrl={data.focal?.picture ?? null}
        credentialText={credential}
        shared={shared}
        verified={verified}
        height={1.7}
      />
    </>
  );
}

/**
 * How much of the pinned screen the shot takes on a phone. The words own the
 * rest, and .story-lower in globals.css starts at exactly this fraction.
 */
const PHONE_BAND = 0.45;

/**
 * The same, on a phone too short for the words to fit under that.
 *
 * At 375x667 the longest chapters ran off the bottom of the screen in Tamil:
 * the agent card and its three lines put the trusted chapter 163 px past it.
 * The shot gives up nine per cent of the window there and the type in the band
 * steps down with it, which is the rule under this one in globals.css.
 */
const SHORT_PHONE_BAND = 0.36;

/** Under this many pixels of window height, a phone is a short one. */
const SHORT_SCREEN = 700;

/**
 * Keeps the shot in the top band of the window on a phone.
 *
 * The canvas fills the whole screen so the scroller built on it does too, which
 * is what gives a drag over the words the browser's own momentum. The renderer
 * is then told to draw into the band alone, with the band's own aspect, so the
 * picture is the same pixels it was when the canvas itself was the band. Below
 * the band nothing is drawn and the page's black shows through.
 *
 * It is set every frame rather than on a resize because a step in the adaptive
 * tier resizes the drawing buffer, and that hands the viewport back to the whole
 * canvas.
 */
function Band({ fraction }: { fraction: number }) {
  useFrame(({ gl, camera, size }) => {
    if (fraction >= 1) {
      return;
    }
    const height = Math.round(size.height * fraction);
    gl.setViewport(0, size.height - height, size.width, height);

    const lens = camera as THREE.PerspectiveCamera;
    const aspect = size.width / height;
    if (lens.aspect !== aspect) {
      lens.aspect = aspect;
      lens.updateProjectionMatrix();
    }
  });

  return null;
}

/** Whether this browser can open a WebGL context at all, asked before the canvas exists. */
function canDrawWebGL(): boolean {
  try {
    const probeCanvas = document.createElement("canvas");
    return Boolean(probeCanvas.getContext("webgl2") ?? probeCanvas.getContext("webgl"));
  } catch {
    return false;
  }
}

/**
 * The last line of defence around the scene. A context lost while the story is
 * building, or a shader a driver refuses, would otherwise take the whole first
 * screen down to black with the reason only in the console.
 */
class SceneBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

export interface StoryBeat {
  /** The beat in the table these words belong to. The table owns the timing and the side. */
  key: BeatName;
  body: ReactNode;
}

/**
 * The captions, written once and laid out twice: pinned over the scene, or
 * stacked down a still page for anyone who has asked for less motion. Every
 * figure in them comes out of the one record data.ts chose.
 */
function useBeats(data: StoryData, table: BeatTable, ledger: LedgerView | null, still: boolean): StoryBeat[] {
  const t = useTranslations("story");
  // The five plain summaries belong to the passport card. The film borrows them
  // rather than keeping a second set, so the beat and the card a judge opens
  // next say the same words in the same language.
  const says = useTranslations("passport.consent.summary");
  const format = useFormatter();

  // Every figure below leaves the one record data.ts chose, so a caption cannot
  // name an agent, a manifest or a re-check the passport page would then deny.
  const agentId = data.focal === null ? (data.agent?.id ?? null) : data.focal.agentId;
  const block = data.focal?.block ?? "";
  const registered =
    data.focal === null ? "" : format.dateTime(new Date(data.focal.registeredAt * 1000), { dateStyle: "long" });
  const measuredOn = format.dateTime(new Date(measurement.measuredAt), { dateStyle: "long" });

  // The new beat exists only where the cut carries it and the register really
  // answered for this passport. Everything it says is the statement's own.
  const stated: StoryBeat[] =
    table.beat.stated === undefined || ledger === null || data.statement === null
      ? []
      : [
          {
            key: "stated",
            body: (
              // The rule lies across the lower quarter of the frame, so the
              // words stand above it rather than through it. The still page has
              // no rule on the ground and no shot to clear, so nothing is
              // pulled up there and the chapter keeps the gap its neighbours have.
              <div className={still ? "" : "sm:-translate-y-[9vh]"}>
                <Eyebrow className="sm:justify-end">{t("stated.kicker")}</Eyebrow>
                {/* Balanced because this line is one short sentence the
                    chain wrote, and in Japanese or Tamil the browser's own
                    break left a single character alone on the second line. */}
                <Title className="text-balance sm:ms-auto sm:text-end">
                  {t("stated.title", { summary: says(data.statement.summary) })}
                </Title>
                <Body className="sm:ms-auto sm:text-end">{t("stated.body")}</Body>
                {/* The picture of it. On a phone it stacks here with the words,
                    under the shot; from 640 px up the pinned one lies along the
                    plate's own lower edge instead and this one is not drawn. On
                    the still page there is no scroll to draw it with and no
                    plate to lie on, so it is simply here, finished. */}
                <InlineLedger view={ledger} driven={!still} className={still ? "mt-8 ms-auto" : "mt-6 sm:hidden"} />
                <Readout className="sm:ms-auto sm:text-end">
                  {t("stated.readout", {
                    written: format.dateTime(new Date(data.statement.at * 1000), { dateStyle: "long" }),
                  })}
                </Readout>
              </div>
            ),
          },
        ];

  return [
    {
      key: "made",
      body:
        agentId === null ? (
          <>
            <Eyebrow>{t("made.kicker")}</Eyebrow>
            <Title>{t("made.titleNoAgent")}</Title>
            <Body>{t("made.bodyNoAgent")}</Body>
            <Readout>{t("made.readoutNoAgent")}</Readout>
          </>
        ) : (
          <>
            <Eyebrow>{t("made.kicker")}</Eyebrow>
            <Title>{t("made.title")}</Title>
            <Body>{t("made.body", { agent: agentId })}</Body>
            <Readout>{t("made.readout", { agent: agentId })}</Readout>
          </>
        ),
    },
    {
      key: "sealed",
      body: (
        <>
          <Eyebrow>{t("sealed.kicker")}</Eyebrow>
          <Title>{t("sealed.title")}</Title>
          <Body>{block === "" ? t("sealed.bodyNoBlock") : t("sealed.body", { block })}</Body>
          <Readout>
            {data.focal === null
              ? t("sealed.unread")
              : t("sealed.readout", { passport: shortHex(data.focal.id, 10, 8), date: registered })}
          </Readout>
        </>
      ),
    },
    ...stated,
    {
      key: "shared",
      body: (
        <>
          <Eyebrow className="sm:justify-end">{t("shared.kicker")}</Eyebrow>
          <Title className="sm:ms-auto sm:text-end">{t("shared.title")}</Title>
          <Body className="sm:ms-auto sm:text-end">{t("shared.body")}</Body>
        </>
      ),
    },
    {
      key: "verified",
      body: (
        <>
          <Eyebrow>{t("verified.kicker")}</Eyebrow>
          <Title>{t("verified.title")}</Title>
          <Ladder label={t("verified.match")} />
          <Body className="mt-5">
            {data.attestation === null
              ? t("verified.noAttestation")
              : t("verified.attestation", {
                  result: data.attestation.matched ? t("verified.matched") : t("verified.notMatched"),
                  distance: data.attestation.distance,
                })}
          </Body>
          <Readout>
            {data.focal?.measured === true
              ? t("verified.provenanceSelf", { date: measuredOn })
              : t("verified.provenance", { passport: shortHex(measurement.passportId, 8, 6), date: measuredOn })}
          </Readout>
        </>
      ),
    },
    {
      key: "trusted",
      body: (
        <>
          <Eyebrow className="sm:justify-end">{t("trusted.kicker")}</Eyebrow>
          <Title className="sm:ms-auto sm:text-end">{t("trusted.title")}</Title>
          {agentId !== null && (
            <div
              data-story-line="card"
              className="mt-7 w-full max-w-[24rem] border border-line bg-white/[0.03] p-5 text-start backdrop-blur-sm sm:ms-auto"
            >
              <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-accent">
                {t("trusted.agent", { agent: agentId })}
              </p>
              <p className="mt-3 font-display text-[clamp(2rem,4vw,3.2rem)] leading-[0.95] tracking-[-0.04em] tabular-nums">
                {data.agent === null || data.agent.score === null
                  ? t("trusted.noScore")
                  : t("trusted.score", { score: data.agent.score })}
              </p>
              <p className="mt-2 font-mono text-[11px] uppercase tracking-[0.14em] text-text-faint">
                {t("trusted.counts", {
                  rechecks: data.agent?.rechecks ?? 0,
                  passports: data.agent?.passports ?? 0,
                })}
              </p>
            </div>
          )}
          <Body className="sm:ms-auto sm:text-end">{agentId === null ? t("trusted.noAgent") : t("trusted.body")}</Body>
        </>
      ),
    },
  ];
}

/** How long one reading of the browser's clock is kept still, in seconds. */
const CLOCK_HELD = 60;

let clockAt = 0;

/**
 * The reader's own clock in whole seconds, held still between readings.
 *
 * A snapshot that answered a new number every time React asked would put React
 * in a loop, and a rule whose smallest step is a day does not need a second
 * hand. The film is browser only, so the third answer is never really used.
 */
function readClock(): number {
  const seconds = Math.floor(Date.now() / 1000);
  if (seconds - clockAt >= CLOCK_HELD) {
    clockAt = seconds;
  }
  return clockAt;
}

/** Nothing pushes the time at the film. Any later render is enough. */
const noClockWatch = () => () => undefined;

const atRender = () => 0;

/**
 * The statement in the shape the drawing wants it: where it sits on the rule,
 * and the two dates in the reader's own language.
 *
 * The end of the rule is this reader's own today rather than the moment the
 * page was rendered, which is the same rule the passport card's ledger follows.
 * The clock is read through a store rather than during the render, the same way
 * the passport card reads it, so the reading is held still between renders and
 * nothing here is a call to Date.now in the middle of one.
 *
 * The chapter itself does not wait for that clock. Everything in it is the
 * chain's answer, already on the server, and a page rendered without a browser,
 * a still page and a reader with no script all carry the ninth chapter. Only
 * the two parts the clock really owns, where the notch falls and the word at
 * the far end of the rule, are held back until there is a browser to ask.
 */
function useLedgerView(data: StoryData): LedgerView | null {
  const format = useFormatter();
  const now = useSyncExternalStore(noClockWatch, readClock, atRender);

  return useMemo(() => {
    if (data.focal === null || data.statement === null) {
      return null;
    }
    const short = (seconds: number) =>
      format.dateTime(new Date(seconds * 1000), { day: "numeric", month: "short", year: "numeric" });
    const dated = now !== 0;

    return {
      consent: data.statement.consent,
      dated,
      // Without a clock the rule runs to the statement's own day and the notch
      // is at its end, which is the one place it cannot be wrong.
      notch: dated ? fractionOf(data.statement.at, data.focal.registeredAt, Math.max(now, data.statement.at)) : 1,
      registered: short(data.focal.registeredAt),
      writtenShort: short(data.statement.at),
    };
  }, [data.focal, data.statement, format, now]);
}

export function LandingStory({ data, variant = "classic" }: { data: StoryData; variant?: StoryVariant }) {
  const t = useTranslations("story");
  const reduced = useReducedMotion();
  const [webgl] = useState(canDrawWebGL);
  const filmStill = reduced === true || !webgl;
  const [small, setSmall] = useState(false);
  const [short, setShort] = useState(false);
  const [dropped, setDropped] = useState<string | null>(null);
  const [start, setStart] = useState(0);
  const [tier, setTier] = useState(0);
  const carried = useRef<number | null>(null);

  useEffect(() => {
    const query = window.matchMedia("(max-width: 767px)");
    // The band is the phone framing, which starts where the side columns stop.
    const narrow = window.matchMedia("(max-width: 639px)");
    const low = window.matchMedia(`(max-height: ${SHORT_SCREEN - 1}px)`);
    // A screen that crosses the phone breakpoint is a different machine as far
    // as the field is concerned, so the measurement begins again from its tier.
    const read = () => {
      const at = startTier(window.innerWidth);
      setSmall(query.matches);
      setShort(narrow.matches && low.matches);
      setStart(at);
      setTier(at);
    };
    read();
    query.addEventListener("change", read);
    narrow.addEventListener("change", read);
    low.addEventListener("change", read);
    return () => {
      query.removeEventListener("change", read);
      narrow.removeEventListener("change", read);
      low.removeEventListener("change", read);
    };
  }, []);

  const level = tierLevel(tier);
  const still = filmStill || level.still;
  // A cut with a beat about a statement nobody wrote is not a cut of this film:
  // the same rule the bench prints its line from decides it, in one place.
  const table = beatTable(storyCut(variant, data));
  const ledger = useLedgerView(data);
  const beats = useBeats(data, table, ledger, still);
  const dpr = useMemo(() => [1, level.dpr] as [number, number], [level.dpr]);

  const onTier = useCallback((next: number) => {
    if (tierLevel(next).still) {
      // The scene is about to go: hold where the reader had got to so the still
      // page can open at the same point in the story.
      carried.current = progress.scroll;
    }
    setTier(next);
  }, []);

  // Lenis drives the window scroll on every other page and syncs itself from a
  // native scroll event, so moving the window here is enough.
  useEffect(() => {
    const at = carried.current;
    if (!still || at === null) {
      return;
    }
    carried.current = null;
    const frame = requestAnimationFrame(() => {
      const room = document.documentElement.scrollHeight - window.innerHeight;
      window.scrollTo({ top: Math.max(0, room * at), behavior: "auto" });
    });
    return () => cancelAnimationFrame(frame);
  }, [still]);

  // The same list, in the same order, that StoryStage asked the document to
  // start fetching. The field hands its first pictures to the plates that stand
  // largest in the opening frame, so those are the ones already on their way.
  // The shot's share of the window, for the renderer alone: the whole of it on
  // anything wider than a phone, less than usual on a phone too short to fit
  // the words under it. Nothing the page lays out reads this. Both numbers are
  // in globals.css too, where the seam and the words are placed from them, so
  // neither moves while the browser works out which screen this is.
  const band = small ? (short ? SHORT_PHONE_BAND : PHONE_BAND) : 1;

  const pictures = useMemo(() => fieldPictures(data.plates), [data.plates]);

  // The plates a judge can try are real records off the index, picked by the one
  // rule the verify page uses too, so the two screens never offer different rows.
  const samples = useMemo(() => pickSamples(data.plates), [data.plates]);

  const credential = data.focal === null ? "c2pa manifest" : `c2pa ${shortHex(data.focal.creator, 6, 4)}`;

  // Runs the story to its last beat, waits for the footer that arrives with it,
  // and leaves the reader standing on it. The wait is the point: the footer is
  // held back until the last beat has been read, which is decided a frame or
  // two after the scroller reaches its end.
  const skip = useCallback(() => {
    if (scroller.el !== null) {
      moveStory(scroller.el, { to: "end" });
    }
    whenRoom((room) => {
      window.scrollTo({ top: room, behavior: "smooth" });
      document.querySelector<HTMLElement>("footer a")?.focus({ preventScroll: true });
    });
  }, []);

  if (still) {
    return (
      <div data-story-tier={tier}>
        <StillStory
          data={data}
          table={table}
          beats={beats}
          samples={samples}
          noWebgl={!webgl && reduced !== true}
        />
      </div>
    );
  }

  return (
    <SceneBoundary
      fallback={<StillStory data={data} table={table} beats={beats} samples={samples} noWebgl />}
    >
      {/* Lenis smooth scroll runs on every other page. Here the scroll belongs
          to the scene, so the wheel is handed straight to it. The three handlers
          are on this wrapper rather than on each pinned panel: the scene's own
          scroll element is only as big as the shot, so a gesture anywhere else
          on the screen has to be carried to it from here. */}
      <div
        className="grain relative h-[100svh] w-full overflow-hidden bg-bg"
        data-story="film"
        data-story-tier={tier}
        data-story-short={short ? "true" : undefined}
        data-lenis-prevent
        onWheel={forwardWheel}
        onTouchStart={forwardTouchStart}
        onTouchMove={forwardTouchMove}
      >
        {/* The way out, for anyone on a keyboard who does not want eight
            screens of film: it is the first thing Tab lands on inside the
            story, it is invisible until then, and it leaves the reader on the
            footer with the addresses in it. */}
        <button
          type="button"
          data-story-skip="true"
          onClick={skip}
          className="sr-only focus:not-sr-only focus:absolute focus:left-5 focus:z-50 focus:rounded-[8px] focus:border focus:border-line focus:bg-bg focus:px-4 focus:py-2 focus:font-mono focus:text-[11px] focus:uppercase focus:tracking-[0.2em] focus:text-text"
          style={{ top: "calc(var(--header-h) + 0.75rem)" }}
        >
          {t.has("skip") ? t("skip") : "Skip the film"}
        </button>

        <div className="story-stage">
          <Canvas
            // A phone is a tall, narrow window on the same field, so it needs a
            // wider lens to see more than one plate at a time.
            camera={{ position: [0.9, 0.35, 7.4], fov: small ? 54 : 40 }}
            dpr={dpr}
            gl={{ antialias: true, powerPreference: "high-performance" }}
            // The shot is taken out of the screen reader's way rather than given
            // a name of its own. Every word the film says is already on the page
            // as text: the nine captions below are the same beats the still page
            // stacks, and they are in the document whether or not their beat is
            // the one on screen. The scroller around this canvas already carries
            // the film's name, so a label here would say the same sentence
            // twice and then stop at a picture nobody can use.
            onCreated={({ gl }) => gl.domElement.setAttribute("aria-hidden", "true")}
          >
            {/* The scroller is as tall as the canvas, which on a phone is now
                the whole screen rather than the shot. Handing the pages that
                same fraction back keeps a phone's thumb travel per beat exactly
                what it was when the scroller was the band. It is the band's own
                fraction, the one the renderer draws into: a short phone gives
                the shot less of the window, and the thumb has to be given the
                same less or a beat runs longer than the shot it belongs to. */}
            <ScrollControls pages={table.pages} distance={band} damping={0.22}>
              <World
                data={data}
                table={table}
                pictures={pictures}
                plateCount={level.plates}
                particles={level.particles}
                spread={small ? 0.55 : 1}
                framing={small ? 0.2 : 1}
                reach={small ? 1.12 : 1}
                credential={credential}
                dropped={dropped}
                start={start}
                label={`${t("title")}: ${t("line")}`}
                onTier={onTier}
              />
            </ScrollControls>
            <Band fraction={band} />
            <AdaptiveDpr pixelated />
            <Preload all />
          </Canvas>
        </div>

        {/* The film scrim: the sides go dark so a caption always has something to
            sit on, and the top clears the app header. */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 z-10 hidden sm:block"
          style={{
            background:
              "linear-gradient(90deg, rgba(11,11,12,0.72) 0%, rgba(11,11,12,0.12) 22%, rgba(11,11,12,0) 38%," +
              "rgba(11,11,12,0) 62%, rgba(11,11,12,0.12) 78%, rgba(11,11,12,0.72) 100%)," +
              "linear-gradient(180deg, rgba(11,11,12,0.8) 0%, rgba(11,11,12,0) 14%)",
          }}
        />

        {/* A phone has no room at the sides, so the shot ends partway down the
            window and the words have the ground below it. The seam is a fade
            rather than a cut, and the top strip clears the bar. Where the fade
            sits is written in globals.css beside the band it belongs to, so the
            seam and the words are placed by the same stylesheet and neither
            waits for the browser to have measured the window. */}
        <div aria-hidden className="story-seam pointer-events-none absolute inset-0 z-10 sm:hidden" />

        {/* The captions live outside the canvas, so the film scrim over the scene
            still sits behind the words. Each one is on screen for exactly the beat
            it belongs to, and the travel between two beats carries no words at all. */}
        <div className="pointer-events-none absolute inset-0 z-20 overflow-hidden">
          <Caption cue={table.beat.opening} fade={table.fade}>
            <Opening kicker={t("kicker")} title={t("title")} line={t("line")} />
            {/* A phone has no foot to hang credits from: the shot ends at 45
                percent of the window and the words own everything below it. So
                on a phone the block follows the tagline with a poster's gap
                instead of sitting on the floor of the frame. */}
            <div className="mt-8 sm:hidden">
              <Credits />
            </div>
          </Caption>
          <Caption cue={table.beat.opening} fade={table.fade} place="foot">
            <Credits />
          </Caption>
          {beats.map((entry) => {
            const cue = table.beat[entry.key];
            return cue === undefined ? null : (
              <Caption key={entry.key} cue={cue} fade={table.fade}>
                {entry.body}
              </Caption>
            );
          })}
        </div>

        {/* The one beat that is drawn rather than written, lying on the plate
            itself. Hidden on a phone, where the same drawing stacks with the
            words instead. */}
        {table.beat.stated !== undefined && ledger !== null && (
          <PlateLedger view={ledger} beat={table.beat.stated} fade={table.fade} />
        )}

        <TryPanel onPreview={setDropped} samples={samples} />
        <CloseCard data={data} />
        <ScrollCue />
        <FilmEnd />
      </div>
    </SceneBoundary>
  );
}

/**
 * Tells the page when the film is over, and when the reader has gone past it.
 *
 * While the story is pinned the document is exactly one window tall, so the
 * first wheel turn cannot move the page instead of the story. The footer is
 * held back by the rule in globals.css that watches the first attribute, and
 * comes back once the last beat has been read, where the same rule hands the
 * scroll chain back so a gesture reaches it.
 *
 * The second attribute is the page scrolled below the film. From there a
 * gesture over what is left of the film belongs to the page: without it a thumb
 * coming back up rewinds the story, which takes the footer away under it.
 */
function FilmEnd() {
  useEffect(() => {
    let frame = 0;
    let ended: boolean | null = null;
    let past: boolean | null = null;

    const flag = (name: string, on: boolean) => {
      if (on) {
        document.body.setAttribute(name, "true");
      } else {
        document.body.removeAttribute(name);
      }
    };

    const loop = () => {
      const done = progress.scroll >= 0.995;
      if (done !== ended) {
        ended = done;
        film.ended = done;
        flag("data-story-end", done);
      }
      const away = window.scrollY > 0;
      if (away !== past) {
        past = away;
        film.past = away;
        flag("data-story-past", away);
      }
      frame = requestAnimationFrame(loop);
    };

    frame = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(frame);
      film.ended = false;
      film.past = false;
      document.body.removeAttribute("data-story-end");
      document.body.removeAttribute("data-story-past");
    };
  }, []);

  return null;
}

/**
 * One caption, on screen for exactly as long as its beat runs.
 *
 * The opacity and the small rise are written straight to the node from an
 * animation frame. The story is already spending its frame budget on the camera,
 * and none of this needs React to render again.
 *
 * "foot" hangs the block off the floor of the shot instead of the reading band,
 * which is where the poster credits go on anything wider than a phone. It leaves
 * the scroll hint its own strip at the very bottom.
 */
function Caption({
  cue,
  fade,
  children,
  place = "band",
}: {
  cue: Beat;
  /** The cut's own fade, so a caption takes the same scroll distance in both. */
  fade: number;
  children: ReactNode;
  place?: "band" | "foot";
}) {
  const node = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let frame = 0;
    let last = -1;

    const loop = () => {
      const el = node.current;
      if (el !== null) {
        const { shown, y } = captionCue(progress.scroll, cue, fade);
        if (shown !== last) {
          last = shown;
          el.style.opacity = String(shown);
          el.style.transform = `translate3d(0, ${y.toFixed(2)}px, 0)`;
        }
      }
      frame = requestAnimationFrame(loop);
    };

    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, [cue, fade]);

  return (
    <div
      ref={node}
      data-beat={place === "band" ? cue.name : undefined}
      data-hero-credit={place === "foot" ? "true" : undefined}
      className={
        place === "band"
          ? "story-lower pointer-events-none px-5 sm:px-8 lg:px-14"
          : "pointer-events-none absolute inset-x-0 bottom-0 hidden px-5 pb-20 sm:block sm:px-8 lg:px-14"
      }
      style={{ opacity: cue.captionStart <= 0 ? 1 : 0, willChange: "transform, opacity" }}
    >
      <div className={`mx-auto w-full max-w-[100rem] ${place === "band" && cue.align === "end" ? "sm:text-end" : ""}`}>
        {children}
      </div>
    </div>
  );
}

/**
 * The credits wait for the title.
 *
 * The title carries 90 ms of delay and 900 ms of rise, so this is the frame it
 * has settled on: the name is read first and the two calls arrive under it.
 * The wait is held in here rather than in the film so the scene never shares a
 * render with it.
 */
const TITLE_SETTLED = 980;

function Credits() {
  const [entered, setEntered] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => setEntered(true), TITLE_SETTLED);
    return () => window.clearTimeout(timer);
  }, []);

  return <HeroCredits entered={entered} />;
}

function Opening({ kicker, title, line }: { kicker: string; title: string; line: string }) {
  return (
    <>
      <p className="story-enter flex items-center gap-3 font-mono text-[11px] uppercase tracking-[0.24em] text-accent">
        <span className="motif h-[9px] w-[9px]" />
        {kicker}
      </p>
      <h1
        className="story-enter mt-6 font-display text-[clamp(3rem,9vw,8rem)] font-semibold uppercase leading-[0.95] tracking-[-0.045em]"
        style={{ animationDelay: "90ms" }}
      >
        {title}
      </h1>
      <p
        className="story-enter mt-6 max-w-[34ch] text-[clamp(1rem,1.5vw,1.35rem)] leading-relaxed text-text-muted"
        style={{ animationDelay: "180ms" }}
      >
        {line}
      </p>
    </>
  );
}

export function Eyebrow({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <p
      data-story-line="kicker"
      className={`flex items-center gap-3 font-mono text-[11px] uppercase tracking-[0.24em] text-accent ${className}`}
    >
      <span className="motif h-[9px] w-[9px]" />
      {children}
    </p>
  );
}

export function Title({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <h2
      data-story-line="title"
      className={`mt-5 max-w-[17ch] font-display text-[clamp(2rem,5.4vw,4.4rem)] font-semibold leading-[0.98] tracking-[-0.04em] ${className}`}
    >
      {children}
    </h2>
  );
}

export function Body({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <p data-story-line="body" className={`mt-4 max-w-[38ch] text-base leading-relaxed text-text-muted ${className}`}>
      {children}
    </p>
  );
}

export function Readout({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <p
      data-story-line="readout"
      className={`mt-5 max-w-[46ch] font-mono text-[11px] uppercase tracking-[0.14em] text-text-faint ${className}`}
    >
      {children}
    </p>
  );
}

/**
 * The verifier's own figures, ticking as the copies come home.
 *
 * The six transforms and their confidences were measured by posting the real
 * files to the running verifier, and the numbers are written straight onto the
 * three nodes from an animation frame so the scene never shares a render with
 * them.
 *
 * The caption is the same measurement in words. On its own the row read
 * "0.91 REENCODE-Q30 / MATCH", which is the verifier's vocabulary and nobody
 * else's.
 */
export function Ladder({ label }: { label: string }) {
  const t = useTranslations("story.verified");
  const name = useRef<HTMLSpanElement>(null);
  const value = useRef<HTMLSpanElement>(null);
  const said = useRef<HTMLSpanElement>(null);
  const steps = useMemo(() => degradeSteps(), []);

  const spoken = useCallback(
    (transform: string) => (t.has(`copies.${transform}`) ? t(`copies.${transform}`) : transform),
    [t],
  );
  const measured = useCallback(
    (confidence: number) => t("similarity", { value: confidence.toFixed(2), result: label }),
    [label, t],
  );

  useEffect(() => {
    let frame = 0;
    let shownIndex = -1;

    const loop = () => {
      const at = Math.min(steps.length - 1, Math.floor(progress.verified * steps.length));
      if (at !== shownIndex && progress.verified > 0) {
        shownIndex = at;
        if (name.current !== null) {
          name.current.textContent = spoken(steps[at].transform);
        }
        if (value.current !== null) {
          value.current.textContent = steps[at].confidence.toFixed(2);
        }
        if (said.current !== null) {
          said.current.textContent = measured(steps[at].confidence);
        }
      }
      frame = requestAnimationFrame(loop);
    };

    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, [measured, spoken, steps]);

  return (
    <div className="mt-7 flex items-end gap-4">
      <span
        ref={value}
        className="font-display text-[clamp(2.6rem,6vw,4.6rem)] font-semibold leading-[0.85] tracking-[-0.05em] tabular-nums text-accent"
      >
        {steps[0].confidence.toFixed(2)}
      </span>
      <span className="pb-2">
        <span ref={name} className="block max-w-[26ch] font-mono text-[12px] uppercase tracking-[0.14em] text-text">
          {spoken(steps[0].transform)}
        </span>
        <span ref={said} className="block max-w-[26ch] font-mono text-[11px] uppercase tracking-[0.14em] text-text-faint">
          {measured(steps[0].confidence)}
        </span>
      </span>
    </div>
  );
}
