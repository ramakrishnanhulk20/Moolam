"use client";

import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { useReducedMotion } from "framer-motion";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { PlateField, useField } from "@/components/story/scene/field";
import { Picture } from "@/components/passport/Picture";
import { pictureSources } from "@/lib/images";
import { BEAT } from "@/components/story/beats";
import type { StoryData } from "@/components/story/data";
import { HeroCredits } from "@/components/story/HeroCredits";

/** How many plates the field hangs. It is the top tier's own number. */
const PLATES = 40;

/** How much of the pinned screen the shot takes on a phone, the film's number. */
const PHONE_BAND = 0.45;

/**
 * The first screen with the credit block Ram picked, on the live field.
 *
 * Every plate behind the words is a real registered picture off the live index,
 * and the shot is the film's own opening pose, so the block is seen on the
 * ground it ships on. Nothing links to this page and it never ships, so the
 * bench's own labels are English.
 */
export function HeroBench({ data, asked }: { data: StoryData; asked: number | null }) {
  const pictures = useMemo(() => [...new Set(data.plates.map((plate) => plate.picture))], [data.plates]);

  return (
    <div className="min-h-screen bg-bg px-5 pb-24 pt-24 sm:px-8 lg:px-14">
      <header className="mx-auto w-full max-w-[100rem]">
        <p className="flex items-center gap-3 font-mono text-[11px] uppercase tracking-[0.24em] text-accent">
          <span className="motif h-[9px] w-[9px]" />
          Hero bench
        </p>
        <h1 className="mt-6 max-w-[20ch] font-display text-[clamp(2.4rem,7vw,5rem)] font-semibold uppercase leading-[0.92] tracking-[-0.045em]">
          The poster credit block on the first screen
        </h1>
        <p className="mt-6 max-w-[62ch] text-base leading-relaxed text-text-muted">
          The opening shot with the block that now ships on the film: one mono line at the foot of the frame on the
          title&apos;s left edge, the filled call and the outlined one under it. This is the same component the home
          page renders, so what changes here changes there.
        </p>
        <p className="mt-5 font-mono text-[11px] uppercase tracking-[0.16em] text-text-faint">
          Field: {pictures.length} real {pictures.length === 1 ? "picture" : "pictures"}
          {asked === null ? "" : `, capped at ${asked} by the plates parameter`}. Add ?plates=8 or ?plates=13 to the
          address to see either count.
        </p>
      </header>

      <div className="mx-auto mt-16 w-full max-w-[100rem]">
        <Pane pictures={pictures} />
      </div>
    </div>
  );
}

/**
 * The credits wait for the title, the same 980 ms the film waits.
 */
function Credits() {
  const [entered, setEntered] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => setEntered(true), 980);
    return () => window.clearTimeout(timer);
  }, []);

  return <HeroCredits entered={entered} />;
}

/** The opening shot with the credit block over it. */
function Pane({ pictures }: { pictures: string[] }) {
  const t = useTranslations("story");
  const reduced = useReducedMotion();
  const [small, setSmall] = useState(false);

  useEffect(() => {
    const query = window.matchMedia("(max-width: 767px)");
    const read = () => setSmall(query.matches);
    read();
    query.addEventListener("change", read);
    return () => query.removeEventListener("change", read);
  }, []);

  return (
    <div
      data-hero-pane="credit"
      data-motif="seal"
      // The film's own palette, which is dark whether the site's toggle says
      // light or dark. The words are judged on the ground they will have.
      className="story grain relative h-[86svh] min-h-[32rem] w-full overflow-hidden border border-line bg-bg"
    >
      {reduced === true ? (
        <StillField pictures={pictures} />
      ) : (
        <div className="story-stage">
          <Canvas
            camera={{ position: BEAT.opening.arrive.pos, fov: small ? 54 : 40 }}
            dpr={[1, 1.75]}
            gl={{ antialias: true, powerPreference: "high-performance" }}
          >
            <OpeningShot
              pictures={pictures}
              spread={small ? 0.55 : 1}
              framing={small ? 0.2 : 1}
              reach={small ? 1.12 : 1}
            />
            <Band fraction={small ? PHONE_BAND : 1} />
          </Canvas>
        </div>
      )}

      {/* The film's own two scrims, so the words are judged over the ground
          they will really have. */}
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
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 z-10 sm:hidden"
        style={{
          background:
            "linear-gradient(180deg, rgba(11,11,12,0) 28%, rgba(11,11,12,0.72) 41%, #0B0B0C 46%)," +
            "linear-gradient(180deg, rgba(11,11,12,0.86) 0%, rgba(11,11,12,0) 18%)",
        }}
      />

      <div className="story-lower pointer-events-none z-20 px-5 sm:px-8 lg:px-14">
        <div className="mx-auto w-full max-w-[100rem]">
          <Words kicker={t("kicker")} title={t("title")} line={t("line")} />
          {/* A phone has no foot to hang a credit block from: the shot ends at
              45 percent of the pane and the words own everything below it. So
              on a phone the same block follows the tagline with a poster's gap
              instead of sitting on the floor of the frame. */}
          <div className="mt-8 sm:hidden">
            <Credits />
          </div>
        </div>
      </div>

      <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 hidden px-5 pb-10 sm:block sm:px-8 lg:px-14">
        <div className="mx-auto w-full max-w-[100rem]">
          <Credits />
        </div>
      </div>
    </div>
  );
}

/** The film's opening words, at the film's own sizes and on its own entrance. */
function Words({ kicker, title, line }: { kicker: string; title: string; line: string }) {
  return (
    <>
      <p className="story-enter flex items-center gap-3 font-mono text-[11px] uppercase tracking-[0.24em] text-accent">
        <span className="motif h-[9px] w-[9px]" />
        {kicker}
      </p>
      <h2
        className="story-enter mt-6 font-display text-[clamp(3rem,9vw,8rem)] font-semibold uppercase leading-[0.95] tracking-[-0.045em]"
        style={{ animationDelay: "90ms" }}
      >
        {title}
      </h2>
      <p
        className="story-enter mt-6 max-w-[34ch] text-[clamp(1rem,1.5vw,1.35rem)] leading-relaxed text-text-muted"
        style={{ animationDelay: "180ms" }}
      >
        {line}
      </p>
    </>
  );
}

/**
 * The field at the opening beat, breathing between the beat's two poses.
 *
 * The film travels this stretch on the reader's scroll. There is no scroll on
 * the bench, so the camera eases back and forth across the same two poses: the
 * shot is alive, and it never leaves the frame the buttons are being judged in.
 */
function OpeningShot({
  pictures,
  spread,
  framing,
  reach,
}: {
  pictures: string[];
  spread: number;
  framing: number;
  reach: number;
}) {
  const field = useField(PLATES, pictures, spread);
  const { camera } = useThree();
  const fade = useRef(1);
  const look = useMemo(() => new THREE.Vector3(), []);

  useFrame(({ clock }) => {
    const from = BEAT.opening.arrive;
    const to = BEAT.opening.settle;
    const k = (1 - Math.cos(clock.elapsedTime * 0.11)) / 2;
    camera.position.set(
      from.pos[0] + (to.pos[0] - from.pos[0]) * k,
      from.pos[1] + (to.pos[1] - from.pos[1]) * k,
      (from.pos[2] + (to.pos[2] - from.pos[2]) * k) * reach,
    );
    look.set(
      (from.look[0] + (to.look[0] - from.look[0]) * k) * framing,
      from.look[1] + (to.look[1] - from.look[1]) * k,
      from.look[2] + (to.look[2] - from.look[2]) * k,
    );
    camera.lookAt(look);
  });

  return (
    <>
      <color attach="background" args={["#0B0B0C"]} />
      <fogExp2 attach="fog" args={["#0B0B0C", 0.052]} />
      <PlateField field={field} fade={fade} />
    </>
  );
}

/**
 * Keeps the shot in the top band of the pane on a phone, exactly as the film
 * does, so the framing being judged is the framing that ships.
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

/**
 * The same pictures with nothing moving, for a reader who has asked for less
 * motion. The film answers that with its still page, and the bench answers it
 * with a still field: the placement is still the thing being judged.
 */
function StillField({ pictures }: { pictures: string[] }) {
  return (
    <div aria-hidden className="absolute inset-0">
      {pictures.slice(0, 6).map((picture, at) => {
        const lane = at % 3;
        return (
          <div
            key={`${picture}-${at}`}
            className="absolute overflow-hidden border border-white/10"
            style={{
              top: ["6%", "38%", "12%"][lane],
              left: `${6 + at * 15}%`,
              width: [180, 240, 150][lane],
              height: [180, 240, 150][lane] * 0.72,
              boxShadow: "0 24px 60px rgb(0 0 0 / 0.5)",
            }}
          >
            {/* Registered pictures, read through the optimizer rather than from
                the gateway on every view. */}
            <Picture sources={pictureSources(picture)} sizes="256px" className="object-cover" />
          </div>
        );
      })}
    </div>
  );
}
