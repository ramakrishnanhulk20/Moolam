/**
 * The scene's colours, written once.
 *
 * The DOM reads the accent from the CSS variables in globals.css, but a WebGL
 * material and a canvas texture cannot, so the same values live here as plain
 * strings and every part of the scene takes them from this file.
 */

/** Light pink, the one accent: the seal, the plate edges and the label dots. */
export const ACCENT = "#FFB7C5";

/** The same pink as channels, for a gradient or a scrim that needs an alpha. */
export const ACCENT_RGB = "255, 183, 197";

/** A paler step of it, for the hot centre of the glow under the seal. */
export const ACCENT_LIFT = "255, 209, 218";

/** Status stays cold and separate: teal for a match, one red for a refusal. */
export const VERIFIED = "#3FBFA8";
export const REFUSED = "#C2586F";
