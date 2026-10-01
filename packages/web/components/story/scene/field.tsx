"use client";

import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import * as THREE from "three";
import { expectPlates, plateDrawn } from "./drawn";
import { fieldPlates, sequence, type FieldPlate } from "./order";
import { degradedTexture, glowTexture, loadTexture, noiseTexture, type Degrade } from "./textures";
import { LABEL_ASPECT, TAG_ASPECT, inkSpread, kolamStamp, labelStrip, printShadow, stampedTag } from "./marks";
import {
  CHECKED_STEPS,
  FOUND,
  LOOKALIKE_STEPS,
  SIGNED,
  YOURSELF_STEPS,
  easeOut,
  played,
  smooth,
  span,
  within,
  type BeatName,
  type BeatTable,
} from "@/components/story/beats";
import type { RoomPalette } from "@/components/story/palette";
import { plateEdge, resetPlateEdge } from "@/components/story/signals";

/**
 * What the scene's parts read from the world on every frame: where the scroll
 * is, and what the visitor's own check answered. Written by the World's frame,
 * never through React.
 */
export interface SceneSignal {
  /** 0 to 1 across the whole film. */
  t: number;
  /** 0 nothing yet, 1 a match, 2 a refusal, for the print's edge. */
  answer: number;
  /** How much the drop panel's own file shows on the print, 0 to 1. */
  probing: number;
}

/** What every part of the scene is handed: the cut, the room, and the signal. */
export interface SceneParts {
  table: BeatTable;
  /** The room as the frames read it, so a theme switch repaints without a restart. */
  roomRef: RefObject<RoomPalette>;
  /** The same room as a value, for the textures drawn once per colour. */
  palette: RoomPalette;
  signalRef: RefObject<SceneSignal>;
}

/**
 * The field, with a picture on every plate.
 *
 * The spots and their order come from scene/order.ts, which the page that holds
 * the film's box open reads as well: the plate that stands largest in the
 * opening frame takes the first picture, and that is the picture the document
 * has already asked for.
 */
export function useField(
  count: number,
  pictures: string[],
  spread: number,
  eye: readonly [number, number, number],
): FieldPlate[] {
  return useMemo(() => fieldPlates(count, pictures, spread, eye), [count, pictures, spread, eye]);
}

function useAsyncTexture(url: string | null): THREE.Texture | null {
  const [loaded, setLoaded] = useState<{ url: string; texture: THREE.Texture } | null>(null);

  useEffect(() => {
    if (url === null) {
      return;
    }
    let live = true;
    loadTexture(url)
      .then((texture) => {
        if (live) {
          setLoaded({ url, texture });
        }
      })
      .catch(() => {
        // A gateway that will not serve one picture leaves that print empty.
      });
    return () => {
      live = false;
    };
  }, [url]);

  // Keyed by the address it was loaded from, so a print never shows the picture
  // that belonged to the address before it.
  return loaded !== null && loaded.url === url ? loaded.texture : null;
}

/** The same picture, actually put through one of the verifier's transforms. */
function useDegradedTexture(url: string | null, kind: Degrade | null): THREE.Texture | null {
  const [loaded, setLoaded] = useState<{ key: string; texture: THREE.Texture } | null>(null);
  const key = url === null || kind === null ? null : `${kind}:${url}`;

  useEffect(() => {
    if (url === null || kind === null) {
      return;
    }
    let live = true;
    degradedTexture(url, kind)
      .then((texture) => {
        if (live) {
          setLoaded({ key: `${kind}:${url}`, texture });
        }
      })
      .catch(() => {
        // The copy falls back to the picture it was made from.
      });
    return () => {
      live = false;
    };
  }, [url, kind]);

  return loaded !== null && loaded.key === key ? loaded.texture : null;
}

function aspectOf(texture: THREE.Texture | null): number {
  const image = texture?.image as { width?: number; height?: number } | undefined;
  if (image?.width === undefined || image.height === undefined || image.height === 0) {
    return 4 / 3;
  }
  return image.width / image.height;
}

/**
 * The layers a print is made of.
 *
 * In light a print is a picture on a paper border with a soft shadow under it:
 * glow is added light and vanishes on paper. In dark it is the film's glass, the
 * picture with a faint added edge round it. Both sets are always mounted and
 * the room picks which is drawn, so a theme switch never restarts the scene.
 */
interface PrintLayers {
  shadow: THREE.Mesh | null;
  paper: THREE.Mesh | null;
  glow: THREE.Mesh | null;
  picture: THREE.MeshBasicMaterial | null;
  face: THREE.Mesh | null;
}

function paintPrint(
  layers: PrintLayers,
  room: RoomPalette,
  shown: number,
  options: { picture?: number; glowShare?: number; edge?: THREE.Color } = {},
) {
  const picture = options.picture ?? shown;
  if (layers.picture !== null) {
    layers.picture.opacity = picture;
    // A see-through plane still writes depth, and an invisible copy left on the
    // print would cut a hole in whatever hangs behind it.
    layers.picture.visible = picture > 0.002;
  }
  if (layers.shadow !== null) {
    layers.shadow.visible = !room.glows && shown > 0.002;
    const material = layers.shadow.material as THREE.MeshBasicMaterial;
    material.opacity = room.shadowOpacity * shown;
    material.color.set(room.shadow);
  }
  if (layers.paper !== null) {
    layers.paper.visible = !room.glows && shown > 0.002;
    const material = layers.paper.material as THREE.MeshBasicMaterial;
    material.opacity = shown;
    material.color.set(room.paper);
  }
  if (layers.glow !== null) {
    layers.glow.visible = room.glows && shown > 0.002;
    const material = layers.glow.material as THREE.MeshBasicMaterial;
    material.opacity = shown * (options.glowShare ?? 0.34);
    if (options.edge === undefined) {
      material.color.set(room.accent);
    } else {
      material.color.copy(options.edge);
    }
  }
}

function useLayers(): RefObject<PrintLayers> {
  return useRef<PrintLayers>({ shadow: null, paper: null, glow: null, picture: null, face: null });
}

function PrintMeshes({
  width,
  height,
  texture,
  mirror = false,
  layersRef,
}: {
  width: number;
  height: number;
  texture: THREE.Texture | null;
  mirror?: boolean;
  layersRef: RefObject<PrintLayers>;
}) {
  const shadow = useMemo(() => printShadow(), []);
  const pictureRef = useRef<THREE.MeshBasicMaterial>(null);
  const border = height * 0.045;

  // Three only compiles a texture into a material's shader when the material is
  // told it changed. Setting map and leaving it at that gives a flat white
  // plane, which is exactly what the field did before this existed.
  useEffect(() => {
    if (pictureRef.current !== null) {
      pictureRef.current.needsUpdate = true;
    }
  }, [texture]);

  return (
    <>
      <mesh
        ref={(node) => {
          layersRef.current.shadow = node;
        }}
        position={[height * 0.03, -height * 0.05, -0.03]}
        scale={[width * 1.32 + 0.12, height * 1.32 + 0.12, 1]}
        visible={false}
      >
        <planeGeometry args={[1, 1]} />
        <meshBasicMaterial map={shadow} transparent opacity={0} depthWrite={false} toneMapped={false} />
      </mesh>
      <mesh
        ref={(node) => {
          layersRef.current.paper = node;
        }}
        position={[0, 0, -0.01]}
        scale={[width + border * 2, height + border * 2, 1]}
        visible={false}
      >
        <planeGeometry args={[1, 1]} />
        <meshBasicMaterial transparent opacity={0} toneMapped={false} />
      </mesh>
      <mesh
        ref={(node) => {
          layersRef.current.glow = node;
        }}
        position={[0, 0, -0.012]}
        scale={[width + 0.05, height + 0.05, 1]}
        visible={false}
      >
        <planeGeometry args={[1, 1]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} blending={THREE.AdditiveBlending} />
      </mesh>
      <mesh
        ref={(node) => {
          layersRef.current.face = node;
        }}
        scale={[mirror ? -width : width, height, 1]}
      >
        <planeGeometry args={[1, 1]} />
        <meshBasicMaterial
          ref={(node) => {
            pictureRef.current = node;
            layersRef.current.picture = node;
          }}
          map={texture}
          transparent
          opacity={0}
          toneMapped={false}
        />
      </mesh>
    </>
  );
}

function Plate({
  plate,
  fadeRef,
  roomRef,
  at,
}: {
  plate: FieldPlate;
  fadeRef: RefObject<number>;
  roomRef: RefObject<RoomPalette>;
  at: number;
}) {
  const texture = useAsyncTexture(plate.url);
  const group = useRef<THREE.Group>(null);
  const layersRef = useLayers();
  const aspect = aspectOf(texture);

  // The renderer says when this plate was really on screen. Frustum culling
  // means a plate behind the camera never gets here, and the opacity test keeps
  // out the frame where the material has its picture but the field has not
  // faded it up yet.
  useEffect(() => {
    const node = layersRef.current.face;
    if (node === null || texture === null) {
      return;
    }
    const nothing = () => undefined;
    node.onAfterRender = () => {
      const picture = layersRef.current.picture;
      if (picture === null || picture.opacity <= 0.01) {
        return;
      }
      node.onAfterRender = nothing;
      plateDrawn(String(at));
    };
    return () => {
      node.onAfterRender = nothing;
    };
  }, [at, layersRef, texture]);

  useFrame(({ clock }) => {
    const node = group.current;
    if (node === null) {
      return;
    }
    const time = clock.elapsedTime;
    node.position.y = plate.position[1] + Math.sin(time * 0.3 + plate.phase) * 0.1;
    node.rotation.y = Math.sin(time * 0.21 + plate.phase) * 0.07;
    node.rotation.z = Math.sin(time * 0.16 + plate.phase) * 0.02;
    paintPrint(layersRef.current, roomRef.current, texture === null ? 0 : fadeRef.current);
  });

  return (
    <group ref={group} position={plate.position}>
      <PrintMeshes width={plate.height * aspect} height={plate.height} texture={texture} layersRef={layersRef} />
    </group>
  );
}

export function PlateField({
  field,
  fadeRef,
  roomRef,
}: {
  field: FieldPlate[];
  fadeRef: RefObject<number>;
  roomRef: RefObject<RoomPalette>;
}) {
  expectPlates(field.length);

  return (
    <group>
      {field.map((plate, index) => (
        <Plate key={`${plate.url}-${index}`} plate={plate} fadeRef={fadeRef} roomRef={roomRef} at={index} />
      ))}
    </group>
  );
}

/**
 * The specks that gather into the picture in the imagined beat: ink in the
 * light room, the film's pink light in dark.
 */
function Gather({
  table,
  signalRef,
  roomRef,
  height,
  width,
  count,
}: {
  table: BeatTable;
  signalRef: RefObject<SceneSignal>;
  roomRef: RefObject<RoomPalette>;
  height: number;
  width: number;
  count: number;
}) {
  const mesh = useRef<THREE.InstancedMesh>(null);
  const material = useRef<THREE.MeshBasicMaterial>(null);
  const dummy = useMemo(() => new THREE.Object3D(), []);

  const seeds = useMemo(() => {
    const noise = sequence(7, count * 5);
    return Array.from({ length: count }, (_, index) => {
      const at = index * 5;
      const angle = noise[at] * Math.PI * 2;
      const tilt = (noise[at + 1] - 0.5) * Math.PI;
      const radius = 2.4 + noise[at + 2] * 2.6;
      return {
        from: [
          Math.cos(angle) * Math.cos(tilt) * radius,
          Math.sin(tilt) * radius * 0.7,
          Math.sin(angle) * Math.cos(tilt) * radius + 1.2,
        ] as [number, number, number],
        to: [(noise[at + 3] - 0.5) * width, (noise[at + 4] - 0.5) * height, 0.02] as [number, number, number],
        delay: noise[at] * 0.32,
      };
    });
  }, [count, height, width]);

  useFrame(() => {
    const node = mesh.current;
    if (node === null) {
      return;
    }
    const imagined = table.beat.imagined;
    const progress = imagined === undefined ? 0 : played(signalRef.current.t, imagined);
    const room = roomRef.current;
    if (material.current !== null) {
      material.current.color.set(room.glows ? room.accent : room.ink);
      material.current.blending = room.glows ? THREE.AdditiveBlending : THREE.NormalBlending;
      material.current.opacity = room.glows ? 0.9 : 0.75;
    }

    for (let index = 0; index < count; index += 1) {
      const seed = seeds[index];
      const local = THREE.MathUtils.clamp((progress - seed.delay) / 0.55, 0, 1);
      const eased = 1 - Math.pow(1 - local, 3);

      if (progress <= 0.001 || local >= 1) {
        dummy.scale.setScalar(0);
      } else {
        dummy.scale.setScalar((room.glows ? 0.022 : 0.016) * (1 - eased * 0.55));
      }

      dummy.position.set(
        seed.from[0] + (seed.to[0] - seed.from[0]) * eased,
        seed.from[1] + (seed.to[1] - seed.from[1]) * eased,
        seed.from[2] + (seed.to[2] - seed.from[2]) * eased,
      );
      dummy.updateMatrix();
      node.setMatrixAt(index, dummy.matrix);
    }
    node.instanceMatrix.needsUpdate = true;
  });

  return (
    <instancedMesh key={count} ref={mesh} args={[undefined, undefined, count]} frustumCulled={false}>
      <planeGeometry args={[1, 1]} />
      <meshBasicMaterial ref={material} transparent opacity={0.9} depthWrite={false} />
    </instancedMesh>
  );
}

/** Where the film frames itself as a phone, the same width LandingStory reads. */
const PHONE_FILM = "(max-width: 767px)";

/** How bright the picture already is on a phone while the camera comes in, before the imagined beat inks it. */
const PHONE_FLOOR = 0.4;

/** True while the window is as narrow as the film's phone framing. */
function usePhoneFilm(): boolean {
  const [phone, setPhone] = useState(false);
  useEffect(() => {
    const query = window.matchMedia(PHONE_FILM);
    const read = () => setPhone(query.matches);
    read();
    query.addEventListener("change", read);
    return () => query.removeEventListener("change", read);
  }, []);
  return phone;
}

/**
 * How strongly the focal print draws its static and its picture on one frame.
 *
 * On a laptop in the dark room the print comes in as grey static beside the
 * words and the picture forms inside it as the imagined beat plays; in the
 * light room it is blank paper the picture inks into. On a phone the static
 * was the only large thing in the frame for three stops, a grey square that
 * read as a picture that failed to load, so a phone never draws it: the
 * picture fades up with the print, held dim like a print in the developer, and
 * comes to full strength over the same stretch the laptop uses.
 *
 * A print whose picture has not arrived shows nothing rather than a blank
 * square: a material with no map at some opacity is a flat white card.
 */
export function focalInks({
  entry,
  made,
  swapped,
  pictured,
  phone,
}: {
  entry: number;
  made: number;
  /** How far the visitor's own file has replaced the picture, 0 to 1. */
  swapped: number;
  pictured: boolean;
  phone: boolean;
}): { grain: number; picture: number } {
  const develop = THREE.MathUtils.clamp((made - 0.35) / 0.45, 0, 1);
  const grain = phone ? 0 : entry * Math.max(0, 1 - made * 1.5);
  if (!pictured) {
    return { grain, picture: 0 };
  }
  const strength = phone ? PHONE_FLOOR + (1 - PHONE_FLOOR) * develop : develop;
  return { grain, picture: entry * strength * (1 - swapped) };
}

/** The beats the main print steps away for, in playing order. */
const AWAY: BeatName[] = ["lookalike", "yourself", "waiting"];

/**
 * How far the main print has stepped back into the wall, 0 to 1.
 *
 * The look-alike, sign-it-yourself and waiting beats are about other pictures,
 * so the print steps back for the first of them that is in the cut and comes
 * home for the drop panel, the one beat after them that needs it.
 */
export function awayOf(table: BeatTable, t: number): number {
  const away = AWAY.map((name) => table.beat[name]).filter((beat) => beat !== undefined);
  if (away.length === 0) {
    return 0;
  }
  const first = away[0];
  const last = away[away.length - 1];
  const before = table.beats[table.beats.indexOf(first) - 1];
  const leave = smooth(span(t, before.captionEnd, first.start + (first.end - first.start) * 0.06));
  const back = smooth(span(t, last.captionEnd, table.beat.offer.start));
  return leave * (1 - back);
}

/** How far the imagined beat has run, or done when the cut has none. */
function madeOf(table: BeatTable, t: number): number {
  const imagined = table.beat.imagined;
  return imagined === undefined ? (t >= table.beat.sealed.start ? 1 : 0) : played(t, imagined);
}

/** The camera coming in on the print, 0 on the title frame and 1 on it. */
function approachOf(table: BeatTable, t: number): number {
  const first = table.beat.imagined ?? table.beat.sealed;
  return span(t, table.beat.opening.captionEnd, first.start);
}

/** A circle as a line, so the checked beat can draw it a little more each frame. */
function circleLine(radius: number, points = 160): THREE.Line {
  const geometry = new THREE.BufferGeometry();
  const vertices = new Float32Array((points + 1) * 3);
  for (let index = 0; index <= points; index += 1) {
    const angle = Math.PI / 2 - (index / points) * Math.PI * 2;
    vertices[index * 3] = Math.cos(angle) * radius;
    vertices[index * 3 + 1] = Math.sin(angle) * radius;
    vertices[index * 3 + 2] = 0.03;
  }
  geometry.setAttribute("position", new THREE.BufferAttribute(vertices, 3));
  geometry.setDrawRange(0, 0);
  return new THREE.Line(geometry, new THREE.LineBasicMaterial({ transparent: true, depthWrite: false }));
}

/**
 * The print the story is about: blank paper or static, then the picture inked
 * in, then the kolam stamped on its corner, the edge answering when the copy
 * comes home or the visitor drops a file, and in the checked beat a hairline
 * round it and, only for a verdict Chainlink's network wrote, the mark.
 */
export function FocalPlate({
  url,
  dropped,
  particles,
  parts,
  snappedRef,
  checkWord,
  edge: tracksEdge = false,
  height = 1.7,
}: {
  url: string | null;
  /** The visitor's own file, shown on the print while their check runs. */
  dropped: string | null;
  /** Halved on a phone, where the same cloud costs the same frame on a smaller GPU. */
  particles: number;
  parts: SceneParts;
  /** The clock time the copy landed, or -1 while it is still on its way. */
  snappedRef: RefObject<number>;
  /** The mark's word, for a verdict Chainlink's network delivered; null leaves the mark off. */
  checkWord: string | null;
  /** True only on a cut with the terms beat, which needs the lower edge on screen. */
  edge?: boolean;
  height?: number;
}) {
  const { table, roomRef, palette, signalRef } = parts;
  const texture = useAsyncTexture(url);
  const droppedTexture = useAsyncTexture(dropped);
  const phone = usePhoneFilm();
  const noise = useMemo(() => noiseTexture(72), []);
  const glow = useMemo(() => glowTexture(), []);
  const ring = useMemo(() => circleLine(1), []);
  const ringRef = useRef<THREE.Line>(null);

  const aspect = aspectOf(texture);
  const width = height * aspect;
  const stampSize = height * 0.27;
  const corner: [number, number] = [width * 0.36, -height * 0.31];

  const group = useRef<THREE.Group>(null);
  const layersRef = useLayers();
  const grain = useRef<THREE.MeshBasicMaterial>(null);
  const visitor = useRef<THREE.MeshBasicMaterial>(null);
  const frame = useRef<THREE.Mesh>(null);
  const ripple = useRef<THREE.Mesh>(null);
  const stamp = useRef<THREE.Mesh>(null);
  const spread = useRef<THREE.Mesh>(null);
  const mark = useRef<THREE.Mesh>(null);
  const landedAt = useRef(-1);
  const edgeColor = useMemo(() => new THREE.Color(), []);
  const target = useMemo(() => new THREE.Color(), []);
  const corners = useMemo(() => new THREE.Vector3(), []);

  useEffect(() => {
    if (visitor.current !== null) {
      visitor.current.needsUpdate = true;
    }
  }, [droppedTexture]);

  // The rule over the film follows the edge this print publishes, and only a cut
  // with the terms beat publishes one. A cut change or a scene that has gone
  // leaves it with the last place a print stood, so it is put back here.
  useEffect(() => {
    if (!tracksEdge) {
      resetPlateEdge();
    }
    return resetPlateEdge;
  }, [tracksEdge]);

  useFrame(({ clock, camera }) => {
    const node = group.current;
    if (node === null) {
      return;
    }
    const signal = signalRef.current;
    const room = roomRef.current;
    const t = signal.t;
    const time = clock.elapsedTime;
    const away = awayOf(table, t);

    // The jolt: one short knock back as the copy lands, on the clock rather than
    // the scroll, so it has the same weight however fast the reader scrolls.
    const since = snappedRef.current < 0 ? -1 : time - snappedRef.current;
    const jolt = since < 0 ? 0 : Math.exp(-since * 7) * Math.sin(since * 26) * 0.05;
    node.position.set(-away * 1.6, Math.sin(time * 0.5) * 0.035 * (1 - away), -away * 7 - jolt);
    node.rotation.y = Math.sin(time * 0.33) * 0.035;

    const entry = approachOf(table, t);
    const made = madeOf(table, t);
    const swapped = droppedTexture === null ? 0 : signal.probing * 0.92;
    const inks = focalInks({ entry, made, swapped, pictured: texture !== null, phone });
    const shown = entry * (1 - away);

    // The answer: the accent until the copy is home or the visitor's check
    // answers, then the match colour, or the refusal's.
    const answer = signal.answer;
    target.set(answer >= 2 ? room.refused : answer >= 1 ? room.matched : room.accent);
    edgeColor.lerp(target, 0.08);
    const flash = since < 0 ? 0 : Math.exp(-since * 2.4);
    const sealed = within(t, table.beat.sealed);
    const pulse = 0.2 + Math.sin(time * 1.6) * 0.04;
    const glowShare = Math.max(made * 0.22, Math.min(1, sealed) * pulse + (answer >= 1 ? 0.22 : 0) + flash * 0.5);
    // In light the print hangs on the wall as blank paper from the first frame,
    // small and far off, and the picture inks into it as the camera comes in.
    const paper = room.glows ? shown : (texture === null ? 0 : 1) * Math.max(shown, 0.4 * (1 - away));
    paintPrint(layersRef.current, room, paper, {
      picture: inks.picture * (1 - away),
      glowShare,
      edge: edgeColor,
    });
    if (grain.current !== null) {
      grain.current.opacity = room.glows ? inks.grain * (1 - away) : 0;
    }
    if (visitor.current !== null) {
      visitor.current.opacity = droppedTexture === null ? 0 : signal.probing;
    }

    // In light the answer is a frame round the paper: it flashes as the copy
    // lands and settles to a hairline, the ink version of the dark room's edge.
    if (frame.current !== null) {
      frame.current.visible = !room.glows && answer >= 1 && shown > 0.002;
      const material = frame.current.material as THREE.MeshBasicMaterial;
      material.color.copy(edgeColor);
      material.opacity = shown * (0.85 + flash * 0.15);
    }
    if (ripple.current !== null) {
      const grow = since < 0 ? 1 : Math.min(1, since / 0.9);
      ripple.current.visible = grow < 1;
      ripple.current.scale.set(width * (1.04 + grow * 0.22), height * (1.04 + grow * 0.22), 1);
      const material = ripple.current.material as THREE.MeshBasicMaterial;
      material.color.set(room.matched);
      material.opacity = shown * (1 - grow) * 0.8;
      material.blending = room.glows ? THREE.AdditiveBlending : THREE.NormalBlending;
    }

    // The stamp comes down on the scroll, hard at the end, and once it meets the
    // paper the squash and the ink run on the clock.
    const fall = span(sealed, SIGNED.fallFrom, SIGNED.land);
    const down = easeOut(fall, 3);
    if (fall >= 1 && landedAt.current < 0) {
      landedAt.current = time;
    }
    if (fall < 1) {
      landedAt.current = -1;
    }
    const landed = landedAt.current < 0 ? -1 : time - landedAt.current;
    if (stamp.current !== null) {
      const squash = landed < 0 ? 0 : Math.exp(-landed * 9) * Math.cos(landed * 30) * 0.16;
      const lift = 1 + (1 - down) * 1.6;
      stamp.current.scale.set(stampSize * lift * (1 + squash), stampSize * lift * (1 - squash), 1);
      stamp.current.position.z = 0.02 + (1 - down) * 0.6;
      stamp.current.rotation.z = -0.16 + (1 - down) * 0.3;
      const material = stamp.current.material as THREE.MeshBasicMaterial;
      material.opacity = fall <= 0 ? 0 : Math.min(1, fall * 2.2) * entry * (1 - away) * (room.glows ? 1 : 0.94);
    }
    if (spread.current !== null) {
      const ran = landed < 0 ? 0 : Math.min(1, landed / 0.8);
      spread.current.visible = landed >= 0 && shown > 0.002;
      const size = stampSize * (room.glows ? 2.6 : 1 + easeOut(ran) * 0.75);
      spread.current.scale.set(size, size, 1);
      const material = spread.current.material as THREE.MeshBasicMaterial;
      material.map = room.glows ? glow : inkSpread(room.accent);
      material.blending = room.glows ? THREE.AdditiveBlending : THREE.NormalBlending;
      // In dark the bloom flares and fades as the film's always did; in light
      // the ink spreads once and stays as a faint stain round the mark.
      material.opacity = shown * (room.glows ? Math.max(0.1, 0.6 - ran * 0.5) : 0.9 - ran * 0.55);
    }

    // The checked beat: a hairline once round the print, then the mark.
    const checked = table.beat.checked;
    const local = checked === undefined ? 0 : within(t, checked);
    const circle = checked === undefined ? 0 : easeOut(span(local, CHECKED_STEPS.circleFrom, CHECKED_STEPS.circleTo), 2);
    // The hairline and the mark belong to the checked beat: they lift off with
    // its words, so the print comes back for the drop panel as it was.
    const lifted = checked === undefined ? 1 : span(t, checked.captionEnd, checked.end);
    const hairline = ringRef.current;
    if (hairline !== null) {
      const geometry = hairline.geometry as THREE.BufferGeometry;
      const count = geometry.getAttribute("position").count;
      geometry.setDrawRange(0, Math.round(count * circle));
      hairline.visible = circle > 0.001 && shown > 0.002 && lifted < 1;
      hairline.scale.set(Math.hypot(width, height) * 0.53, Math.hypot(width, height) * 0.53, 1);
      const line = hairline.material as THREE.LineBasicMaterial;
      line.color.set(checkWord === null ? room.ink : room.matched);
      line.opacity = shown * (1 - lifted) * (room.glows ? 0.55 : 0.7);
    }
    if (mark.current !== null) {
      const pressed = checkWord === null ? 0 : easeOut(span(local, CHECKED_STEPS.markFrom, CHECKED_STEPS.markTo), 4);
      const lift = 1 + (1 - pressed) * 1.4;
      mark.current.visible = pressed > 0.001 && shown > 0.002 && lifted < 1;
      mark.current.scale.set(stampSize * 2.4 * lift, ((stampSize * 2.4) / TAG_ASPECT) * lift, 1);
      mark.current.position.z = 0.03 + (1 - pressed) * 0.5;
      (mark.current.material as THREE.MeshBasicMaterial).opacity = Math.min(1, pressed * 1.8) * shown * (1 - lifted);
    }

    if (tracksEdge) {
      // Both corners, not one and a width: the print turns a little as it
      // breathes, and the rule is drawn along the edge it really has.
      node.updateMatrixWorld();
      corners.set(-width / 2, -height / 2, 0).applyMatrix4(node.matrixWorld).project(camera);
      plateEdge.leftX = corners.x;
      plateEdge.leftY = corners.y;
      corners.set(width / 2, -height / 2, 0).applyMatrix4(node.matrixWorld).project(camera);
      plateEdge.rightX = corners.x;
      plateEdge.rightY = corners.y;
      // The picture has to be on the print before anything is written along it.
      plateEdge.shown = inks.picture > 0.05;
    }
  });

  const stampTexture = useMemo(() => kolamStamp(palette.accent, !palette.glows), [palette]);
  const markTexture = useMemo(
    () =>
      checkWord === null
        ? null
        : stampedTag(checkWord, palette.matched, palette.glows ? "rgba(11, 11, 12, 0.72)" : "rgba(241, 236, 227, 0.86)", "check", !palette.glows),
    [checkWord, palette],
  );
  const border = height * 0.045;

  return (
    <group ref={group}>
      <mesh
        ref={frame}
        position={[0, 0, -0.016]}
        scale={[width + border * 2 + 0.03, height + border * 2 + 0.03, 1]}
        visible={false}
      >
        <planeGeometry args={[1, 1]} />
        <meshBasicMaterial transparent opacity={0} toneMapped={false} />
      </mesh>
      <mesh ref={ripple} position={[0, 0, -0.02]} visible={false}>
        <planeGeometry args={[1, 1]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} toneMapped={false} />
      </mesh>
      <PrintMeshes width={width} height={height} texture={texture} layersRef={layersRef} />
      <mesh position={[0, 0, 0.002]} scale={[width, height, 1]}>
        <planeGeometry args={[1, 1]} />
        <meshBasicMaterial ref={grain} map={noise} transparent opacity={0} depthWrite={false} toneMapped={false} />
      </mesh>
      <mesh position={[0, 0, 0.012]} scale={[width, height, 1]}>
        <planeGeometry args={[1, 1]} />
        <meshBasicMaterial ref={visitor} map={droppedTexture} transparent opacity={0} toneMapped={false} />
      </mesh>
      <mesh ref={spread} position={[corner[0], corner[1], 0.014]} visible={false} renderOrder={9}>
        <planeGeometry args={[1, 1]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} toneMapped={false} />
      </mesh>
      <mesh ref={stamp} position={[corner[0], corner[1], 0.02]} renderOrder={10}>
        <planeGeometry args={[1, 1]} />
        <meshBasicMaterial map={stampTexture} transparent opacity={0} depthWrite={false} toneMapped={false} />
      </mesh>
      <primitive ref={ringRef} object={ring} />
      {markTexture !== null && (
        <mesh ref={mark} position={[corner[0] - stampSize * 1.55, corner[1] - stampSize * 0.05, 0.03]} rotation={[0, 0, 0.05]} renderOrder={10} visible={false}>
          <planeGeometry args={[1, 1]} />
          <meshBasicMaterial map={markTexture} transparent opacity={0} depthWrite={false} toneMapped={false} />
        </mesh>
      )}
      <Gather
        table={table}
        signalRef={signalRef}
        roomRef={roomRef}
        height={height}
        width={width}
        count={particles}
      />
    </group>
  );
}

/** One copy of the print on its way out into the world. */
export interface CopySpec {
  transform: string;
  /** The transform the browser actually applies to the picture, or none for a turn or a flip. */
  degrade: Degrade | null;
  to: [number, number, number];
  spin: number;
  mirror: boolean;
  size: number;
  /** True for the copy that flies home in the found beat. */
  returns: boolean;
  /** True for the copy that loses its label on the way out. */
  strips: boolean;
}

export const COPIES: CopySpec[] = [
  { transform: "rotate-90", degrade: null, to: [-4.6, 1.9, -0.6], spin: -Math.PI / 2, mirror: false, size: 0.62, returns: false, strips: false },
  { transform: "mirror", degrade: null, to: [4.5, 2.1, -1.4], spin: 0.12, mirror: true, size: 0.58, returns: false, strips: false },
  { transform: "reencode-q60", degrade: "reencode-q60", to: [-5.6, -1.6, -2.6], spin: -0.16, mirror: false, size: 0.54, returns: false, strips: false },
  { transform: "reencode-q30", degrade: "reencode-q30", to: [5.8, -1.2, -3.4], spin: 0.22, mirror: false, size: 0.5, returns: false, strips: false },
  { transform: "social-chain", degrade: "social-chain", to: [-3.1, -2.6, 0.9], spin: 0.3, mirror: false, size: 0.44, returns: false, strips: true },
  // The traveller waits far across the wall, so its flight home crosses the whole field.
  { transform: "resize-10", degrade: "resize-10", to: [6.8, 2.6, -13], spin: -0.28, mirror: false, size: 0.34, returns: true, strips: false },
];

/** The bend of the traveller's flight home, out over the left of the wall. */
const BEND: [number, number, number] = [-4.2, 3.4, -3.5];

function Copy({
  spec,
  index,
  source,
  fallback,
  label,
  parts,
  snappedRef,
  height,
}: {
  spec: CopySpec;
  index: number;
  /** The registered picture this copy is made from. */
  source: string | null;
  /** That picture untouched, shown while its degraded copy is still being made. */
  fallback: THREE.Texture | null;
  label: string;
  parts: SceneParts;
  snappedRef: RefObject<number>;
  height: number;
}) {
  const { table, roomRef, palette, signalRef } = parts;
  const degraded = useDegradedTexture(source, spec.degrade);
  const texture = degraded ?? fallback;
  const aspect = aspectOf(fallback);

  const group = useRef<THREE.Group>(null);
  const layersRef = useLayers();
  const strip = useRef<THREE.Mesh>(null);

  const delay = index * 0.07;
  const width = height * spec.size * aspect;
  const tall = height * spec.size;

  useFrame(({ clock }) => {
    const node = group.current;
    if (node === null) {
      return;
    }
    const t = signalRef.current.t;
    const room = roomRef.current;
    const out = THREE.MathUtils.clamp((played(t, table.beat.shared, 0.85) - delay) / (1 - delay), 0, 1);
    const eased = easeOut(out);
    const away = awayOf(table, t);
    const time = clock.elapsedTime;
    const drift = Math.sin(time * 0.5 + index) * 0.06;

    if (!spec.returns) {
      node.position.set(spec.to[0] * eased, spec.to[1] * eased + drift * eased, spec.to[2] * eased - away * 6);
      node.rotation.z = spec.spin * eased;
      node.scale.setScalar(0.35 + eased * 0.65);
      node.visible = out > 0.002;
      paintPrint(layersRef.current, room, Math.min(1, eased * 1.4) * 0.85 * (1 - away));
    } else {
      // Out to the far side of the wall as the copies leave, home along a curve
      // that crosses the whole field during the found beat, landing square on
      // its print and growing back to its size on the way.
      const local = within(t, table.beat.verified);
      const flight = easeOut(span(local, FOUND.flightFrom, FOUND.snap), 2.2);
      const a = (1 - flight) * (1 - flight);
      const b = 2 * (1 - flight) * flight;
      const c = flight * flight;
      if (flight <= 0) {
        node.position.set(spec.to[0] * eased, spec.to[1] * eased + drift * eased, spec.to[2] * eased);
      } else {
        node.position.set(
          a * spec.to[0] + b * BEND[0],
          a * spec.to[1] + b * BEND[1] + drift * (1 - flight),
          a * spec.to[2] + b * BEND[2] + c * 0.03,
        );
      }
      node.rotation.z = spec.spin * (1 - flight) * eased;
      const scale = flight <= 0 ? 0.35 + eased * 0.65 : 1 + (1 / spec.size - 1) * flight;
      node.scale.setScalar(scale);
      node.visible = out > 0.002;

      if (flight >= 1 && snappedRef.current < 0) {
        snappedRef.current = time;
      }
      if (flight < 1) {
        snappedRef.current = -1;
      }
      // Home, its crushed pixels dissolve into the sharp print they came from.
      const since = snappedRef.current < 0 ? 0 : time - snappedRef.current;
      const melt = snappedRef.current < 0 ? 1 : Math.max(0, 1 - since / 0.45);
      paintPrint(layersRef.current, room, Math.min(1, eased * 1.4) * melt * (1 - away), { glowShare: 0.5 });
    }

    if (strip.current !== null) {
      const material = strip.current.material as THREE.MeshBasicMaterial;
      const fall = THREE.MathUtils.clamp((out - 0.35) / 0.5, 0, 1);
      strip.current.position.y = -tall * 0.5 - (room.glows ? 0.02 : 0.05) - fall * 1.5;
      strip.current.rotation.z = fall * 0.5;
      material.opacity = (1 - fall) * Math.min(1, out * 3) * (1 - away);
      strip.current.visible = material.opacity > 0.002;
    }
  });

  const labelTexture = useMemo(
    () => labelStrip(label, palette.glows ? palette.accent : palette.ink, palette.glows ? null : palette.paper),
    [label, palette],
  );

  return (
    <group ref={group} visible={false}>
      <PrintMeshes width={width} height={tall} texture={texture} mirror={spec.mirror} layersRef={layersRef} />
      {spec.strips && (
        <mesh ref={strip} position={[0, -tall * 0.52, 0.03]} scale={[width * 0.92, (width * 0.92) / LABEL_ASPECT, 1]} renderOrder={10}>
          <planeGeometry args={[1, 1]} />
          <meshBasicMaterial map={labelTexture} transparent opacity={0} depthWrite={false} toneMapped={false} />
        </mesh>
      )}
    </group>
  );
}

/**
 * The copies leaving, degrading as they go, and the one that comes home.
 *
 * Each one is the registered picture actually put through the transform it is
 * named after: turned, flipped, resized to a tenth, saved again at a lower
 * quality, or run twice through a social pipeline. Nothing here is a filter
 * standing in for damage.
 */
export function Copies({
  focalUrl,
  label,
  parts,
  snappedRef,
  height,
}: {
  focalUrl: string | null;
  /** The credential one copy loses on the way out. */
  label: string;
  parts: SceneParts;
  snappedRef: RefObject<number>;
  height: number;
}) {
  const fallback = useAsyncTexture(focalUrl);

  return (
    <group>
      {COPIES.map((spec, index) => (
        <Copy
          key={spec.transform}
          spec={spec}
          index={index}
          source={focalUrl}
          fallback={fallback}
          label={label}
          parts={parts}
          snappedRef={snappedRef}
          height={height}
        />
      ))}
    </group>
  );
}

/**
 * Where the two look-alike prints stand on screen, in the renderer's own -1 to
 * 1 coordinates, for the dated rail drawn under them in the page. Written by
 * the scene every frame, read by the rail from its own frame.
 */
export const pairAnchors = { shown: 0, earlierX: 0, laterX: 0, footY: 0 };

/** The two look-alike prints, the earlier keeping its kolam and the later taking the mark. */
export function LookalikePair({
  earlierUrl,
  laterUrl,
  word,
  parts,
}: {
  earlierUrl: string;
  laterUrl: string;
  /** The mark's word, in the reader's language. */
  word: string;
  parts: SceneParts;
}) {
  const { table, roomRef, palette, signalRef } = parts;
  const earlierTexture = useAsyncTexture(earlierUrl);
  const laterTexture = useAsyncTexture(laterUrl);
  const height = 1.3;
  const gap = 0.34;
  const earlierWidth = height * aspectOf(earlierTexture);
  const laterWidth = height * aspectOf(laterTexture);
  const earlierX = -(gap / 2 + earlierWidth / 2);
  const laterX = gap / 2 + laterWidth / 2;

  const earlier = useRef<THREE.Group>(null);
  const later = useRef<THREE.Group>(null);
  const earlierLayersRef = useLayers();
  const laterLayersRef = useLayers();
  const kolam = useRef<THREE.Mesh>(null);
  const mark = useRef<THREE.Mesh>(null);
  const foot = useMemo(() => new THREE.Vector3(), []);

  useFrame(({ clock, camera }) => {
    const beat = table.beat.lookalike;
    if (earlier.current === null || later.current === null || beat === undefined) {
      return;
    }
    const t = signalRef.current.t;
    const room = roomRef.current;
    const time = clock.elapsedTime;
    const before = table.beats[table.beats.indexOf(beat) - 1];
    const come = smooth(span(t, before.captionEnd, beat.start + (beat.end - beat.start) * LOOKALIKE_STEPS.slideFrom));
    const go = smooth(span(t, beat.captionEnd, beat.end));
    const local = within(t, beat);
    const slide = smooth(span(local, LOOKALIKE_STEPS.slideFrom, LOOKALIKE_STEPS.slideTo));
    const marked = easeOut(span(local, LOOKALIKE_STEPS.markFrom, LOOKALIKE_STEPS.markTo), 4);
    const shown = 1 - go;

    earlier.current.position.set(earlierX + (1 - come) * -5.5, (1 - come) * 1.2 + Math.sin(time * 0.45) * 0.025, (1 - come) * -9 - go * 6);
    later.current.position.set(laterX + (1 - slide) * 7, (1 - slide) * 1.8 + Math.sin(time * 0.45 + 1.3) * 0.025, (1 - slide) * -11 - go * 6);
    earlier.current.visible = come * shown > 0.001;
    later.current.visible = slide * shown > 0.001;
    paintPrint(earlierLayersRef.current, room, earlierTexture === null ? 0 : come * shown);
    paintPrint(laterLayersRef.current, room, laterTexture === null ? 0 : slide * shown);

    if (kolam.current !== null) {
      (kolam.current.material as THREE.MeshBasicMaterial).opacity = come * shown;
    }
    if (mark.current !== null) {
      const lift = 1 + (1 - marked) * 1.4;
      mark.current.scale.set(laterWidth * 0.66 * lift, ((laterWidth * 0.66) / TAG_ASPECT) * lift, 1);
      mark.current.position.z = 0.03 + (1 - marked) * 0.5;
      (mark.current.material as THREE.MeshBasicMaterial).opacity = Math.min(1, marked * 1.8) * shown;
    }

    earlier.current.updateMatrixWorld();
    foot.set(0, -height / 2, 0).applyMatrix4(earlier.current.matrixWorld).project(camera);
    pairAnchors.earlierX = foot.x;
    const earlierFoot = foot.y;
    later.current.updateMatrixWorld();
    foot.set(0, -height / 2, 0).applyMatrix4(later.current.matrixWorld).project(camera);
    pairAnchors.laterX = foot.x;
    pairAnchors.footY = Math.min(earlierFoot, foot.y);
    pairAnchors.shown = come * slide * shown;
  });

  const kolamTexture = useMemo(() => kolamStamp(palette.accent, !palette.glows), [palette]);
  const markTexture = useMemo(
    () => stampedTag(word, palette.lookalike, palette.glows ? "rgba(11, 11, 12, 0.72)" : "rgba(241, 236, 227, 0.86)", "twin", !palette.glows),
    [word, palette],
  );

  useEffect(() => () => {
    pairAnchors.shown = 0;
  }, []);

  return (
    <group>
      <group ref={earlier} visible={false}>
        <PrintMeshes width={earlierWidth} height={height} texture={earlierTexture} layersRef={earlierLayersRef} />
        <mesh
          ref={kolam}
          renderOrder={10}
          position={[earlierWidth * 0.36, -height * 0.31, 0.02]}
          rotation={[0, 0, -0.16]}
          scale={[height * 0.27, height * 0.27, 1]}
        >
          <planeGeometry args={[1, 1]} />
          <meshBasicMaterial map={kolamTexture} transparent opacity={0} depthWrite={false} toneMapped={false} />
        </mesh>
      </group>
      <group ref={later} visible={false}>
        <PrintMeshes width={laterWidth} height={height} texture={laterTexture} layersRef={laterLayersRef} />
        <mesh ref={mark} renderOrder={10} position={[laterWidth * 0.22, height * 0.38, 0.03]} rotation={[0, 0, -0.08]}>
          <planeGeometry args={[1, 1]} />
          <meshBasicMaterial map={markTexture} transparent opacity={0} depthWrite={false} toneMapped={false} />
        </mesh>
      </group>
    </group>
  );
}

/**
 * The sign-it-yourself print: it arrives from beyond the wall's edge wearing
 * the platform's label, a press lands on it, and the label turns over into the
 * person's name.
 */
export function GuestPrint({
  url,
  drawnOn,
  imaginedBy,
  parts,
}: {
  url: string;
  /** "Drawn on {platform}", in the reader's language. */
  drawnOn: string;
  /** "Imagined by {person}". */
  imaginedBy: string;
  parts: SceneParts;
}) {
  const { table, roomRef, palette, signalRef } = parts;
  const texture = useAsyncTexture(url);
  const height = 1.6;
  const width = height * aspectOf(texture);
  const group = useRef<THREE.Group>(null);
  const layersRef = useLayers();
  const label = useRef<THREE.Mesh>(null);
  const press = useRef<THREE.Mesh>(null);
  const [turned, setTurned] = useState(false);

  useFrame(() => {
    const beat = table.beat.yourself;
    const node = group.current;
    if (beat === undefined || node === null) {
      return;
    }
    const t = signalRef.current.t;
    const room = roomRef.current;
    const local = within(t, beat);
    const arrive = smooth(span(local, 0, YOURSELF_STEPS.arriveTo));
    const go = smooth(span(t, beat.captionEnd, beat.end));
    const shown = (t >= beat.start ? 1 : 0) * (1 - go);
    node.position.set((1 - arrive) * 8.5, (1 - arrive) * 0.8, (1 - arrive) * -6 - go * 6);
    node.visible = shown * arrive > 0.001;
    paintPrint(layersRef.current, room, texture === null ? 0 : shown * Math.min(1, arrive * 1.6));

    // The label turns over: it flattens to nothing, swaps, and opens again.
    const turn = span(local, YOURSELF_STEPS.pressAt, YOURSELF_STEPS.turnTo);
    const flip = Math.abs(Math.cos(turn * Math.PI));
    const nowTurned = turn >= 0.5;
    if (nowTurned !== turned) {
      setTurned(nowTurned);
    }
    if (label.current !== null) {
      label.current.scale.set(width * 0.9, ((width * 0.9) / LABEL_ASPECT) * Math.max(0.02, flip), 1);
      (label.current.material as THREE.MeshBasicMaterial).opacity = shown * Math.min(1, arrive * 1.6);
    }
    if (press.current !== null) {
      const pulse = span(local, YOURSELF_STEPS.pressAt - 0.04, YOURSELF_STEPS.pressAt + 0.12);
      press.current.visible = pulse > 0 && pulse < 1 && shown > 0;
      press.current.scale.set(height * (0.4 + pulse * 0.9), height * (0.4 + pulse * 0.9), 1);
      const material = press.current.material as THREE.MeshBasicMaterial;
      material.color.set(room.accent);
      material.opacity = (1 - pulse) * 0.7 * shown;
      material.blending = room.glows ? THREE.AdditiveBlending : THREE.NormalBlending;
    }
  });

  const labelTexture = useMemo(
    () =>
      turned
        ? labelStrip(imaginedBy, palette.accent, palette.glows ? null : palette.paper)
        : labelStrip(drawnOn, palette.glows ? "#f5f3ef" : palette.ink, palette.glows ? null : palette.paper),
    [drawnOn, imaginedBy, palette, turned],
  );
  const ring = useMemo(() => inkSpread(palette.accent), [palette]);

  return (
    <group ref={group} visible={false}>
      <PrintMeshes width={width} height={height} texture={texture} layersRef={layersRef} />
      <mesh ref={label} position={[0, -height / 2 - 0.16, 0.02]} renderOrder={10}>
        <planeGeometry args={[1, 1]} />
        <meshBasicMaterial map={labelTexture} transparent opacity={0} depthWrite={false} toneMapped={false} />
      </mesh>
      <mesh ref={press} position={[0, 0, 0.04]} visible={false} renderOrder={11}>
        <planeGeometry args={[1, 1]} />
        <meshBasicMaterial map={ring} transparent opacity={0} depthWrite={false} toneMapped={false} />
      </mesh>
    </group>
  );
}
