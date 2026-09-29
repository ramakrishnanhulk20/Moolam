"use client";

import { AdaptiveDpr, Preload, ScrollControls, useScroll } from "@react-three/drei";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { useReducedMotion } from "framer-motion";
import { useFormatter, useTranslations } from "next-intl";
import {
  Component,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
  type RefObject,
} from "react";
import * as THREE from "three";
import { Copies, FocalPlate, PlateField, useField } from "@/components/story/scene/field";
import { fieldPictures } from "@/components/story/scene/order";
import { ChapterOpening } from "@/components/story/ChapterOpening";
import { CloseCard } from "@/components/story/CloseCard";
import { ScrollCue } from "@/components/story/ScrollCue";
import { StillStory } from "@/components/story/StillStory";
import { TryPanel } from "@/components/story/TryPanel";
import { pickSamples } from "@/lib/data/samples";
import {
  film,
  filmArrived,
  filmPlace,
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
import { bitsApart, degradeSteps, measurement } from "@/components/story/measurements";
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
   * How much further back a phone stands. It was set when the phone's shot was
   * the top 45 percent of the window; the Band keeps that shot's scale, grown
   * by SHOT_GROW, so the distance still holds.
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
          pageTop: Math.max(0, -film.top),
          above: film.past && film.top > 1 ? film.top : 0,
          lead: film.lead,
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
 * How far a thumb travels per screen of story on a phone, as a share of the
 * window. The shot used to be drawn into the top 45 percent of the window and
 * the scroll was matched to it, so a beat is still exactly the drag it was.
 */
const PHONE_TRAVEL = 0.45;

/**
 * The same, on a phone under SHORT_SCREEN tall, where the shot used to take 36
 * percent. The type in the caption band steps down there too (globals.css).
 */
const SHORT_PHONE_TRAVEL = 0.36;

/** Under this many pixels of window height, a phone is a short one. */
const SHORT_SCREEN = 700;

/** The phone's lens when the shot was the top 45 percent of the window. */
const PHONE_FOV = 54;

/**
 * Where the camera's aim lands in the room between the header and the bar, from
 * its top. Above the middle, because each beat's words stand at the foot of
 * that room and the longest of them climb a good way up it.
 */
const SHOT_CENTRE = 0.32;

/** How much larger the focal plate is drawn than in the old top band, so the taller room reads full. */
const SHOT_GROW = 1.6;

/**
 * The widest the lens is allowed to open, as the tangent of half its angle
 * (about 80 degrees). Past it the plates at the edges of a short phone stretch.
 */
const WIDEST = 0.84;

/** The rectangle the renderer draws into on a phone, in CSS pixels from the canvas's foot, and the lens it draws with. */
export interface PhoneShot {
  y: number;
  height: number;
  fov: number;
}

/**
 * The phone's shot, filling the room between the header and the tab bar.
 *
 * `room.top` is how much of the canvas the header covers and `room.foot` how
 * much the bar does: both zero once the film is a framed screen under the light
 * theme, which already sits between them. The drawn rectangle starts at the
 * bar's top and runs up past the header far enough that its middle, which is
 * where the camera looks, lands SHOT_CENTRE of the way down the room; the part
 * above the canvas is simply not there. The lens is opened so a plate comes out
 * SHOT_GROW times the size it was in the old 45 percent band, which keeps every
 * camera pose in beats.ts as it was.
 */
export function phoneShot(
  canvas: { width: number; height: number },
  room: { top: number; foot: number },
  travel: number,
): PhoneShot {
  const inside = Math.max(1, canvas.height - room.top - room.foot);
  const height = Math.round(inside * 2 * (1 - SHOT_CENTRE));
  const before = Math.max(1, canvas.height * travel);
  const half = Math.min(WIDEST, (height * Math.tan((PHONE_FOV * Math.PI) / 360)) / (SHOT_GROW * before));
  return { y: Math.round(room.foot), height, fov: (Math.atan(half) * 360) / Math.PI };
}

/** A length the stylesheet resolved, or nothing where the browser left it unresolved. */
function pixels(value: string): number {
  const read = Number.parseFloat(value);
  return Number.isFinite(read) ? read : 0;
}

/**
 * Draws the phone's shot into the room between the header and the tab bar.
 *
 * The canvas fills the whole pinned screen so the scroller built on it does
 * too, which is what gives a drag over the words the browser's own momentum.
 * The header and the bar stand over it, so the renderer is told where they are
 * and draws around them. How much of the canvas each covers is read from the
 * stylesheet (--film-top and --film-foot, registered as lengths in globals.css
 * so the browser hands them back in pixels), which is the same place the words
 * are placed from, so the two cannot disagree.
 *
 * It is set every frame rather than on a resize because a step in the adaptive
 * tier resizes the drawing buffer, and that hands the viewport back to the whole
 * canvas.
 */
function Band({ travel }: { travel: number }) {
  const gl = useThree((state) => state.gl);
  const room = useRef({ top: 0, foot: 0 });

  useEffect(() => {
    const read = () => {
      const style = getComputedStyle(gl.domElement);
      room.current = {
        top: pixels(style.getPropertyValue("--film-top")),
        foot: pixels(style.getPropertyValue("--film-foot")),
      };
    };
    read();
    window.addEventListener("resize", read);
    // The theme toggle frames or unframes the film without resizing anything.
    const theme = new MutationObserver(read);
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => {
      window.removeEventListener("resize", read);
      theme.disconnect();
    };
  }, [gl]);

  useFrame(({ gl: renderer, camera, size }) => {
    if (travel >= 1) {
      return;
    }
    const shot = phoneShot(size, room.current, travel);
    renderer.setViewport(0, shot.y, size.width, shot.height);

    const lens = camera as THREE.PerspectiveCamera;
    const aspect = size.width / shot.height;
    if (lens.aspect !== aspect || Math.abs(lens.fov - shot.fov) > 0.01) {
      lens.aspect = aspect;
      lens.fov = shot.fov;
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

export function LandingStory({ data, variant }: { data: StoryData; variant: StoryVariant }) {
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
    // The short phone's smaller type belongs to the phone framing, which starts
    // where the side columns stop.
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
  // A cut with a beat about a statement nobody wrote is not a cut of this film,
  // so the day's data picks the table, in one place.
  const table = beatTable(storyCut(data));
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
    // The still page starts under the home page's first screen, so the point in
    // the story is measured from its own top rather than from the page's.
    const frame = requestAnimationFrame(() => {
      const page = document.querySelector<HTMLElement>('[data-story="still"]');
      const lead = page === null ? 0 : page.getBoundingClientRect().top + window.scrollY;
      const room = document.documentElement.scrollHeight - window.innerHeight;
      window.scrollTo({ top: Math.max(0, lead + (room - lead) * at), behavior: "auto" });
    });
    return () => cancelAnimationFrame(frame);
  }, [still]);

  // A thumb's travel per screen of story: the whole window on anything wider
  // than a phone, and on a phone the share it has always been.
  const travel = small ? (short ? SHORT_PHONE_TRAVEL : PHONE_TRAVEL) : 1;

  // The same list, in the same order, that StoryStage asked the document to
  // start fetching. The field hands its first pictures to the plates that stand
  // largest in the opening frame, so those are the ones already on their way.

  const pictures = useMemo(() => fieldPictures(data.plates), [data.plates]);

  // The plates a judge can try are real records off the index, picked by the one
  // rule the verify page uses too, so the two screens never offer different rows.
  const samples = useMemo(() => pickSamples(data.plates), [data.plates]);

  const credential = data.focal === null ? "c2pa manifest" : `c2pa ${shortHex(data.focal.creator, 6, 4)}`;

  const stage = useRef<HTMLDivElement>(null);

  // Runs the story to its last beat, waits for the footer that arrives with it,
  // and leaves the reader standing on it. The wait is the point: the footer is
  // held back until the last beat has been read, which is decided a frame or
  // two after the scroller reaches its end.
  const arrived = useFilmArrived(stage, !still);

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
        <StillStory data={data} table={table} beats={beats} samples={samples} noWebgl={!webgl && reduced !== true} />
      </div>
    );
  }

  return (
    <SceneBoundary fallback={<StillStory data={data} table={table} beats={beats} samples={samples} noWebgl />}>
      {/* Lenis smooth scroll runs on every other page. Here the scroll belongs
          to the scene, so the wheel is handed straight to it. The three handlers
          are on this wrapper rather than on each pinned panel: the scene's own
          scroll element is only as big as the shot, so a gesture anywhere else
          on the screen has to be carried to it from here. */}
      <style href="moolam-film-in-place" precedence="default">
        {IN_PLACE}
      </style>
      <div
        ref={stage}
        className="grain relative h-[100svh] w-full overflow-hidden bg-bg"
        data-story="film"
        data-story-cut={variant}
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
            camera={{ position: [0.9, 0.35, 7.4], fov: small ? PHONE_FOV : 40 }}
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
            {/* The scroller is as tall as the canvas, which on a phone is the
                whole screen. Handing the pages a phone's travel share keeps its
                thumb travel per beat exactly what it was when the shot was the
                top band of the window. */}
            <ScrollControls pages={table.pages} distance={travel} damping={0.22}>
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
                label={t("chapter.title")}
                onTier={onTier}
              />
            </ScrollControls>
            <Band travel={travel} />
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

        {/* A phone has no room at the sides, so the words stand at the foot of
            the shot, each on a dark fade of its own (.story-lower in
            globals.css). This one only darkens the top, so the header reads
            over the shot. */}
        <div aria-hidden className="story-seam pointer-events-none absolute inset-0 z-10 sm:hidden" />

        {/* The captions live outside the canvas, so the film scrim over the scene
            still sits behind the words. Each one is on screen for exactly the beat
            it belongs to, and the travel between two beats carries no words at all. */}
        <div className="pointer-events-none absolute inset-0 z-20 overflow-hidden">
          <Caption cue={table.beat.opening} fade={table.fade}>
            <ChapterOpening arrived={arrived} />
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
        <FilmEnd stage={stage} />
      </div>
    </SceneBoundary>
  );
}

/**
 * The rules that follow the film down the page.
 *
 * The film used to start at the top of the page, so the rules in globals.css
 * could treat "the film is on this page" as "the film fills the window". The
 * home page now opens on its first screen with the film under it, so these
 * narrow two of them to the film actually standing in the window. The bar only
 * floats bare on the shot while the shot is behind it: over the first screen
 * it keeps its own ground, handed back from the utility classes it was drawn
 * with. At the film's first frame a gesture back up the page is let out of
 * the story, so the first screen above can be scrolled back to. And while the
 * film is only part way up the window, a wheel over the part that shows
 * carries the page on rather than stopping dead at the film's edge.
 */
const IN_PLACE = `
html:not(.light) body:has([data-story="film"]):not([data-story-here]) .app-header {
  background: revert-layer;
  border-color: revert-layer;
  backdrop-filter: revert-layer;
}
html:not(.light) body:has([data-story="film"]):not([data-story-here]) .app-header::before {
  content: none;
}
body[data-story-start] [data-story="film"],
body[data-story-start] [data-story-scroller],
body[data-story-past] [data-story="film"] {
  overscroll-behavior-y: auto;
}
`;

/**
 * Tells the page when the film is over, where it stands in the window, and when
 * a gesture over it belongs to the page.
 *
 * While the story is pinned the document ends at the film's foot, so once the
 * film fills the window the next wheel turn cannot move the page instead of the
 * story. The footer is held back by the rule in globals.css that watches the
 * first attribute, and comes back once the last beat has been read, where the
 * same rule hands the scroll chain back so a gesture reaches it.
 *
 * The second attribute is the film not standing in the window: the first
 * screen above it still showing, or the page scrolled below it. Either way a
 * gesture over what can be seen of the film belongs to the page: without it a
 * wheel over the film's top edge would start the story before the reader had
 * reached it, and a thumb coming back up from the footer would rewind the story
 * and take the footer away under it.
 *
 * The third is the film standing in the window, and the fourth is the film at
 * its first frame with page above it to go back to (see IN_PLACE).
 */
function FilmEnd({ stage }: { stage: RefObject<HTMLDivElement | null> }) {
  useEffect(() => {
    let frame = 0;
    let ended: boolean | null = null;
    let past: boolean | null = null;
    let here: boolean | null = null;
    let start: boolean | null = null;

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
      const top = stage.current?.getBoundingClientRect().top ?? 0;
      const room = document.documentElement.scrollHeight - window.innerHeight;
      film.top = top;
      film.lead = Math.max(0, window.scrollY + top);
      const away = filmPlace(top, window.scrollY, room) !== "here";
      if (away !== past) {
        past = away;
        film.past = away;
        flag("data-story-past", away);
      }
      if (!away !== here) {
        here = !away;
        flag("data-story-here", here);
      }
      // drei parks its scroller one pixel down, so one pixel is the first frame.
      const first = film.lead > 0 && (scroller.el?.scrollTop ?? 0) <= 1;
      if (first !== start) {
        start = first;
        flag("data-story-start", first);
      }
      frame = requestAnimationFrame(loop);
    };

    frame = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(frame);
      film.ended = false;
      film.past = false;
      film.lead = 0;
      film.top = 0;
      document.body.removeAttribute("data-story-end");
      document.body.removeAttribute("data-story-past");
      document.body.removeAttribute("data-story-here");
      document.body.removeAttribute("data-story-start");
    };
  }, [stage]);

  return null;
}

/**
 * One caption, on screen for exactly as long as its beat runs.
 *
 * The opacity and the small rise are written straight to the node from an
 * animation frame. The story is already spending its frame budget on the camera,
 * and none of this needs React to render again.
 */
function Caption({
  cue,
  fade,
  children,
}: {
  cue: Beat;
  /** The cut's own fade, so a caption takes the same scroll distance in both. */
  fade: number;
  children: ReactNode;
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
      data-beat={cue.name}
      className="story-lower pointer-events-none px-5 sm:px-8 lg:px-14"
      style={{ opacity: cue.captionStart <= 0 ? 1 : 0, willChange: "transform, opacity" }}
    >
      <div className={`mx-auto w-full max-w-[100rem] ${cue.align === "end" ? "sm:text-end" : ""}`}>
        {children}
      </div>
    </div>
  );
}

/**
 * Whether the film has come into view, latched: once its opening has played it
 * is never taken back. Read from the film's own box on each animation frame
 * until then, the way FilmEnd reads it, and not at all on the still page.
 */
export function useFilmArrived(stage: RefObject<HTMLElement | null>, watching: boolean): boolean {
  const [arrived, setArrived] = useState(false);

  useEffect(() => {
    if (!watching || arrived) {
      return;
    }
    let frame = 0;
    const look = () => {
      const node = stage.current;
      if (node !== null && filmArrived(node.getBoundingClientRect().top, window.innerHeight)) {
        setArrived(true);
        return;
      }
      frame = requestAnimationFrame(look);
    };
    frame = requestAnimationFrame(look);
    return () => cancelAnimationFrame(frame);
  }, [stage, watching, arrived]);

  return arrived;
}

function Eyebrow({ children, className = "" }: { children: ReactNode; className?: string }) {
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

function Title({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <h2
      data-story-line="title"
      className={`mt-5 max-w-[17ch] font-display text-[clamp(2rem,5.4vw,4.4rem)] font-semibold leading-[0.98] tracking-[-0.04em] ${className}`}
    >
      {children}
    </h2>
  );
}

function Body({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <p data-story-line="body" className={`mt-4 max-w-[38ch] text-base leading-relaxed text-text-muted ${className}`}>
      {children}
    </p>
  );
}

function Readout({ children, className = "" }: { children: ReactNode; className?: string }) {
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
 * The six transforms and their fingerprint distances were measured by posting
 * the real files to the running verifier, and the numbers are written straight
 * onto the three nodes from an animation frame so the scene never shares a
 * render with them.
 *
 * The figure is bits apart on the 64 bit fingerprint, the same unit the caption
 * under it, the verify page and the passport card all use. It used to be the
 * verifier's confidence, which put "0.97 of 64 bits apart" on screen.
 */
function Ladder({ label }: { label: string }) {
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
    (bits: string) => t("similarity", { value: bits, result: label }),
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
          value.current.textContent = bitsApart(steps[at]);
        }
        if (said.current !== null) {
          said.current.textContent = measured(bitsApart(steps[at]));
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
        {bitsApart(steps[0])}
      </span>
      <span className="pb-2">
        <span ref={name} className="block max-w-[26ch] font-mono text-[12px] uppercase tracking-[0.14em] text-text">
          {spoken(steps[0].transform)}
        </span>
        <span ref={said} className="block max-w-[26ch] font-mono text-[11px] uppercase tracking-[0.14em] text-text-faint">
          {measured(bitsApart(steps[0]))}
        </span>
      </span>
    </div>
  );
}
