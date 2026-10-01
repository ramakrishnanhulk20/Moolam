/**
 * The scene's colours, written once.
 *
 * The DOM reads its colours from the CSS tokens, but a WebGL material and a
 * canvas texture cannot, so the same values live here as plain strings and
 * every part of the scene takes them from this file. The film plays in one of
 * two rooms: light, the Linen paper room Ram approved on the story lab, and
 * dark, the film exactly as it shipped before it.
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

export interface RoomPalette {
  room: Room;
  /** The ground and the haze. In light they are one colour, so far prints fade into paper. */
  ground: string;
  fogDensity: number;
  /** The paper border round each print. */
  paper: string;
  /** The soft shadow under a print, and its strength. Dark has none: it is glass on black. */
  shadow: string;
  shadowOpacity: number;
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
}

/** The Linen room, every value the light tokens in globals.css hold. */
export const LIGHT: RoomPalette = {
  room: "light",
  ground: "#e4ddd0",
  fogDensity: 0.05,
  paper: "#f1ece3",
  shadow: "#3a3326",
  shadowOpacity: 0.34,
  accent: "#a52946",
  matched: "#146458",
  refused: "#a92912",
  lookalike: "#875400",
  ink: "#14130f",
  glows: false,
};

/** The film as it shipped: black field, glass plates, pink light. */
export const DARK: RoomPalette = {
  room: "dark",
  ground: "#0b0b0c",
  fogDensity: 0.052,
  paper: "#0b0b0c",
  shadow: "#000000",
  shadowOpacity: 0,
  accent: ACCENT,
  matched: VERIFIED,
  refused: REFUSED,
  lookalike: "#f2a93b",
  ink: "#f5f3ef",
  glows: true,
};

export function roomPalette(room: Room): RoomPalette {
  return room === "dark" ? DARK : LIGHT;
}

/**
 * The room for the theme the page shows. Light is the default for everyone and
 * the theme with no class at all, so only a plain "dark" is the dark room.
 */
export function roomOf(theme: string | null | undefined): Room {
  return theme === "dark" ? "dark" : "light";
}
