"use client";

import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import * as THREE from "three";
import { expectPlates, plateDrawn } from "./drawn";
import { fieldPlates, sequence, type FieldPlate } from "./order";
import {
  credentialTexture,
  degradedTexture,
  glowTexture,
  loadTexture,
  noiseTexture,
  sealTexture,
  type Degrade,
} from "./textures";
import { ACCENT, REFUSED, VERIFIED } from "@/components/story/palette";
import { plateEdge, resetPlateEdge } from "@/components/story/signals";

export const ACCENT_COLOR = new THREE.Color(ACCENT);
export const MATCHED_COLOR = new THREE.Color(VERIFIED);
export const REFUSED_COLOR = new THREE.Color(REFUSED);

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
        // A gateway that will not serve one picture leaves that plate dark.
      });
    return () => {
      live = false;
    };
  }, [url]);

  // Keyed by the address it was loaded from, so a plate never shows the picture
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

function Plate({ plate, fade, at }: { plate: FieldPlate; fade: RefObject<number>; at: number }) {
  const texture = useAsyncTexture(plate.url);
  const group = useRef<THREE.Group>(null);
  const face = useRef<THREE.Mesh>(null);
  const picture = useRef<THREE.MeshBasicMaterial>(null);
  const edge = useRef<THREE.MeshBasicMaterial>(null);
  const aspect = aspectOf(texture);

  // Three only compiles a texture into a material's shader when the material is
  // told it changed. Setting map and leaving it at that gives a flat white
  // plate, which is exactly what the field did before this effect existed.
  useEffect(() => {
    if (picture.current !== null) {
      picture.current.needsUpdate = true;
    }
  }, [texture]);

  // The renderer says when this plate was really on screen. Frustum culling
  // means a plate behind the camera never gets here, and the opacity test keeps
  // out the frame where the material has its picture but the field has not
  // faded it up yet.
  useEffect(() => {
    const node = face.current;
    if (node === null || texture === null) {
      return;
    }
    const nothing = () => undefined;
    node.onAfterRender = () => {
      if (picture.current === null || picture.current.opacity <= 0.01) {
        return;
      }
      node.onAfterRender = nothing;
      plateDrawn(String(at));
    };
    return () => {
      node.onAfterRender = nothing;
    };
  }, [at, texture]);

  useFrame(({ clock }) => {
    const node = group.current;
    if (node === null) {
      return;
    }
    const time = clock.elapsedTime;
    node.position.y = plate.position[1] + Math.sin(time * 0.3 + plate.phase) * 0.1;
    node.rotation.y = Math.sin(time * 0.21 + plate.phase) * 0.07;
    node.rotation.z = Math.sin(time * 0.16 + plate.phase) * 0.02;

    const shown = fade.current;
    if (picture.current !== null) {
      picture.current.opacity = texture === null ? 0 : shown;
    }
    if (edge.current !== null) {
      // A plate whose picture has not arrived shows nothing at all rather than a
      // lit empty frame.
      edge.current.opacity = texture === null ? 0 : shown * 0.34;
    }
  });

  return (
    <group ref={group} position={plate.position}>
      <mesh scale={[plate.height * aspect + 0.05, plate.height + 0.05, 1]}>
        <planeGeometry args={[1, 1]} />
        <meshBasicMaterial
          ref={edge}
          color={ACCENT_COLOR}
          transparent
          opacity={0}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </mesh>
      <mesh ref={face} position={[0, 0, 0.004]} scale={[plate.height * aspect, plate.height, 1]}>
        <planeGeometry args={[1, 1]} />
        <meshBasicMaterial ref={picture} map={texture} transparent opacity={0} toneMapped={false} />
      </mesh>
    </group>
  );
}

export function PlateField({ field, fade }: { field: FieldPlate[]; fade: RefObject<number> }) {
  expectPlates(field.length);

  return (
    <group>
      {field.map((plate, index) => (
        <Plate key={`${plate.url}-${index}`} plate={plate} fade={fade} at={index} />
      ))}
    </group>
  );
}

/** The particles that gather into the picture in the second beat. */
function Gather({
  made,
  height,
  width,
  count,
}: {
  made: RefObject<number>;
  height: number;
  width: number;
  count: number;
}) {
  const mesh = useRef<THREE.InstancedMesh>(null);
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
    const progress = made.current;

    for (let index = 0; index < count; index += 1) {
      const seed = seeds[index];
      const local = THREE.MathUtils.clamp((progress - seed.delay) / 0.55, 0, 1);
      const eased = 1 - Math.pow(1 - local, 3);

      if (progress <= 0.001 || local >= 1) {
        dummy.scale.setScalar(0);
      } else {
        dummy.scale.setScalar(0.022 * (1 - eased * 0.55));
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
      <meshBasicMaterial color={ACCENT_COLOR} transparent opacity={0.9} depthWrite={false} blending={THREE.AdditiveBlending} />
    </instancedMesh>
  );
}

export interface FocalRefs {
  /** How close the camera is to the plate, 0 on the title frame, 1 on it. */
  approach: RefObject<number>;
  made: RefObject<number>;
  sealed: RefObject<number>;
  verified: RefObject<number>;
  /** 0 the accent, 1 teal for a match, 2 red for a refusal. */
  answer: RefObject<number>;
  probe: RefObject<number>;
}

/**
 * The plate the story is about: noise, then the picture, then the seal, then
 * whatever the visitor drops on it at the end.
 */
export function FocalPlate({
  url,
  dropped,
  refs,
  particles,
  edge: tracksEdge = false,
  height = 1.7,
}: {
  url: string | null;
  /** The visitor's own file, shown on the plate while their check runs. */
  dropped: string | null;
  refs: FocalRefs;
  /** Halved on a phone, where the same cloud costs the same frame on a smaller GPU. */
  particles: number;
  /** True only on the cut with the stated beat, which needs the lower edge on screen. */
  edge?: boolean;
  height?: number;
}) {
  const texture = useAsyncTexture(url);
  const droppedTexture = useAsyncTexture(dropped);
  const noise = useMemo(() => noiseTexture(72), []);
  const seal = useMemo(() => sealTexture(), []);
  const glow = useMemo(() => glowTexture(), []);

  const aspect = aspectOf(texture);
  const width = height * aspect;

  const group = useRef<THREE.Group>(null);
  const edge = useRef<THREE.MeshBasicMaterial>(null);
  const picture = useRef<THREE.MeshBasicMaterial>(null);
  const grain = useRef<THREE.MeshBasicMaterial>(null);
  const visitor = useRef<THREE.MeshBasicMaterial>(null);
  const stamp = useRef<THREE.Mesh>(null);
  const stampMaterial = useRef<THREE.MeshBasicMaterial>(null);
  const bloom = useRef<THREE.Mesh>(null);
  const bloomMaterial = useRef<THREE.MeshBasicMaterial>(null);
  const edgeColor = useMemo(() => new THREE.Color(), []);
  const corner = useMemo(() => new THREE.Vector3(), []);

  // Same reason as the field plates: a map that arrives after the material was
  // built needs the material recompiled.
  useEffect(() => {
    if (picture.current !== null) {
      picture.current.needsUpdate = true;
    }
    if (visitor.current !== null) {
      visitor.current.needsUpdate = true;
    }
  }, [texture, droppedTexture]);

  // The rule over the film follows the edge this plate publishes, and only this
  // cut publishes one. A cut change or a scene that has gone leaves it with the
  // last place a plate stood, so it is put back here rather than left standing.
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
    const time = clock.elapsedTime;
    node.position.y = Math.sin(time * 0.5) * 0.035;
    node.rotation.y = Math.sin(time * 0.33) * 0.035;

    const made = refs.made.current;
    const sealed = refs.sealed.current;
    const verified = refs.verified.current;
    const answer = refs.answer.current;
    const probing = refs.probe.current;

    // The plate is not there at all on the title frame: it fades up as the
    // camera comes in, as static, and the picture arrives inside it.
    const entry = refs.approach.current;

    if (grain.current !== null) {
      grain.current.opacity = entry * Math.max(0, 1 - made * 1.5);
    }
    if (picture.current !== null) {
      // Only the visitor's own file replaces the picture. The rest of the last
      // beat leaves the registered image where it is.
      const swapped = droppedTexture === null ? 0 : probing * 0.92;
      picture.current.opacity = entry * THREE.MathUtils.clamp((made - 0.35) / 0.45, 0, 1) * (1 - swapped);
    }
    if (visitor.current !== null) {
      visitor.current.opacity = droppedTexture === null ? 0 : probing;
    }

    if (edge.current !== null) {
      const target = answer >= 2 ? REFUSED_COLOR : answer >= 1 ? MATCHED_COLOR : ACCENT_COLOR;
      edgeColor.lerp(target, 0.08);
      edge.current.color.copy(edgeColor);
      const pulse = 0.2 + Math.sin(time * 1.6) * 0.04;
      edge.current.opacity = entry * Math.max(made * 0.22, sealed * pulse + verified * 0.22 + probing * 0.2);
    }

    if (stamp.current !== null && stampMaterial.current !== null) {
      const drop = THREE.MathUtils.clamp(sealed / 0.72, 0, 1);
      const eased = 1 - Math.pow(1 - drop, 4);
      const scale = 2.9 - eased * 2.42;
      stamp.current.scale.setScalar(scale * 0.22);
      stamp.current.position.z = 0.5 - eased * 0.44;
      stampMaterial.current.opacity = sealed <= 0.001 ? 0 : Math.min(1, drop * 1.6) * (0.55 + verified * 0.45);
    }

    if (tracksEdge) {
      // Both corners, not one and a width: the plate turns a little as it
      // breathes, and the rule is drawn along the edge it really has.
      node.updateMatrixWorld();
      corner.set(-width / 2, -height / 2, 0).applyMatrix4(node.matrixWorld).project(camera);
      plateEdge.leftX = corner.x;
      plateEdge.leftY = corner.y;
      corner.set(width / 2, -height / 2, 0).applyMatrix4(node.matrixWorld).project(camera);
      plateEdge.rightX = corner.x;
      plateEdge.rightY = corner.y;
      // The picture has to be on the plate before anything is written along it.
      plateEdge.shown = picture.current !== null && picture.current.opacity > 0.05;
    }

    if (bloom.current !== null && bloomMaterial.current !== null) {
      const hit = Math.max(0, 1 - Math.abs(sealed - 0.78) / 0.16);
      const lit = Math.max(hit * hit, verified > 0.9 ? (verified - 0.9) * 1.6 : 0);
      const scale = (0.7 + (1 - hit) * 0.9) * height;
      bloom.current.scale.set(scale, scale, 1);
      bloomMaterial.current.opacity = Math.min(0.6, lit);
      bloom.current.visible = lit > 0.01;
    }
  });

  return (
    <group ref={group}>
      <mesh position={[0, 0, -0.02]} scale={[width + 0.07, height + 0.07, 1]}>
        <planeGeometry args={[1, 1]} />
        <meshBasicMaterial
          ref={edge}
          color={ACCENT_COLOR}
          transparent
          opacity={0}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </mesh>

      <mesh scale={[width, height, 1]}>
        <planeGeometry args={[1, 1]} />
        <meshBasicMaterial ref={grain} map={noise} transparent opacity={1} toneMapped={false} />
      </mesh>

      <mesh position={[0, 0, 0.006]} scale={[width, height, 1]}>
        <planeGeometry args={[1, 1]} />
        <meshBasicMaterial ref={picture} map={texture} transparent opacity={0} toneMapped={false} />
      </mesh>

      <mesh position={[0, 0, 0.012]} scale={[width, height, 1]}>
        <planeGeometry args={[1, 1]} />
        <meshBasicMaterial ref={visitor} map={droppedTexture} transparent opacity={0} toneMapped={false} />
      </mesh>

      <mesh ref={bloom} position={[width * 0.32, -height * 0.3, 0.02]} visible={false}>
        <planeGeometry args={[1, 1]} />
        <meshBasicMaterial
          ref={bloomMaterial}
          map={glow}
          transparent
          opacity={0}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </mesh>

      <mesh ref={stamp} position={[width * 0.32, -height * 0.3, 0.06]} scale={0.001}>
        <planeGeometry args={[1, 1]} />
        <meshBasicMaterial ref={stampMaterial} map={seal} transparent opacity={0} toneMapped={false} />
      </mesh>

      <Gather made={refs.made} height={height} width={width} count={particles} />
    </group>
  );
}

/** One copy of the plate on its way out into the world. */
export interface CopySpec {
  transform: string;
  /** The transform the browser actually applies to the picture, or none for a turn or a flip. */
  degrade: Degrade | null;
  to: [number, number, number];
  spin: number;
  mirror: boolean;
  size: number;
  /** True for the copy the camera follows home in the fifth beat. */
  returns: boolean;
  /** True for the copy that loses its credential on the way out. */
  strips: boolean;
}

export const COPIES: CopySpec[] = [
  { transform: "rotate-90", degrade: null, to: [-4.6, 1.9, -0.6], spin: -Math.PI / 2, mirror: false, size: 0.62, returns: false, strips: false },
  { transform: "mirror", degrade: null, to: [4.5, 2.1, -1.4], spin: 0.12, mirror: true, size: 0.58, returns: false, strips: false },
  { transform: "reencode-q60", degrade: "reencode-q60", to: [-5.6, -1.6, -2.6], spin: -0.16, mirror: false, size: 0.54, returns: false, strips: false },
  { transform: "reencode-q30", degrade: "reencode-q30", to: [5.8, -1.2, -3.4], spin: 0.22, mirror: false, size: 0.5, returns: false, strips: false },
  { transform: "social-chain", degrade: "social-chain", to: [-3.1, -2.6, 0.9], spin: 0.3, mirror: false, size: 0.44, returns: false, strips: true },
  { transform: "resize-10", degrade: "resize-10", to: [3.4, 2.7, 1.2], spin: -0.28, mirror: false, size: 0.34, returns: true, strips: false },
];

function Copy({
  spec,
  index,
  source,
  fallback,
  credential,
  shared,
  verified,
  height,
}: {
  spec: CopySpec;
  index: number;
  /** The registered picture this copy is made from. */
  source: string | null;
  /** That picture untouched, shown while its degraded copy is still being made. */
  fallback: THREE.Texture | null;
  credential: THREE.Texture;
  shared: RefObject<number>;
  verified: RefObject<number>;
  height: number;
}) {
  const degraded = useDegradedTexture(source, spec.degrade);
  const texture = degraded ?? fallback;
  const aspect = aspectOf(texture);

  const group = useRef<THREE.Group>(null);
  const picture = useRef<THREE.MeshBasicMaterial>(null);
  const edge = useRef<THREE.MeshBasicMaterial>(null);
  const strip = useRef<THREE.Mesh>(null);
  const stripMaterial = useRef<THREE.MeshBasicMaterial>(null);

  useEffect(() => {
    if (picture.current !== null) {
      picture.current.needsUpdate = true;
    }
  }, [texture]);

  const delay = index * 0.07;

  useFrame(({ clock }) => {
    const node = group.current;
    if (node === null) {
      return;
    }

    const out = THREE.MathUtils.clamp((shared.current - delay) / (1 - delay), 0, 1);
    const eased = 1 - Math.pow(1 - out, 3);
    const home = spec.returns ? verified.current : 0;
    const back = 1 - Math.pow(1 - home, 2);

    const time = clock.elapsedTime;
    const drift = Math.sin(time * 0.5 + index) * 0.06;

    node.position.set(
      spec.to[0] * eased * (1 - back * 0.94),
      spec.to[1] * eased * (1 - back * 0.94) + drift * eased,
      spec.to[2] * eased * (1 - back) + back * 1.15,
    );
    node.rotation.z = spec.spin * eased * (1 - back * 0.85);
    node.scale.setScalar((0.35 + eased * 0.65) * (1 - back * 0.4));
    node.visible = out > 0.002;

    if (picture.current !== null) {
      picture.current.opacity = Math.min(1, eased * 1.4) * (0.74 + back * 0.26);
    }
    if (edge.current !== null) {
      edge.current.opacity = back * 0.5;
    }
    if (strip.current !== null && stripMaterial.current !== null && spec.strips) {
      const fall = THREE.MathUtils.clamp((out - 0.35) / 0.5, 0, 1);
      strip.current.position.y = -height * spec.size * 0.52 - fall * 1.5;
      strip.current.rotation.z = fall * 0.5;
      stripMaterial.current.opacity = (1 - fall) * Math.min(1, out * 3);
    }
  });

  const width = height * spec.size * aspect;
  const tall = height * spec.size;

  return (
    <group ref={group} visible={false}>
      <mesh position={[0, 0, -0.01]} scale={[width + 0.05, tall + 0.05, 1]}>
        <planeGeometry args={[1, 1]} />
        <meshBasicMaterial
          ref={edge}
          color={ACCENT_COLOR}
          transparent
          opacity={0}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </mesh>
      <mesh scale={[spec.mirror ? -width : width, tall, 1]}>
        <planeGeometry args={[1, 1]} />
        <meshBasicMaterial ref={picture} map={texture} transparent opacity={0} toneMapped={false} />
      </mesh>
      {spec.strips && (
        <mesh ref={strip} position={[0, -tall * 0.52, 0.03]} scale={[width * 0.92, width * 0.115, 1]}>
          <planeGeometry args={[1, 1]} />
          <meshBasicMaterial
            ref={stripMaterial}
            map={credential}
            transparent
            opacity={0}
            depthWrite={false}
            toneMapped={false}
          />
        </mesh>
      )}
    </group>
  );
}

/**
 * The copies leaving, degrading as they go.
 *
 * Each one is the registered picture actually put through the transform it is
 * named after: turned, flipped, resized to a tenth, saved again at a lower
 * quality, or run twice through a social pipeline. Nothing here is a filter
 * standing in for damage.
 */
export function Copies({
  focalUrl,
  credentialText,
  shared,
  verified,
  height,
}: {
  focalUrl: string | null;
  credentialText: string;
  shared: RefObject<number>;
  verified: RefObject<number>;
  height: number;
}) {
  const fallback = useAsyncTexture(focalUrl);
  const credential = useMemo(() => credentialTexture(credentialText), [credentialText]);

  return (
    <group>
      {COPIES.map((spec, index) => (
        <Copy
          key={spec.transform}
          spec={spec}
          index={index}
          source={focalUrl}
          fallback={fallback}
          credential={credential}
          shared={shared}
          verified={verified}
          height={height}
        />
      ))}
    </group>
  );
}
