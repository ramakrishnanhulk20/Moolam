"use client";

import { AdaptiveDpr, Preload, ScrollControls, useScroll } from "@react-three/drei";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { useReducedMotion } from "framer-motion";
import { useFormatter, useTranslations } from "next-intl";
import { Component, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import * as THREE from "three";
import { Copies, FocalPlate, PlateField, useField } from "@/components/story/scene/field";
import { CloseCard } from "@/components/story/CloseCard";
import { ScrollCue } from "@/components/story/ScrollCue";
import { StillStory } from "@/components/story/StillStory";
import { TryPanel } from "@/components/story/TryPanel";
import { probe, progress, scroller } from "@/components/story/signals";
import type { StoryData } from "@/components/story/data";
import { degradeSteps, measurement } from "@/components/story/measurements";
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
  /** How much further back a phone stands, so a plate this close still fits the narrow frame. */
  reach: number;
  credential: string;
  dropped: string | null;
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

  useFrame((_, delta) => {
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
 * stacked down a still page for anyone who has asked for less motion.
 */
function useBeats(data: StoryData, still: boolean): StoryBeat[] {
  const t = useTranslations("story");
  const format = useFormatter();

  const agentId = data.focal?.agentId ?? data.agent?.id ?? "";
  const block = data.focal?.block ?? "";
  const registered =
    data.focal === null ? "" : format.dateTime(new Date(data.focal.registeredAt * 1000), { dateStyle: "long" });
  const measuredOn = format.dateTime(new Date(measurement.measuredAt), { dateStyle: "long" });

  return [
    {
      key: "made",
      body: (
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
          {!still && <Ladder label={t("verified.match")} />}
          <Body className="mt-5">
            {data.attestation === null
              ? t("verified.noAttestation")
              : data.attestation.onFocal
                ? t("verified.attestation", {
                    result: data.attestation.matched ? t("verified.matched") : t("verified.notMatched"),
                    distance: data.attestation.distance,
                  })
                : t("verified.attestationOther", {
                    result: data.attestation.matched ? t("verified.matched") : t("verified.notMatched"),
                    distance: data.attestation.distance,
                    passport: shortHex(data.attestation.passportId, 8, 6),
                  })}
          </Body>
          <Readout>
            {t("verified.provenance", { passport: shortHex(measurement.passportId, 8, 6), date: measuredOn })}
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
          <div className="mt-7 w-full max-w-[24rem] border border-line sm:ms-auto bg-white/[0.03] p-5 text-start backdrop-blur-sm">
            <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-accent">
              {t("trusted.agent", { agent: data.agent?.id ?? agentId })}
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
          <Body className="sm:ms-auto sm:text-end">{t("trusted.body")}</Body>
        </>
      ),
    },
  ];
}

export function LandingStory({ data }: { data: StoryData }) {
  const t = useTranslations("story");
  const reduced = useReducedMotion();
  const [webgl] = useState(canDrawWebGL);
  const still = reduced === true || !webgl;
  const beats = useBeats(data, still);
  const [small, setSmall] = useState(false);
  const [dropped, setDropped] = useState<string | null>(null);

  useEffect(() => {
    const query = window.matchMedia("(max-width: 767px)");
    const read = () => setSmall(query.matches);
    read();
    query.addEventListener("change", read);
    return () => query.removeEventListener("change", read);
  }, []);

  const pictures = useMemo(() => [...new Set(data.plates.map((plate) => plate.picture))], [data.plates]);

  const credential = data.focal === null ? "c2pa manifest" : `c2pa ${shortHex(data.focal.creator, 6, 4)}`;

  if (still) {
    return <StillStory data={data} beats={beats} noWebgl={!webgl && reduced !== true} />;
  }

  return (
    <SceneBoundary fallback={<StillStory data={data} beats={beats} noWebgl />}>
      {/* Lenis smooth scroll runs on every other page. Here the scroll belongs
          to the scene, so the wheel is handed straight to it. */}
      <div className="grain relative h-[100svh] w-full overflow-hidden bg-bg" data-story="film" data-lenis-prevent>
        <Canvas
          // A phone is a tall, narrow window on the same field, so it needs a
          // wider lens to see more than one plate at a time.
          camera={{ position: [0.9, 0.35, 7.4], fov: small ? 54 : 40 }}
          dpr={small ? [1, 1.3] : [1, 1.75]}
          gl={{ antialias: true, powerPreference: "high-performance" }}
        >
          <ScrollControls pages={PAGES} damping={0.22}>
            <World
              data={data}
              pictures={pictures}
              plateCount={small ? 20 : 40}
              particles={small ? 110 : 220}
              spread={small ? 0.55 : 1}
              framing={small ? 0.3 : 1}
              reach={small ? 1.4 : 1}
              credential={credential}
              dropped={dropped}
            />
          </ScrollControls>
          <AdaptiveDpr pixelated />
          <Preload all />
        </Canvas>

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

        {/* A phone has no room at the sides, so the type sits at the bottom of
            the frame and the scrim comes up to meet it. */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 z-10 sm:hidden"
          style={{
            background:
              "linear-gradient(0deg, rgba(11,11,12,0.92) 0%, rgba(11,11,12,0.55) 34%, rgba(11,11,12,0) 62%)," +
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

        <TryPanel onPreview={setDropped} />
        <CloseCard data={data} />
        <ScrollCue />
      </div>
    </SceneBoundary>
  );
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
      className="pointer-events-none absolute inset-0 flex items-end px-5 pb-24 pt-[73px] sm:items-center sm:px-8 lg:px-14"
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
 * two nodes from an animation frame so the scene never shares a render with
 * them.
 */
function Ladder({ label }: { label: string }) {
  const name = useRef<HTMLSpanElement>(null);
  const value = useRef<HTMLSpanElement>(null);
  const steps = useMemo(() => degradeSteps(), []);

  useEffect(() => {
    let frame = 0;
    let shownIndex = -1;

    const loop = () => {
      const at = Math.min(steps.length - 1, Math.floor(progress.verified * steps.length));
      if (at !== shownIndex && progress.verified > 0) {
        shownIndex = at;
        if (name.current !== null) {
          name.current.textContent = steps[at].transform;
        }
        if (value.current !== null) {
          value.current.textContent = steps[at].confidence.toFixed(2);
        }
      }
      frame = requestAnimationFrame(loop);
    };

    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, [steps]);

  return (
    <div className="mt-7 flex items-end gap-4">
      <span
        ref={value}
        className="font-display text-[clamp(2.6rem,6vw,4.6rem)] font-semibold leading-[0.85] tracking-[-0.05em] tabular-nums text-accent"
      >
        {steps[0].confidence.toFixed(2)}
      </span>
      <span className="pb-2">
        <span ref={name} className="block font-mono text-[12px] uppercase tracking-[0.14em] text-text">
          {steps[0].transform}
        </span>
        <span className="block font-mono text-[11px] uppercase tracking-[0.14em] text-text-faint">{label}</span>
      </span>
    </div>
  );
}
