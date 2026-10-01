/**
 * A chosen chip on Explore: the accent on its own pale tint, framed in the accent.
 *
 * In light the accent on that tint measured 4.32:1, under the 4.5:1 its 10 px
 * words need. They are taken 8% toward black there, which reads about 4.8:1 and
 * is not a change the eye sees. Dark keeps the accent as it is.
 */
export const CHOSEN_CHIP =
  "border-accent bg-accent-soft text-accent [.light_&]:text-[color-mix(in_srgb,var(--accent)_92%,black)]";
