import * as THREE from "three";
import { sequence } from "@/components/story/scene/order";

/**
 * The kolam knot, the same line the site's .motif mask draws (globals.css), on
 * a 24 unit square. Moolam's one mark: the film stamps it onto the print.
 */
export const KNOT =
  "M22.7 12C22.7 11.49 22.64 10.84 22.48 10.48C22.32 10.11 22.11 9.81 21.74 9.81C21.37 9.82 20.9 10.06 20.28 10.51C19.66 10.95 18.87 11.71 18.03 12.49C17.19 13.28 16.17 14.32 15.24 15.24C14.32 16.17 13.28 17.19 12.49 18.03C11.71 18.87 10.95 19.66 10.51 20.28C10.06 20.9 9.82 21.37 9.81 21.74C9.81 22.11 10.11 22.32 10.48 22.48C10.84 22.64 11.49 22.7 12 22.7C12.51 22.7 13.16 22.64 13.52 22.48C13.89 22.32 14.19 22.11 14.19 21.74C14.18 21.37 13.94 20.9 13.49 20.28C13.05 19.66 12.29 18.87 11.51 18.03C10.72 17.19 9.68 16.17 8.76 15.24C7.83 14.32 6.81 13.28 5.97 12.49C5.13 11.71 4.34 10.95 3.72 10.51C3.1 10.06 2.63 9.82 2.26 9.81C1.89 9.81 1.68 10.11 1.52 10.48C1.36 10.84 1.3 11.49 1.3 12C1.3 12.51 1.36 13.16 1.52 13.52C1.68 13.89 1.89 14.19 2.26 14.19C2.63 14.18 3.1 13.94 3.72 13.49C4.34 13.05 5.13 12.29 5.97 11.51C6.81 10.72 7.83 9.68 8.76 8.76C9.68 7.83 10.72 6.81 11.51 5.97C12.29 5.13 13.05 4.34 13.49 3.72C13.94 3.1 14.18 2.63 14.19 2.26C14.19 1.89 13.89 1.68 13.52 1.52C13.16 1.36 12.51 1.3 12 1.3C11.49 1.3 10.84 1.36 10.48 1.52C10.11 1.68 9.81 1.89 9.81 2.26C9.82 2.63 10.06 3.1 10.51 3.72C10.95 4.34 11.71 5.13 12.49 5.97C13.28 6.81 14.32 7.83 15.24 8.76C16.17 9.68 17.19 10.72 18.03 11.51C18.87 12.29 19.66 13.05 20.28 13.49C20.9 13.94 21.37 14.18 21.74 14.19C22.11 14.19 22.32 13.89 22.48 13.52C22.64 13.16 22.7 12.51 22.7 12Z";

const held = new Map<string, THREE.CanvasTexture>();

/** One texture per drawing and colour, made the first time it is asked for. */
function once(key: string, make: () => HTMLCanvasElement): THREE.CanvasTexture {
  const ready = held.get(key);
  if (ready !== undefined) {
    return ready;
  }
  const texture = new THREE.CanvasTexture(make());
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  held.set(key, texture);
  return texture;
}

function canvas(width: number, height: number): [HTMLCanvasElement, CanvasRenderingContext2D | null] {
  const node = document.createElement("canvas");
  node.width = width;
  node.height = height;
  return [node, node.getContext("2d")];
}

/**
 * Small bites out of what is already drawn, the way a rubber stamp leaves paper
 * showing where the ink did not take. Seeded, so it is the same stamp on every
 * load.
 */
function inkBites(context: CanvasRenderingContext2D, width: number, height: number, seed: number, count: number) {
  const noise = sequence(seed, count * 3);
  context.save();
  context.globalCompositeOperation = "destination-out";
  for (let index = 0; index < count; index += 1) {
    const x = noise[index * 3] * width;
    const y = noise[index * 3 + 1] * height;
    const r = 0.5 + noise[index * 3 + 2] * 1.8;
    context.globalAlpha = 0.35 + noise[index * 3 + 2] * 0.65;
    context.beginPath();
    context.arc(x, y, r, 0, Math.PI * 2);
    context.fill();
  }
  context.restore();
}

/** The site's own mono face, so the scene's lettering matches the readouts round it. */
function monoFamily(): string {
  const named = getComputedStyle(document.body).getPropertyValue("--font-mono").trim();
  return named === "" ? "ui-monospace, monospace" : `${named}, ui-monospace, monospace`;
}

/**
 * The kolam stamp: the knot inside a double ring, like an office's rubber
 * stamp. In ink it is bitten by the paper; as light it is drawn clean and the
 * glow under it does the rest.
 */
export function kolamStamp(color: string, inked: boolean): THREE.CanvasTexture {
  return once(`kolam:${color}:${inked}`, () => {
    const size = 512;
    const [node, context] = canvas(size, size);
    if (context === null) {
      return node;
    }
    context.strokeStyle = color;
    context.fillStyle = color;
    context.lineWidth = size * 0.028;
    context.beginPath();
    context.arc(size / 2, size / 2, size * 0.455, 0, Math.PI * 2);
    context.stroke();
    context.lineWidth = size * 0.01;
    context.beginPath();
    context.arc(size / 2, size / 2, size * 0.395, 0, Math.PI * 2);
    context.stroke();

    const knot = size * 0.6;
    context.save();
    context.translate((size - knot) / 2, (size - knot) / 2);
    context.scale(knot / 24, knot / 24);
    context.lineWidth = 1.9;
    context.lineJoin = "round";
    context.stroke(new Path2D(KNOT));
    context.beginPath();
    context.arc(12, 12, 2.3, 0, Math.PI * 2);
    context.fill();
    context.restore();

    if (inked) {
      inkBites(context, size, size, 17, 520);
    }
    return node;
  });
}

/** The proportions of a stamped word tag, width over height. */
export const TAG_ASPECT = 512 / 160;

/**
 * A stamped tag with one line of lettering: the look-alike mark, the checked
 * mark. A wash of the room's paper sits under the ink so it reads over any
 * picture, and the glyph on the left says which mark it is.
 */
export function stampedTag(
  text: string,
  color: string,
  backing: string,
  glyph: "twin" | "check",
  inked: boolean,
): THREE.CanvasTexture {
  return once(`tag:${text}:${color}:${backing}:${glyph}:${inked}`, () => {
    const width = 512;
    const height = 160;
    const [node, context] = canvas(width, height);
    if (context === null) {
      return node;
    }
    const pad = 10;
    context.fillStyle = backing;
    context.beginPath();
    context.roundRect(pad, pad, width - pad * 2, height - pad * 2, 16);
    context.fill();
    context.strokeStyle = color;
    context.fillStyle = color;
    context.lineWidth = 8;
    context.beginPath();
    context.roundRect(pad, pad, width - pad * 2, height - pad * 2, 16);
    context.stroke();

    if (glyph === "twin") {
      // Two prints, the later one laid over the earlier one and offset.
      context.lineWidth = 6;
      context.strokeRect(36, 44, 58, 46);
      context.fillRect(56, 66, 58, 46);
    } else {
      context.lineWidth = 9;
      context.lineCap = "round";
      context.lineJoin = "round";
      context.beginPath();
      context.moveTo(44, 84);
      context.lineTo(68, 106);
      context.lineTo(112, 54);
      context.stroke();
    }

    // The words at the largest size that fits the room right of the glyph. A
    // mark too long for one line at a readable size, as the look-alike mark is
    // in most languages, goes on two.
    const room = width - 140 - 28;
    const mono = monoFamily();
    const fit = (line: string, from: number, floor: number) => {
      let size = from;
      context.font = `700 ${size}px ${mono}`;
      while (size > floor && context.measureText(line).width > room) {
        size -= 2;
        context.font = `700 ${size}px ${mono}`;
      }
      return size;
    };
    context.textBaseline = "middle";
    const one = fit(text, 54, 30);
    if (context.measureText(text).width <= room) {
      context.fillText(text, 140, height / 2 + 2);
    } else {
      const words = text.split(" ");
      const half = Math.ceil(words.length / 2);
      const lines = [words.slice(0, half).join(" "), words.slice(half).join(" ")];
      const size = Math.min(...lines.map((line) => fit(line, Math.min(one, 40), 18)));
      context.font = `700 ${size}px ${mono}`;
      context.fillText(lines[0], 140, height / 2 - size * 0.55);
      context.fillText(lines[1], 140, height / 2 + size * 0.65);
    }

    if (inked) {
      inkBites(context, width, height, 29, 260);
    }
    return node;
  });
}

/** The proportions of a printed label strip under a print, width over height. */
export const LABEL_ASPECT = 512 / 72;

/**
 * A printed label on a strip of paper: the credential a platform strips, the
 * "Drawn on" line and the name tag it turns into. In dark it is the film's
 * lettering on nothing, as the credential always was.
 */
export function labelStrip(text: string, ink: string, backing: string | null): THREE.CanvasTexture {
  return once(`label:${text}:${ink}:${backing ?? "none"}`, () => {
    const width = 512;
    const height = 72;
    const [node, context] = canvas(width, height);
    if (context === null) {
      return node;
    }
    if (backing !== null) {
      context.fillStyle = backing;
      context.fillRect(0, 0, width, height);
    }
    let size = 32;
    context.font = `600 ${size}px ${monoFamily()}`;
    while (size > 16 && context.measureText(text).width > width - 24) {
      size -= 2;
      context.font = `600 ${size}px ${monoFamily()}`;
    }
    context.fillStyle = ink;
    context.textBaseline = "middle";
    context.fillText(text, 12, height / 2 + 1);
    return node;
  });
}

/** A soft shadow under a print: a blurred rectangle. */
export function printShadow(): THREE.CanvasTexture {
  return once("shadow", () => {
    const size = 256;
    const [node, context] = canvas(size, size);
    if (context === null) {
      return node;
    }
    context.filter = "blur(18px)";
    context.fillStyle = "#000000";
    context.fillRect(size * 0.16, size * 0.16, size * 0.68, size * 0.68);
    return node;
  });
}

/** The ink that spreads out from under the stamp once, as it meets the paper. */
export function inkSpread(color: string): THREE.CanvasTexture {
  return once(`spread:${color}`, () => {
    const size = 256;
    const [node, context] = canvas(size, size);
    if (context === null) {
      return node;
    }
    const gradient = context.createRadialGradient(size / 2, size / 2, size * 0.18, size / 2, size / 2, size / 2);
    gradient.addColorStop(0, `${color}66`);
    gradient.addColorStop(0.55, `${color}22`);
    gradient.addColorStop(1, `${color}00`);
    context.fillStyle = gradient;
    context.fillRect(0, 0, size, size);
    return node;
  });
}
