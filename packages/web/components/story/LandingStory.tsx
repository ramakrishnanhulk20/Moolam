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
import { beat, probe, scroller } from "@/components/story/signals";
import type { StoryData } from "@/components/story/data";
import { degradeSteps, measurement } from "@/components/hero/still";
import { shortHex } from "@/lib/chain/client";

const PAGES = 9;

/** Where each caption is pinned, in pages of scroll. */
const CAPTION_PAGE = { made: 1, sealed: 2, shared: 3, verified: 4.5, trusted: 6 } as const;

type Key = { at: number; pos: [number, number, number]; look: [number, number, number] };

/**
 * The camera path. Nine named positions, blended with a smoothstep, then the
 * camera eases toward the blended point every frame, so a fast scroll pulls the
 * camera rather than teleporting it.
 */
const KEYS: Key[] = [
  { at: 0.0, pos: [0.9, 0.35, 7.4], look: [0, 0, 0] },
  { at: 0.09, pos: [0.55, 0.2, 5.4], look: [0, 0, 0] },
  { at: 0.17, pos: [0.35, 0.05, 3.75], look: [0, 0, 0] },
  { at: 0.26, pos: [-0.75, 0.42, 3.5], look: [0.06, -0.05, 0] },
  { at: 0.34, pos: [0.3, 0.12, 4.1], look: [0, 0, 0] },
  { at: 0.42, pos: [1.4, 0.8, 6.4], look: [0.2, 0, 0] },
  { at: 0.5, pos: [2.6, 1.2, 8.2], look: [0.5, 0.1, -0.5] },
  { at: 0.58, pos: [2.1, 1.7, 6.0], look: [1.7, 1.4, 1.2] },
  { at: 0.66, pos: [0.7, 0.55, 4.3], look: [0.1, 0.05, 0.2] },
  { at: 0.72, pos: [0.2, 0.1, 3.7], look: [0, 0, 0] },
  { at: 0.79, pos: [-1.9, 0.4, 4.6], look: [-0.45, 0.05, 0] },
  { at: 0.86, pos: [-0.75, 0.05, 3.9], look: [-0.2, 0, 0] },
  { at: 0.93, pos: [0.3, 0.25, 5.4], look: [0, 0, 0] },
  { at: 1.0, pos: [0.6, 0.9, 8.6], look: [0, -0.3, -2] },
];

function sampleKeys(t: number, outPos: THREE.Vector3, outLook: THREE.Vector3) {
  const clamped = Math.min(1, Math.max(0, t));
  let a = KEYS[0];
  let b = KEYS[KEYS.length - 1];
  for (let index = 0; index < KEYS.length - 1; index += 1) {
    if (clamped >= KEYS[index].at && clamped <= KEYS[index + 1].at) {
      a = KEYS[index];
      b = KEYS[index + 1];
      break;
    }
  }
  const span = b.at - a.at || 1;
  const raw = (clamped - a.at) / span;
  const k = raw * raw * (3 - 2 * raw);
  outPos.set(
    a.pos[0] + (b.pos[0] - a.pos[0]) * k,
    a.pos[1] + (b.pos[1] - a.pos[1]) * k,
    a.pos[2] + (b.pos[2] - a.pos[2]) * k,
  );
  outLook.set(
    a.look[0] + (b.look[0] - a.look[0]) * k,
    a.look[1] + (b.look[1] - a.look[1]) * k,
    a.look[2] + (b.look[2] - a.look[2]) * k,
  );
}

function ramp(t: number, start: number, span: number): number {
  return THREE.MathUtils.clamp((t - start) / span, 0, 1);
}

function World({
  data,
  pictures,
  plateCount,
  particles,
  spread,
  credential,
  dropped,
}: {
  data: StoryData;
  pictures: string[];
  plateCount: number;
  spread: number;
  particles: number;
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

    sampleKeys(t, pos, look);
    camera.position.lerp(pos, k);
    smoothLook.current.lerp(look, k);
    camera.lookAt(smoothLook.current);

    approach.current = ramp(t, 0.02, 0.1);
    made.current = ramp(t, 0.12, 0.1);
    sealed.current = ramp(t, 0.235, 0.085);
    shared.current = ramp(t, 0.345, 0.13);
    verified.current = ramp(t, 0.52, 0.14);

    // The field dims while the camera is close to one plate, and comes back up
    // for the last screen, where the story is about how many there are.
    fade.current = 1 - 0.68 * ramp(t, 0.1, 0.08) * (1 - ramp(t, 0.8, 0.1));

    const offer = ramp(t, 0.775, 0.06);
    probing.current = offer * (1 - ramp(t, 0.885, 0.06)) * (probe.state === "idle" ? 0.35 : 1);
    answer.current = probe.state === "matched" ? 1 : probe.state === "refused" ? 2 : verified.current > 0.98 ? 1 : 0;

    beat.scroll = t;
    beat.made = made.current;
    beat.sealed = sealed.current;
    beat.shared = shared.current;
    beat.verified = verified.current;
    beat.trusted = ramp(t, 0.665, 0.08);
    beat.offer = offer;
    beat.close = ramp(t, 0.885, 0.06);
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
  key: string;
  page: number;
  align: "start" | "end";
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
      page: CAPTION_PAGE.made,
      align: "start",
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
      page: CAPTION_PAGE.sealed,
      align: "start",
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
      page: CAPTION_PAGE.shared,
      align: "end",
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
      page: CAPTION_PAGE.verified,
      align: "start",
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
      page: CAPTION_PAGE.trusted,
      align: "end",
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
      <div className="grain relative h-[100svh] w-full overflow-hidden bg-bg" data-lenis-prevent>
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

        {/* The captions ride the same scroll as the camera but live outside the
            canvas, so the scrim above the scene still sits behind the words. */}
        <CaptionLayer>
          <Opening title={t("title")} kicker={t("kicker")} line={t("line")} />
          {beats.map((entry) => (
            <Caption key={entry.key} page={entry.page} align={entry.align}>
              {entry.body}
            </Caption>
          ))}
        </CaptionLayer>

        <TryPanel onPreview={setDropped} />
        <CloseCard data={data} />
        <ScrollCue />
      </div>
    </SceneBoundary>
  );
}

function CaptionLayer({ children }: { children: ReactNode }) {
  const inner = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let frame = 0;
    let shown = -1;

    const loop = () => {
      const node = inner.current;
      const stage = node?.parentElement;
      if (node != null && stage != null) {
        const y = -beat.scroll * (PAGES - 1) * stage.clientHeight;
        if (y !== shown) {
          shown = y;
          node.style.transform = `translate3d(0, ${y}px, 0)`;
          // The captions step aside for the panel a visitor can use, so the two
          // never share a screen on a phone.
          node.style.opacity = String(1 - Math.max(beat.offer, beat.close));
        }
      }
      frame = requestAnimationFrame(loop);
    };

    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, []);

  return (
    <div className="pointer-events-none absolute inset-0 z-20 overflow-hidden">
      <div ref={inner} className="absolute inset-x-0 top-0" style={{ willChange: "transform" }}>
        {children}
      </div>
    </div>
  );
}

function Opening({ kicker, title, line }: { kicker: string; title: string; line: string }) {
  return (
    <div
      className="pointer-events-none absolute inset-x-0 flex items-end px-5 pb-24 pt-[73px] sm:items-center sm:px-8 sm:pb-0 lg:px-14"
      style={{ top: 0, height: "100svh" }}
    >
      <div className="mx-auto w-full max-w-[100rem]">
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
      </div>
    </div>
  );
}

function Caption({ children, page, align }: { children: ReactNode; page: number; align: "start" | "end" }) {
  return (
    <div
      className="pointer-events-none absolute inset-x-0 flex items-end px-5 pb-24 pt-[73px] sm:items-center sm:px-8 sm:pb-0 lg:px-14"
      style={{ top: `${page * 100}svh`, height: "100svh" }}
    >
      <div className={`mx-auto w-full max-w-[100rem] ${align === "end" ? "sm:text-end" : ""}`}>{children}</div>
    </div>
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
      const at = Math.min(steps.length - 1, Math.floor(beat.verified * steps.length));
      if (at !== shownIndex && beat.verified > 0) {
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
