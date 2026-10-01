/**
 * What drives the film, and how far along it is.
 *
 * "stage" is drei's own scroller laid over the canvas, as the home page plays
 * the film today: the film takes the wheel and hands it back at its two ends.
 * "page" is the film riding the page's own scroll: a section as tall as the
 * cut, the stage pinned inside it, and the progress read from how far the
 * window has scrolled through the section. The lab route tries "page"; the
 * roll-in is the home page asking for it.
 */
export type FilmScroll = "stage" | "page";

/** The scroller's easing, drei's own: a smooth time of 0.22 seconds. */
export const DAMPING = 0.22;

/**
 * How far the window has scrolled through the film's section, 0 on the frame
 * the stage pins and 1 on the frame it unpins. `top` is the section's top edge
 * against the window's. The travel is the section's height less the stage's,
 * which is exactly the length of the scroller the film rode before.
 */
export function pageProgress(top: number, sectionHeight: number, stageHeight: number): number {
  const travel = sectionHeight - stageHeight;
  if (travel <= 0) {
    return 0;
  }
  const at = -top / travel;
  return at <= 0 ? 0 : at > 1 ? 1 : at;
}

/** A number eased toward a target between frames, with the speed the spring carries. */
export interface Damped {
  offset: number;
  velocity: number;
}

/**
 * One frame of drei's easing, which is maath's damp: a critically damped
 * spring that never crosses its target. Written out here rather than taken
 * from a package the app does not depend on directly, so the film on the
 * page's scroll eases its progress with the very numbers the scroller eased it
 * with.
 */
export function damp(state: Damped, target: number, smoothTime: number, delta: number, eps = 0.00001): void {
  if (Math.abs(state.offset - target) <= eps) {
    state.offset = target;
    return;
  }
  const omega = 2 / Math.max(0.0001, smoothTime);
  const x = omega * delta;
  const ease = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  const change = state.offset - target;
  const temp = (state.velocity + omega * change) * delta;
  state.velocity = (state.velocity - omega * temp) * ease;
  let output = target + (change + temp) * ease;
  if (target - state.offset > 0 === output > target) {
    output = target;
    state.velocity = (output - target) / delta;
  }
  state.offset = output;
}
