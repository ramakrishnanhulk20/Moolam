/**
 * Where the plates hang, in what order they ask for their pictures, and how wide.
 *
 * Two places need this and only one of them can afford to load three.js: the
 * scene itself, and the page that holds the film's box open while the film's
 * own code is still arriving. So the geometry and the order live here, with no
 * renderer anywhere in the file, which is also what lets a test read them.
 */

import { BEAT } from "@/components/story/beats";

/**
 * A plate in the field is never more than a few hundred pixels on screen, and
 * three.js cannot use next/image, so the address is handed to the optimizer
 * itself. That is what keeps the film off the IPFS gateway on every view.
 */
export const PLATE_WIDTH = 640;

/**
 * How many pictures the document asks for before the film exists. On a phone
 * the film's code takes seconds to arrive, and a picture requested only after
 * it lands pays for a round trip that could have run beside the scripts. Four
 * covers the plates nearest the opening camera without taking the network away
 * from the scripts the scene is waiting on.
 */
export const OPENING_PICTURES = 4;

/** One spot in the field, before it has been given a picture. */
export interface PlateSpot {
  position: [number, number, number];
  height: number;
  phase: number;
  /** How tall this plate stands in the opening frame: its size over its distance. */
  apparent: number;
}

/** A spot with the picture it hangs. */
export interface FieldPlate extends PlateSpot {
  url: string;
}

/**
 * The field, spot by spot, each with the picture it hangs.
 *
 * The largest plate in the opening frame takes the first picture, so the
 * pictures the document preloaded are the ones the first plates ask for, and
 * the requests that go out after them belong to smaller and further plates.
 */
export function fieldPlates(count: number, pictures: string[], spread = 1): FieldPlate[] {
  if (pictures.length === 0) {
    return [];
  }
  return plateSpots(count, spread).map((spot, rank) => ({ ...spot, url: pictures[rank % pictures.length] }));
}

/**
 * The pictures the field hangs, one per address, in the order the plates take
 * them: the first of these goes to the plate that stands largest in the opening
 * frame, which is the one the document preloads.
 */
export function fieldPictures(plates: readonly { picture: string }[]): string[] {
  return [...new Set(plates.map((plate) => plate.picture))];
}

/**
 * Where the plates hang, nearest and largest first.
 *
 * The square root spreads them evenly through the depth instead of bunching
 * them near the camera, and anything that lands in the corridor the camera
 * flies down is pushed sideways so it never covers the plate the story is
 * about.
 *
 * The sort is the whole point of the order: each plate asks the network for its
 * own picture as it mounts, so the requests that go out first belong to the
 * plates that fill the most of the opening frame. It moves nothing: the same
 * spots hold the same shapes, they are handed their pictures in a different
 * order.
 */
export function plateSpots(count: number, spread = 1): PlateSpot[] {
  const noise = sequence(41, count * 6);
  const eye = BEAT.opening.arrive.pos;
  const spots: PlateSpot[] = [];

  for (let index = 0; index < count; index += 1) {
    const at = index * 6;
    const depth = Math.sqrt(noise[at]);
    let x = (noise[at + 1] - 0.5) * (9 + depth * 26) * spread;
    const y = (noise[at + 2] - 0.5) * (4.5 + depth * 9);
    const z = 1.5 - depth * 34;

    if (z > -7 && Math.abs(x) < 2.6 && Math.abs(y) < 2) {
      x += x >= 0 ? 2.8 : -2.8;
    }

    const height = 0.5 + noise[at + 3] * 0.75;
    const away = Math.hypot(x - eye[0], y - eye[1], z - eye[2]);

    spots.push({
      position: [x, y, z],
      height,
      phase: noise[at + 4] * Math.PI * 2,
      apparent: height / Math.max(0.1, away),
    });
  }

  return spots.sort((a, b) => b.apparent - a.apparent);
}

/** A deterministic number sequence, so the field is the same field on every load. */
export function sequence(seed: number, count: number): number[] {
  let state = seed >>> 0;
  const out: number[] = [];
  for (let index = 0; index < count; index += 1) {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    out.push(((value ^ (value >>> 14)) >>> 0) / 4294967296);
  }
  return out;
}
