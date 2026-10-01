import * as THREE from "three";
import { ACCENT_LIFT, ACCENT_RGB } from "@/components/story/palette";
import { PLATE_WIDTH } from "@/components/story/scene/order";
import { optimizedUrl } from "@/lib/images";

const cache = new Map<string, Promise<THREE.Texture>>();

/**
 * Loads one picture as a texture, once per address.
 *
 * Forty plates are textured from a much shorter list of live passports, so the
 * same gateway address is asked for many times and the promise is shared. A
 * gateway that refuses rejects here, and the plate that asked for it stays
 * dark rather than taking the scene down.
 */
export function loadTexture(url: string): Promise<THREE.Texture> {
  const held = cache.get(url);
  if (held !== undefined) {
    return held;
  }

  const loading = new Promise<THREE.Texture>((resolve, reject) => {
    const loader = new THREE.TextureLoader();
    loader.setCrossOrigin("anonymous");
    loader.load(
      optimizedUrl(url, PLATE_WIDTH),
      (texture) => {
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.anisotropy = 4;
        resolve(texture);
      },
      undefined,
      () => reject(new Error(`the gateway did not serve ${url}`)),
    );
  });

  cache.set(url, loading);
  return loading;
}

/** Grey static, for the plate in the moment before the picture exists. */
export function noiseTexture(size = 128): THREE.DataTexture {
  const data = new Uint8Array(size * size * 4);
  for (let index = 0; index < size * size; index += 1) {
    const value = 30 + Math.floor(Math.random() * 200);
    data[index * 4] = value;
    data[index * 4 + 1] = value;
    data[index * 4 + 2] = value;
    data[index * 4 + 3] = 255;
  }
  const texture = new THREE.DataTexture(data, size, size);
  texture.needsUpdate = true;
  return texture;
}

/** A soft round glow, for the bloom under the seal without a post pass. */
export function glowTexture(): THREE.CanvasTexture {
  const size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d");

  if (context !== null) {
    const gradient = context.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    gradient.addColorStop(0, `rgba(${ACCENT_LIFT}, 0.95)`);
    gradient.addColorStop(0.35, `rgba(${ACCENT_RGB}, 0.42)`);
    gradient.addColorStop(1, `rgba(${ACCENT_RGB}, 0)`);
    context.fillStyle = gradient;
    context.fillRect(0, 0, size, size);
  }

  return new THREE.CanvasTexture(canvas);
}

/** The four transforms the copies are put through on their way out. */
export type Degrade = "reencode-q60" | "reencode-q30" | "resize-10" | "social-chain";

const degraded = new Map<string, Promise<THREE.Texture>>();

/**
 * A copy of the registered picture, actually put through the transform it is
 * labelled with.
 *
 * The browser re-encodes and resizes the real bytes rather than faking a
 * crushed look with a filter, so what a visitor sees on a copy is what that
 * transform does to that file. The confidence figures beside them stay the
 * verifier's own measurements, and the caption says which file those were
 * measured on.
 */
export function degradedTexture(url: string, kind: Degrade): Promise<THREE.Texture> {
  const key = `${kind}:${url}`;
  const held = degraded.get(key);
  if (held !== undefined) {
    return held;
  }

  const work = (async () => {
    const source = await loadImage(url);

    if (kind === "resize-10") {
      return textureFrom(draw(source, 0.1));
    }
    if (kind === "reencode-q60") {
      return textureFrom(await encode(draw(source, 0.55), 0.6));
    }
    if (kind === "reencode-q30") {
      return textureFrom(await encode(draw(source, 0.55), 0.3));
    }

    // What a picture survives on the way through a social feed: shrunk, saved,
    // shrunk again, saved again.
    const once = await encode(draw(source, 0.6), 0.45);
    const twice = await encode(draw(once, 0.75), 0.4);
    return textureFrom(twice);
  })();

  degraded.set(key, work);
  return work;
}

const images = new Map<string, Promise<HTMLImageElement>>();

function loadImage(url: string): Promise<HTMLImageElement> {
  const held = images.get(url);
  if (held !== undefined) {
    return held;
  }
  const work = new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    // Read back out of a canvas after it is drawn, so the origin matters. The
    // optimizer serves from this site's own origin, and the gateway behind it
    // answers with Access-Control-Allow-Origin * for the pictures it serves
    // straight.
    image.crossOrigin = "anonymous";
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`the gateway did not serve ${url}`));
    image.src = optimizedUrl(url, PLATE_WIDTH);
  });
  images.set(url, work);
  return work;
}

function draw(source: CanvasImageSource & { width: number; height: number }, scale: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(8, Math.round(source.width * scale));
  canvas.height = Math.max(8, Math.round(source.height * scale));
  const context = canvas.getContext("2d");
  context?.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas;
}

async function encode(canvas: HTMLCanvasElement, quality: number): Promise<HTMLImageElement> {
  const image = new Image();
  image.src = canvas.toDataURL("image/jpeg", quality);
  await image.decode();
  return image;
}

function textureFrom(source: HTMLCanvasElement | HTMLImageElement): THREE.Texture {
  const texture = source instanceof HTMLCanvasElement ? new THREE.CanvasTexture(source) : new THREE.Texture(source);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}
