/**
 * The scene's colours, written once.
 *
 * The DOM reads its colours from the CSS tokens, but a WebGL material and a
 * canvas texture cannot, so the same values live here as plain strings and
 * every part of the scene takes them from this file. The film plays in one of
 * two rooms: light, the Linen paper room Ram approved on the film lab, and
 * dark, the film exactly as it shipped before it.
 *
 * Everything a room draws differently is a field here rather than a branch in
 * the scene.
 */

/** Light pink, the dark room's one accent: the stamp, the plate edges and the label dots. */
export const ACCENT = "#FFB7C5";

/** The same pink as channels, for a gradient or a scrim that needs an alpha. */
export const ACCENT_RGB = "255, 183, 197";

/** A paler step of it, for the hot centre of the glow under the stamp. */
export const ACCENT_LIFT = "255, 209, 218";

/** The dark room's status colours: the site's own dark tokens, so a refusal is the same red everywhere. */
export const VERIFIED = "#3FBFA8";
export const REFUSED = "#FF5F4D";

export type Room = "light" | "dark";

/** The static the focal print forms out of, in the moment before the picture exists. */
export interface RoomGrain {
  /** How strongly it is drawn, 0 to 1. At 0 the print is blank paper until the picture inks in. */
  strength: number;
  /**
   * The ink it is drawn in on paper. In a room that glows the grey static is
   * drawn as the light it is, so the ink is white and leaves it untinted.
   */
  ink: string;
}

/** The specks that gather into the picture in the imagined beat. */
export interface RoomMotes {
  color: string;
  opacity: number;
  /** The side of one speck in scene units, before it shrinks on the way in. */
  size: number;
  /** True for a soft round mote of ink, false for the film's square spark of light. */
  soft: boolean;
}

export interface RoomPalette {
  room: Room;
  /** The ground behind everything, the page's own. */
  ground: string;
  /** The haze far prints fade into, and how thick it is. */
  haze: string;
  fogDensity: number;
  /** The paper border round each print. */
  paper: string;
  /** The soft shadow under a print, and its strength. Dark has none: it is glass on black. */
  shadow: string;
  shadowOpacity: number;
  /**
   * How much of its paper the focal print shows before the camera has reached
   * it, 0 to 1: a print hanging on the wall from the first frame, or nothing
   * until the picture starts to form. Not read in a room that glows.
   */
  paperFloor: number;
  /** The kolam stamp, the label and every other accent mark. */
  accent: string;
  matched: string;
  refused: string;
  /** The look-alike mark: amber, Ram's pick on the lab, one shade per room. */
  lookalike: string;
  /** Ink for drawn words: the credential label, the tags. */
  ink: string;
  /** True in dark: glass and added light. False in light: paper prints and ink. */
  glows: boolean;
  grain: RoomGrain;
  motes: RoomMotes;
}

/**
 * The Linen room, with everything the dark film shows drawn in paper and ink:
 * every colour is one the light tokens in globals.css hold. The picture forms
 * out of the same static as the dark film's, as charcoal grain pressed into the
 * paper; the specks that gather into it are soft motes of the crimson accent;
 * the haze is thin, so the wall of prints stands behind the words; and the
 * close lets the print, its stamp and the wall show through.
 */
export const LIGHT: RoomPalette = {
  room: "light",
  ground: "#e4ddd0",
  haze: "#e4ddd0",
  fogDensity: 0.036,
  paper: "#f6f2ea",
  shadow: "#3a3326",
  shadowOpacity: 0.4,
  paperFloor: 0,
  accent: "#a52946",
  matched: "#146458",
  refused: "#a92912",
  lookalike: "#875400",
  ink: "#14130f",
  glows: false,
  grain: { strength: 1, ink: "#2b2622" },
  motes: { color: "#a52946", opacity: 0.85, size: 0.024, soft: true },
};

/** The film as it shipped: black field, glass plates, pink light. */
export const DARK: RoomPalette = {
  room: "dark",
  ground: "#0b0b0c",
  haze: "#0b0b0c",
  fogDensity: 0.052,
  paper: "#0b0b0c",
  shadow: "#000000",
  shadowOpacity: 0,
  paperFloor: 0,
  accent: ACCENT,
  matched: VERIFIED,
  refused: REFUSED,
  lookalike: "#f2a93b",
  ink: "#f5f3ef",
  glows: true,
  grain: { strength: 1, ink: "#ffffff" },
  motes: { color: ACCENT, opacity: 0.9, size: 0.022, soft: false },
};

export function roomPalette(room: Room): RoomPalette {
  return room === "dark" ? DARK : LIGHT;
}

/**
 * The room for the theme the page shows, which is the resolved theme from
 * next-themes: "light" or "dark", never "system". Only a plain "dark" is the
 * dark room. A theme the browser does not know yet gets the light room, the
 * stylesheet's own default.
 */
export function roomOf(theme: string | null | undefined): Room {
  return theme === "dark" ? "dark" : "light";
}
