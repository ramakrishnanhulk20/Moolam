"use client";

import { AdaptiveDpr, Preload, ScrollControls, useScroll } from "@react-three/drei";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { useReducedMotion } from "framer-motion";
import { useFormatter, useTranslations } from "next-intl";
import { Component, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import * as THREE from "three";
import { Copies, FocalPlate, PlateField, useField } from "@/components/story/scene/field";
import { CloseCard } from "@/components/story/CloseCard";
import { ScrollCue } from "@/components/story/ScrollCue";
import { StillStory } from "@/components/story/StillStory";
import { TryPanel, type TrySample } from "@/components/story/TryPanel";
import { probe, progress, scroller } from "@/components/story/signals";
import type { StoryData } from "@/components/story/data";
import { degradeSteps, measurement } from "@/components/story/measurements";
import { createTierState, nextTier, startTier, tierLevel } from "@/components/story/tier";
import { BEAT, CAMERA_KEYS, PAGES, captionCue, played, span, type Beat, type BeatName } from "@/components/story/beats";
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
  t: number,
  framing: number,
  reach: number,
  outPos: THREE.Vector3,
  outLook: THREE.Vector3,
) {
  const clamped = Math.min(1, Math.max(0, t));
  let a = CAMERA_KEYS[0];
  let b = CAMERA_KEYS[CAMERA_KEYS.length - 1];
  for (let index = 0; index < CAMERA_KEYS.length - 1; index += 1) {
    if (clamped >= CAMERA_KEYS[index].at && clamped <= CAMERA_KEYS[index + 1].at) {
      a = CAMERA_KEYS[index];
      b = CAMERA_KEYS[index + 1];
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
  pictures,
  plateCount,
  particles,
  spread,
  framing,
  reach,
  credential,
  dropped,
  start,
  onTier,
}: {
  data: StoryData;
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
  /** Called once per change, never per frame. */
  onTier: (tier: number) => void;
}) {
  const scroll = useScroll();
  const { camera } = useThree();
  const field = useField(plateCount, pictures, spread);

  // The panels pinned over the scene sit outside this element, so they need a
  // handle on it to pass a wheel or a drag back to the story.
  useEffect(() => {
    scroller.el = scroll.el;
    return () => {
      scroller.el = null;
    };
  }, [scroll]);

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

    sampleKeys(t, framing, reach, pos, look);
    camera.position.lerp(pos, k);
    smoothLook.current.lerp(look, k);
    camera.lookAt(smoothLook.current);

    approach.current = span(t, BEAT.opening.captionEnd, BEAT.made.start);
    made.current = played(t, BEAT.made);
    sealed.current = played(t, BEAT.sealed);
    shared.current = played(t, BEAT.shared, 0.85);
    verified.current = played(t, BEAT.verified, 0.85);

    // The field dims while the camera is in among one plate, and comes back up
    // for the last beat, which is about how many of them there are.
    fade.current =
      1 - 0.68 * span(t, BEAT.opening.captionEnd, BEAT.made.start) * (1 - span(t, BEAT.close.start, BEAT.close.start + 0.04));

    const offer = captionCue(t, BEAT.offer).shown;
    probing.current = offer * (probe.state === "idle" ? 0.35 : 1);
    answer.current = probe.state === "matched" ? 1 : probe.state === "refused" ? 2 : verified.current > 0.98 ? 1 : 0;

    progress.scroll = t;
    progress.made = made.current;
    progress.sealed = sealed.current;
    progress.shared = shared.current;
    progress.verified = verified.current;
    progress.trusted = played(t, BEAT.trusted);
    progress.offer = offer;
    progress.close = captionCue(t, BEAT.close).shown;

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
function useBeats(data: StoryData): StoryBeat[] {
  const t = useTranslations("story");
  const format = useFormatter();

  // Every figure below leaves the one record data.ts chose, so a caption cannot
  // name an agent, a manifest or a re-check the passport page would then deny.
  const agentId = data.focal === null ? (data.agent?.id ?? null) : data.focal.agentId;
  const block = data.focal?.block ?? "";
  const registered =
    data.focal === null ? "" : format.dateTime(new Date(data.focal.registeredAt * 1000), { dateStyle: "long" });
  const measuredOn = format.dateTime(new Date(measurement.measuredAt), { dateStyle: "long" });

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
            <div className="mt-7 w-full max-w-[24rem] border border-line bg-white/[0.03] p-5 text-start backdrop-blur-sm sm:ms-auto">
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
                  verifications: data.agent?.verifications ?? 0,
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

export function LandingStory({ data }: { data: StoryData }) {
  const t = useTranslations("story");
  const reduced = useReducedMotion();
  const [webgl] = useState(canDrawWebGL);
  const filmStill = reduced === true || !webgl;
  const [small, setSmall] = useState(false);
  const [dropped, setDropped] = useState<string | null>(null);
  const [start, setStart] = useState(0);
  const [tier, setTier] = useState(0);
  const carried = useRef<number | null>(null);

  useEffect(() => {
    const query = window.matchMedia("(max-width: 767px)");
    // A screen that crosses the phone breakpoint is a different machine as far
    // as the field is concerned, so the measurement begins again from its tier.
    const read = () => {
      const at = startTier(window.innerWidth);
      setSmall(query.matches);
      setStart(at);
      setTier(at);
    };
    read();
    query.addEventListener("change", read);
    return () => query.removeEventListener("change", read);
  }, []);

  const level = tierLevel(tier);
  const still = filmStill || level.still;
  const beats = useBeats(data);
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

  const pictures = useMemo(() => [...new Set(data.plates.map((plate) => plate.picture))], [data.plates]);

  // The plates a judge can try are real records off the index, newest first, one
  // picture each so the row is never the same image three times.
  const samples = useMemo(() => {
    const seen = new Set<string>();
    const offered: TrySample[] = [];
    for (const plate of data.plates) {
      if (seen.has(plate.picture) || offered.length === 3) {
        continue;
      }
      seen.add(plate.picture);
      offered.push({ id: plate.id, url: plate.picture });
    }
    return offered;
  }, [data.plates]);

  const credential = data.focal === null ? "c2pa manifest" : `c2pa ${shortHex(data.focal.creator, 6, 4)}`;

  if (still) {
    return (
      <div data-story-tier={tier}>
        <StillStory data={data} beats={beats} samples={samples} noWebgl={!webgl && reduced !== true} />
      </div>
    );
  }

  return (
    <SceneBoundary fallback={<StillStory data={data} beats={beats} samples={samples} noWebgl />}>
      {/* Lenis smooth scroll runs on every other page. Here the scroll belongs
          to the scene, so the wheel is handed straight to it. */}
      <div
        className="grain relative h-[100svh] w-full overflow-hidden bg-bg"
        data-story="film"
        data-story-tier={tier}
        data-lenis-prevent
      >
        <div className="story-stage">
          <Canvas
            // A phone is a tall, narrow window on the same field, so it needs a
            // wider lens to see more than one plate at a time.
            camera={{ position: [0.9, 0.35, 7.4], fov: small ? 54 : 40 }}
            dpr={dpr}
            gl={{ antialias: true, powerPreference: "high-performance" }}
          >
            <ScrollControls pages={PAGES} damping={0.22}>
              <World
                data={data}
                pictures={pictures}
                plateCount={level.plates}
                particles={level.particles}
                spread={small ? 0.55 : 1}
                framing={small ? 0.2 : 1}
                reach={small ? 1.12 : 1}
                credential={credential}
                dropped={dropped}
                start={start}
                onTier={onTier}
              />
            </ScrollControls>
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

        {/* A phone has no room at the sides, so the shot ends at 45 percent of the
            window and the words have the ground below it. The seam is a fade
            rather than a cut, and the top strip clears the bar. */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 z-10 sm:hidden"
          style={{
            background:
              "linear-gradient(180deg, rgba(11,11,12,0) 28%, rgba(11,11,12,0.72) 41%, #0B0B0C 46%)," +
              "linear-gradient(180deg, rgba(11,11,12,0.86) 0%, rgba(11,11,12,0) 18%)",
          }}
        />

        {/* The captions live outside the canvas, so the film scrim over the scene
            still sits behind the words. Each one is on screen for exactly the beat
            it belongs to, and the travel between two beats carries no words at all. */}
        <div className="pointer-events-none absolute inset-0 z-20 overflow-hidden">
          <Caption cue={BEAT.opening}>
            <Opening kicker={t("kicker")} title={t("title")} line={t("line")} />
          </Caption>
          {beats.map((entry) => (
            <Caption key={entry.key} cue={BEAT[entry.key]}>
              {entry.body}
            </Caption>
          ))}
        </div>

        <TryPanel onPreview={setDropped} samples={samples} />
        <CloseCard data={data} />
        <ScrollCue />
        <FilmEnd />
      </div>
    </SceneBoundary>
  );
}

/**
 * Tells the page when the film is over.
 *
 * While the story is pinned the document is exactly one window tall, so the
 * first wheel turn cannot move the page instead of the story. The footer is
 * held back by the rule in globals.css that watches this attribute, and comes
 * back once the last beat has been read, where the scroll chains on to it.
 */
function FilmEnd() {
  useEffect(() => {
    let frame = 0;
    let ended: boolean | null = null;

    const loop = () => {
      const done = progress.scroll >= 0.995;
      if (done !== ended) {
        ended = done;
        if (done) {
          document.body.setAttribute("data-story-end", "true");
        } else {
          document.body.removeAttribute("data-story-end");
        }
      }
      frame = requestAnimationFrame(loop);
    };

    frame = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(frame);
      document.body.removeAttribute("data-story-end");
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
 */
function Caption({ cue, children }: { cue: Beat; children: ReactNode }) {
  const node = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let frame = 0;
    let last = -1;

    const loop = () => {
      const el = node.current;
      if (el !== null) {
        const { shown, y } = captionCue(progress.scroll, cue);
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
  }, [cue]);

  return (
    <div
      ref={node}
      data-beat={cue.name}
      className="story-lower pointer-events-none px-5 sm:px-8 lg:px-14"
      style={{ opacity: cue.captionStart <= 0 ? 1 : 0, willChange: "transform, opacity" }}
    >
      <div className={`mx-auto w-full max-w-[100rem] ${cue.align === "end" ? "sm:text-end" : ""}`}>{children}</div>
    </div>
  );
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
      className={`mt-5 max-w-[17ch] font-display text-[clamp(2rem,5.4vw,4.4rem)] font-semibold leading-[0.98] tracking-[-0.04em] ${className}`}
    >
      {children}
    </h2>
  );
}

export function Body({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <p className={`mt-4 max-w-[38ch] text-base leading-relaxed text-text-muted ${className}`}>{children}</p>;
}

export function Readout({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <p className={`mt-5 max-w-[46ch] font-mono text-[11px] uppercase tracking-[0.14em] text-text-faint ${className}`}>
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
