import { makeImage } from "./helpers.js";

/**
 * A 640 by 480 JPEG with real structure, standing in for the solid colour the unseal tests used to
 * seal. A solid colour has no detail, so every one of its fingerprint bits is rounding noise and
 * Chainlink's pHash reads the thumbnail 25 to 33 bits from the print this service registered: the
 * network would call such a passport a mismatch for good, so the service refuses to unseal it.
 * Each colour name gives its own picture, so two fixtures never share a passport id.
 */
export async function texturedPicture(colour: string): Promise<Buffer> {
  let seed = 0;
  for (const character of colour) {
    seed = (seed * 31 + character.charCodeAt(0)) % 997;
  }
  return await makeImage(seed);
}
