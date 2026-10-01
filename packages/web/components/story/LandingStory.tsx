"use client";

import { AdaptiveDpr, Preload, ScrollControls, useScroll } from "@react-three/drei";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { useReducedMotion } from "framer-motion";
import { useTheme } from "next-themes";
import { useTranslations } from "next-intl";
import {
  Component,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from "react";
import * as THREE from "three";
import {
  Copies,
  FocalPlate,
  GuestPrint,
  LookalikePair,
  PlateField,
  useField,
  type SceneParts,
  type SceneSignal,
  type WordsClearing,
} from "@/components/story/scene/field";
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
import { createTierState, nextTier, startTier, tierLevel } from "@/components/story/tier";
import {
  FOUND,
  LOOKALIKE_STEPS,
  beatTable,
  captionCue,
  played,
  smooth,
  span,
  within,
  wordsCover,
  type Beat,
  type BeatKey,
  type BeatTable,
  type Pose,
  type StoryVariant,
} from "@/components/story/beats";
import { PlateLedger } from "@/components/story/StatedLedger";
import { filmCut } from "@/components/story/stated";
import { roomOf, roomPalette, type RoomPalette } from "@/components/story/palette";
import { FILM_STYLE, FILM_STYLE_HREF } from "@/components/story/room";
import { DAMPING, damp, pageProgress, type Damped, type FilmScroll } from "@/components/story/scroll";
import { PairRail, useBeats, useLedgerView, type StoryBeat } from "@/components/story/words";
import { shortHex } from "@/lib/chain/client";

export type { StoryBeat };

/**
 * Where one camera key puts the camera on this screen. A phone pushes the look
 * in toward the print (framing) and stands further back (reach), unless the key
 * carries a whole pose of its own for a tall screen.
 */
function framed(key: BeatKey, phone: boolean, framing: number, reach: number): Pose {
  if (phone && key.phone !== undefined) {
    return key.phone;
  }
  return {
    pos: [key.pose.pos[0], key.pose.pos[1], key.pose.pos[2] * reach],
    look: [key.pose.look[0] * framing, key.pose.look[1], key.pose.look[2]],
  };
}

/**
 * The camera, read off the beats table.
 *
 * Two poses at a time, blended with a smoothstep, then the camera eases toward
 * the blended point every frame so a fast scroll pulls the camera rather than
 * teleporting it.
 */
function sampleKeys(
  keys: BeatKey[],
  t: number,
  shot: { phone: boolean; framing: number; reach: number },
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
  const k = smooth((clamped - a.at) / gap);
  const from = framed(a, shot.phone, shot.framing, shot.reach);
  const to = framed(b, shot.phone, shot.framing, shot.reach);
  outPos.set(
    from.pos[0] + (to.pos[0] - from.pos[0]) * k,
    from.pos[1] + (to.pos[1] - from.pos[1]) * k,
    from.pos[2] + (to.pos[2] - from.pos[2]) * k,
  );
  outLook.set(
    from.look[0] + (to.look[0] - from.look[0]) * k,
    from.look[1] + (to.look[1] - from.look[1]) * k,
    from.look[2] + (to.look[2] - from.look[2]) * k,
  );
}

/**
 * How bright the wall is: full on the opening, low while the camera is in
 * among one print, up again while the copies cross it, and back up for the last
 * screen, which is about how many there are.
 */
export function wallFade(table: BeatTable, t: number): number {
  const { opening, shared, verified, close } = table.beat;
  const first = table.beat.imagined ?? table.beat.sealed;
  const into = span(t, opening.captionEnd, first.start);
  const out = span(t, shared.start, shared.captionEnd) * (1 - span(t, verified.start, verified.start + (verified.end - verified.start) * FOUND.snap));
  const back = span(t, close.start, close.start + 0.04);
  return Math.min(1, 1 - 0.68 * into * (1 - back) + 0.38 * out * (1 - back));
}

/** Background and haze follow the room, eased so a theme switch dissolves rather than cuts. */
function RoomGround({ roomRef, palette }: { roomRef: RefObject<RoomPalette>; palette: RoomPalette }) {
  const groundRef = useRef<THREE.Color>(null);
  const fogRef = useRef<THREE.FogExp2>(null);
  const ground = useMemo(() => new THREE.Color(), []);
  const haze = useMemo(() => new THREE.Color(), []);
  const [first] = useState(palette);

  useFrame((_, delta) => {
    const room = roomRef.current;
    ground.set(room.ground);
    haze.set(room.haze);
    const step = Math.min(1, delta * 6);
    groundRef.current?.lerp(ground, step);
    if (fogRef.current !== null) {
      fogRef.current.color.lerp(haze, step);
      fogRef.current.density = room.fogDensity;
    }
  });

  return (
    <>
      <color ref={groundRef} attach="background" args={[first.ground]} />
      <fogExp2 ref={fogRef} attach="fog" args={[first.haze, first.fogDensity]} />
    </>
  );
}

/** What every part of the scene reads the film's place from: 0 at the opening, 1 at the end of the close, eased by whichever scroll drives it. */
interface ScrollSource {
  offset: number;
}

interface WorldProps {
  data: StoryData;
  /** The cut being played. Every offset, pose and page count below comes out of it. */
  table: BeatTable;
  pictures: string[];
  plateCount: number;
  spread: number;
  particles: number;
  /**
   * How far the shot pushes the print off to one side, so the words have the
   * other. A phone stacks the words at the bottom of the frame instead, so it
   * takes almost none of it or the print leaves the screen.
   */
  framing: number;
  /** How much further back a phone stands. */
  reach: number;
  palette: RoomPalette;
  /** The few words the scene draws itself, already in the reader's language. */
  words: { credential: string; checked: string | null; lookalike: string; drawnOn: string; imaginedBy: string };
  dropped: string | null;
  /** The tier this screen begins on, before any frame has been timed. */
  start: number;
  /** Called once per change, never per frame. */
  onTier: (tier: number) => void;
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
  palette,
  words,
  dropped,
  start,
  onTier,
  source,
}: WorldProps & { source: ScrollSource }) {
  const { camera } = useThree();
  const field = useField(plateCount, pictures, spread, table.beat.opening.arrive.pos);
  const roomRef = useRef(palette);
  const signalRef = useRef<SceneSignal>({ t: 0, answer: 0, probing: 0 });
  const snappedRef = useRef(-1);
  const clearRef = useRef<WordsClearing>({ side: null, cover: 0 });

  // The frames read the room from here, so a theme switch repaints the scene
  // without restarting it or losing the scroll.
  useEffect(() => {
    roomRef.current = palette;
  }, [palette]);

  const pos = useMemo(() => new THREE.Vector3(), []);
  const look = useMemo(() => new THREE.Vector3(), []);
  const smoothLook = useRef(new THREE.Vector3());
  const fade = useRef(1);

  // The tier controller lives in a ref: the frame times arrive sixty times a
  // second and only the handful of them that move the tier are worth a render.
  const tier = useRef(createTierState(start));
  useEffect(() => {
    tier.current = createTierState(start);
  }, [start]);

  useFrame(({ clock }, delta) => {
    const t = source.offset;
    const k = Math.min(1, delta * 3.2);
    const beat = table.beat;

    sampleKeys(table.cameraKeys, t, { phone: framing < 1, framing, reach }, pos, look);
    camera.position.lerp(pos, k);
    smoothLook.current.lerp(look, k);
    camera.lookAt(smoothLook.current);

    fade.current = wallFade(table, t);

    // Which side the words are on and how far up they are, so the field can
    // step out from behind them (scene/field.tsx).
    const words = wordsCover(table, t, framing < 1);
    clearRef.current.side = words.side;
    clearRef.current.cover = words.cover;

    const offer = captionCue(t, beat.offer, table.fade).shown;
    const flight = span(within(t, beat.verified), FOUND.flightFrom, FOUND.snap);
    const signal = signalRef.current;
    signal.t = t;
    signal.probing = offer * (probe.state === "idle" ? 0.35 : 1);
    signal.answer = probe.state === "matched" ? 1 : probe.state === "refused" ? 2 : flight >= 1 && offer < 0.5 ? 1 : 0;

    progress.scroll = t;
    // The rule has to be drawn and the four marks landed while the words are
    // still there to read, so this one runs over almost the whole caption.
    progress.stated = beat.stated === undefined ? 0 : played(t, beat.stated, 0.92);
    progress.asked = beat.asked === undefined ? 0 : played(t, beat.asked, 0.9);
    progress.verified = flight;
    progress.lookalike =
      beat.lookalike === undefined
        ? 0
        : span(within(t, beat.lookalike), LOOKALIKE_STEPS.railFrom, LOOKALIKE_STEPS.railTo);
    progress.waiting = beat.waiting === undefined ? 0 : played(t, beat.waiting, 0.7);
    progress.offer = offer;
    progress.close = captionCue(t, beat.close, table.fade).shown;

    const measured = nextTier(tier.current, delta * 1000, clock.elapsedTime * 1000);
    if (measured.tier !== tier.current.tier) {
      onTier(measured.tier);
    }
    tier.current = measured;
  });

  const parts: SceneParts = useMemo(() => ({ table, roomRef, palette, signalRef, clearRef }), [palette, table]);
  const lookalike = data.lookalike ?? null;
  const yourself = data.yourself ?? null;

  return (
    <>
      <RoomGround roomRef={roomRef} palette={palette} />
      <PlateField field={field} fadeRef={fade} roomRef={roomRef} clearRef={clearRef} />
      <FocalPlate
        url={data.focal?.picture ?? null}
        dropped={dropped}
        particles={particles}
        parts={parts}
        snappedRef={snappedRef}
        checkWord={data.check?.form === "network" ? words.checked : null}
        edge={table.beat.stated !== undefined}
      />
      <Copies focalUrl={data.focal?.picture ?? null} label={words.credential} parts={parts} snappedRef={snappedRef} height={1.7} />
      {lookalike !== null && table.beat.lookalike !== undefined && (
        <LookalikePair
          earlierUrl={lookalike.earlier.picture}
          laterUrl={lookalike.later.picture}
          word={words.lookalike}
          parts={parts}
        />
      )}
      {yourself !== null && table.beat.yourself !== undefined && (
        <GuestPrint url={yourself.print.picture} drawnOn={words.drawnOn} imaginedBy={words.imaginedBy} parts={parts} />
      )}
    </>
  );
}

/**
 * The film on drei's scroller, as the home page plays it today.
 *
 * The panels pinned over the scene sit outside the scroller, so they need a
 * handle on it to pass a wheel or a drag back to the story. The attribute is
 * what the overscroll rules hang on, and what a measurement from outside the
 * page can find the scroller by.
 *
 * The element drei builds is a bare div: it carries no name, nothing says it
 * scrolls, and the keys that drive a document went nowhere on it. The rest of
 * this is the story answering a keyboard the way the page around it does,
 * through the same scrollTop the wheel moves so the film keeps one source of
 * truth for where it is.
 */
function StageFilm({
  label,
  ...world
}: WorldProps & {
  /** What a screen reader calls the film. It is a scrolling region of its own. */
  label: string;
}) {
  const scroll = useScroll();
  const pages = world.table.pages;

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
        // One press is one screen of the cut being played.
        pages,
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
  }, [label, scroll, pages]);

  return <World {...world} source={scroll} />;
}

/**
 * The film on the page's own scroll: the stage is pinned inside a section as
 * tall as the cut, and the progress is how far the window has scrolled through
 * it, eased with the scroller's own damping so the camera feels the same.
 * Nothing is handed over, because the page is the one thing that scrolls.
 */
function PageFilm({
  section,
  stage,
  ...world
}: WorldProps & { section: RefObject<HTMLElement | null>; stage: RefObject<HTMLElement | null> }) {
  const [source] = useState<Damped>(() => ({ offset: 0, velocity: 0 }));

  useFrame((_, delta) => {
    const box = section.current;
    const pin = stage.current;
    if (box === null || pin === null) {
      return;
    }
    damp(source, pageProgress(box.getBoundingClientRect().top, box.offsetHeight, pin.offsetHeight), DAMPING, delta);
  });

  return <World {...world} source={source} />;
}

/**
 * How far a thumb travels per screen of story on a phone, as a share of the
 * window. The shot used to be drawn into the top 45 percent of the window and
 * the scroll was matched to it, so a beat is still exactly the drag it was.
 */
const PHONE_TRAVEL = 0.45;

/** The same, on a phone under SHORT_SCREEN tall, where the shot used to take 36 percent. */
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

/** How much larger the focal print is drawn than in the old top band, so the taller room reads full. */
const SHOT_GROW = 1.6;

/**
 * The widest the lens is allowed to open, as the tangent of half its angle
 * (about 80 degrees). Past it the prints at the edges of a short phone stretch.
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
 * much the bar does. The drawn rectangle starts at the bar's top and runs up
 * past the header far enough that its middle, which is where the camera looks,
 * lands SHOT_CENTRE of the way down the room; the part above the canvas is
 * simply not there. The lens is opened so a print comes out SHOT_GROW times the
 * size it was in the old 45 percent band, which keeps every camera pose in
 * beats.ts as it was.
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
 * and draws around them, read from the film's own --film-top and --film-foot
 * (room.ts), registered as lengths so the browser hands them back in pixels.
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
    return () => window.removeEventListener("resize", read);
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
 * screen down with the reason only in the console.
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

const noWatch = () => () => undefined;

/**
 * The room the film plays in, from the page's own theme. Light is the default
 * for everyone; the film is browser only, so next-themes has already read the
 * reader's choice by the time this runs. `light` is the room a light page
 * plays: the one Ram last approved unless a lab route hands in the next.
 */
function useRoom(light?: RoomPalette): RoomPalette {
  const { resolvedTheme } = useTheme();
  const mounted = useSyncExternalStore(noWatch, () => true, () => false);
  return roomPalette(mounted ? roomOf(resolvedTheme) : "light", light);
}

export function LandingStory({
  data,
  variant,
  light,
  scroll = "stage",
}: {
  data: StoryData;
  variant: StoryVariant;
  /** The light room to play, when it is not the one the home page plays (palette.ts). */
  light?: RoomPalette;
  /** What drives the film: drei's scroller over the canvas, as the home page plays it, or the page's own scroll (scroll.ts). */
  scroll?: FilmScroll;
}) {
  const t = useTranslations("story");
  const marks = useTranslations("mark.states");
  const reduced = useReducedMotion();
  const [webgl] = useState(canDrawWebGL);
  const filmStill = reduced === true || !webgl;
  const [small, setSmall] = useState(false);
  const [short, setShort] = useState(false);
  const [dropped, setDropped] = useState<string | null>(null);
  const [start, setStart] = useState(0);
  const [tier, setTier] = useState(0);
  const carried = useRef<number | null>(null);
  const palette = useRoom(light);

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
  // The day's data picks the cut, in one place: a beat whose read did not come
  // back, or whose thing is not live yet, is not in it.
  const table = beatTable(filmCut(data));
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
      const page = document.querySelector<HTMLElement>('[data-film="still"]');
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
  // start fetching.
  const pictures = useMemo(() => fieldPictures(data.plates), [data.plates]);

  // The prints a judge can try are real records off the index, picked by the one
  // rule the verify page uses too, with the showcase picks the story read, so
  // the two screens never offer different rows and each is named by its title.
  const samples = useMemo(() => pickSamples(data.plates, {}, 3, data.picked ?? []), [data.plates, data.picked]);

  const yourself = data.yourself ?? null;
  const words = useMemo(
    () => ({
      credential: data.focal === null ? "c2pa manifest" : `c2pa ${shortHex(data.focal.creator, 6, 4)}`,
      checked: t("checked.mark"),
      lookalike: marks("lookalike.word"),
      drawnOn: yourself === null ? "" : t("yourself.label", { platform: yourself.platform }),
      imaginedBy: yourself === null ? "" : t("yourself.tag", { person: shortHex(yourself.print.creator, 6, 4) }),
    }),
    [data.focal, marks, t, yourself],
  );

  const section = useRef<HTMLElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const paged = scroll === "page";

  // Whether the opening has played, read off the pinned stage: on the page's
  // own scroll that is the sticky box inside the film's section.
  const arrived = useFilmArrived(stage, !still);

  // Runs the story to its last beat, waits for the footer that arrives with it,
  // and leaves the reader standing on it. On the page's own scroll the footer
  // was never away: the page simply scrolls to its end.
  const skip = useCallback(() => {
    if (!paged && scroller.el !== null) {
      moveStory(scroller.el, { to: "end" });
    }
    whenRoom((room) => {
      window.scrollTo({ top: room, behavior: "smooth" });
      document.querySelector<HTMLElement>("footer a")?.focus({ preventScroll: true });
    });
  }, [paged]);

  const style = (
    <style href={FILM_STYLE_HREF} precedence="default">
      {FILM_STYLE}
    </style>
  );

  if (still) {
    return (
      <div data-story-tier={tier}>
        {style}
        <StillStory data={data} table={table} beats={beats} samples={samples} noWebgl={!webgl && reduced !== true} />
      </div>
    );
  }

  const world: WorldProps = {
    data,
    table,
    pictures,
    plateCount: level.plates,
    particles: level.particles,
    spread: small ? 0.55 : 1,
    framing: small ? 0.2 : 1,
    reach: small ? 1.12 : 1,
    palette,
    words,
    dropped,
    start,
    onTier,
  };

  // Everything pinned on the screen while the film plays, whichever scroll drives it.
  const pinned = (
    <>
      {/* The way out, for anyone on a keyboard who does not want the whole
          film: it is the first thing Tab lands on inside the story, it is
          invisible until then, and it leaves the reader on the footer. */}
      <button
        type="button"
        data-story-skip="true"
        onClick={skip}
        className="sr-only focus:not-sr-only focus:absolute focus:left-5 focus:z-50 focus:rounded-[8px] focus:border focus:border-line focus:bg-bg focus:px-4 focus:py-2 focus:font-mono focus:text-[11px] focus:uppercase focus:tracking-[0.2em] focus:text-text"
        style={{ top: "calc(var(--header-h) + 0.75rem)" }}
      >
        {t("skip")}
      </button>

      <div className="absolute inset-0">
        <Canvas
          // A phone is a tall, narrow window on the same field, so it needs a
          // wider lens to see more than one print at a time.
          camera={{ position: [0.9, 0.35, 7.4], fov: small ? PHONE_FOV : 40 }}
          dpr={dpr}
          gl={{ antialias: true, powerPreference: "high-performance" }}
          // Every word the film says is already on the page as text, so the
          // shot is taken out of the screen reader's way rather than named.
          onCreated={({ gl }) => gl.domElement.setAttribute("aria-hidden", "true")}
        >
          {paged ? (
            <PageFilm section={section} stage={stage} {...world} />
          ) : (
            <ScrollControls pages={table.pages} distance={travel} damping={DAMPING}>
              <StageFilm label={t("chapter.title")} {...world} />
            </ScrollControls>
          )}
          <Band travel={travel} />
          <AdaptiveDpr pixelated />
          <Preload all />
        </Canvas>
        <PairRail data={data} table={table} />
      </div>

      {/* The scrim: the sides fade to the room's own ground so a caption
          always sits on it, ink on paper in light and light on black in dark,
          and the top clears the app header. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 z-10 hidden sm:block"
        style={{
          background:
            "linear-gradient(90deg, color-mix(in srgb, var(--bg) 82%, transparent) 0%, color-mix(in srgb, var(--bg) 40%, transparent) 24%, transparent 42%," +
            "transparent 58%, color-mix(in srgb, var(--bg) 40%, transparent) 76%, color-mix(in srgb, var(--bg) 82%, transparent) 100%)," +
            "linear-gradient(180deg, color-mix(in srgb, var(--bg) 80%, transparent) 0%, transparent 14%)",
        }}
      />

      {/* A phone has no room at the sides, so the words stand at the foot of
          the shot, each on a fade of its own (.film-lower in room.ts). This one
          only fades the top, so the header reads over the shot. */}
      <div aria-hidden className="film-seam pointer-events-none absolute inset-0 z-10 sm:hidden" />

      {/* The captions live outside the canvas, so the scrim over the scene
          still sits behind the words. Each one is on screen for exactly the
          beat it belongs to, and the travel between two beats carries none. */}
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

      {/* The one beat that is drawn rather than written, lying on the print
          itself. Hidden on a phone, where the same drawing stacks with the
          words instead. */}
      {table.beat.stated !== undefined && ledger !== null && (
        <PlateLedger view={ledger} beat={table.beat.stated} fade={table.fade} />
      )}

      <TryPanel onPreview={setDropped} samples={samples} />
      <CloseCard data={data} scene={palette.closeShowsScene} />
      <ScrollCue />
    </>
  );

  // What a measurement from outside the page, and the film's own rules, read off the film.
  const named = {
    "data-film-room": palette.room,
    "data-story-cut": variant,
    "data-story-beats": table.names.join(" "),
    "data-story-tier": tier,
    "data-story-short": short ? "true" : undefined,
  };

  const fallback = <StillStory data={data} table={table} beats={beats} samples={samples} noWebgl />;

  if (paged) {
    return (
      <SceneBoundary fallback={fallback}>
        {style}
        {/* The film's section is as many screens tall as the cut is long and
            the stage is pinned inside it, so the page's own scroll plays the
            film and nothing takes the wheel from it. The section's height is
            the film's rule in room.ts, from the screens written here. */}
        <section
          ref={section}
          className="relative w-full"
          data-film="film"
          data-film-scroll="page"
          {...named}
          style={{ "--film-screens": String(table.pages * travel) } as CSSProperties}
        >
          <div ref={stage} data-film-stage className="grain sticky top-0 h-[100svh] w-full overflow-hidden bg-bg">
            {pinned}
          </div>
          <FilmHere section={section} stage={stage} />
        </section>
      </SceneBoundary>
    );
  }

  return (
    <SceneBoundary fallback={fallback}>
      {style}
      {/* Lenis smooth scroll runs on every other page. Here the scroll belongs
          to the scene, so the wheel is handed straight to it. The three handlers
          are on this wrapper rather than on each pinned panel: the scene's own
          scroll element is only as big as the shot, so a gesture anywhere else
          on the screen has to be carried to it from here. */}
      <div
        ref={stage}
        className="grain relative h-[100svh] w-full overflow-hidden bg-bg"
        data-film="film"
        data-film-stage
        {...named}
        data-lenis-prevent
        onWheel={forwardWheel}
        onTouchStart={forwardTouchStart}
        onTouchMove={forwardTouchMove}
      >
        {pinned}
        <FilmEnd stage={stage} />
      </div>
    </SceneBoundary>
  );
}

/**
 * The film on the page's own scroll hands nothing over: the page is the one
 * thing that scrolls, so the end, past and start flags and every rule on them
 * are not written. The one flag kept is the dark bar floating bare on the shot
 * while the stage is pinned (room.ts), written from the film's own frame as it
 * always was.
 */
function FilmHere({ section, stage }: { section: RefObject<HTMLElement | null>; stage: RefObject<HTMLElement | null> }) {
  useEffect(() => {
    let frame = 0;
    let here: boolean | null = null;

    const loop = () => {
      const box = section.current;
      const pin = stage.current;
      if (box !== null && pin !== null) {
        const top = box.getBoundingClientRect().top;
        const held = top <= 1 && top + box.offsetHeight >= pin.offsetHeight - 1;
        if (held !== here) {
          here = held;
          if (held) {
            document.body.setAttribute("data-story-here", "true");
          } else {
            document.body.removeAttribute("data-story-here");
          }
        }
      }
      frame = requestAnimationFrame(loop);
    };

    frame = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(frame);
      document.body.removeAttribute("data-story-here");
    };
  }, [section, stage]);

  return null;
}

/**
 * Tells the page when the film is over, where it stands in the window, and when
 * a gesture over it belongs to the page.
 *
 * While the story is pinned the document ends at the film's foot, so once the
 * film fills the window the next wheel turn cannot move the page instead of the
 * story. The footer is held back by the film's own rule (room.ts) that watches
 * the first attribute, and comes back once the last beat has been read, where
 * the same rules hand the scroll chain back so a gesture reaches it.
 *
 * The second attribute is the film not standing in the window: the first
 * screen above it still showing, or the page scrolled below it. Either way a
 * gesture over what can be seen of the film belongs to the page. The third is
 * the film standing in the window, and the fourth is the film at its first
 * frame with page above it to go back to.
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
  /** The cut's own fade, so a caption takes the same scroll distance in every cut. */
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
          el.style.visibility = shown <= 0.001 ? "hidden" : "visible";
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
      className="film-lower pointer-events-none px-5 sm:px-8 lg:px-14"
      style={{ opacity: cue.captionStart <= 0 ? 1 : 0, willChange: "transform, opacity" }}
    >
      <div className={`mx-auto w-full max-w-[100rem] ${cue.align === "end" ? "sm:text-end" : ""}`}>{children}</div>
    </div>
  );
}

/**
 * Whether the film has come into view, latched: once its opening has played it
 * is never taken back. Read from the film's own box on each animation frame
 * until then, and not at all on the still page.
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
