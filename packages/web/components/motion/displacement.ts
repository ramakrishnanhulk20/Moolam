/**
 * Displacement maths for the cursor dot field, kept out of the canvas component
 * so it can be read and tested on its own. The rendering loop needs a compositor
 * to run at all; this is where the behaviour actually lives.
 */

export const FIELD = {
  spacing: 28,
  dotRadius: 1.4,
  /** How close the pointer has to be before a dot reacts at all, in pixels. */
  influence: 150,
  /** How far a dot is pushed when the pointer sits right on it, in pixels. */
  maxPush: 22,
  /** Fraction of the remaining distance a dot travels each frame, out and back. */
  ease: 0.14,
};

export interface Displacement {
  dx: number;
  dy: number;
  intensity: number;
}

/**
 * Pushes one dot away from the pointer.
 *
 * The falloff is a cosine rather than a straight line so the effect fades to
 * nothing at the rim and there is no visible circle where dots stop reacting.
 */
export function displace(
  dotX: number,
  dotY: number,
  pointerX: number,
  pointerY: number,
  influence: number = FIELD.influence,
  maxPush: number = FIELD.maxPush,
): Displacement {
  const dx = dotX - pointerX;
  const dy = dotY - pointerY;
  const distance = Math.hypot(dx, dy);

  if (distance >= influence) {
    return { dx: 0, dy: 0, intensity: 0 };
  }

  // A dot directly under the pointer has no direction to flee in. Leaving it
  // still beats picking an arbitrary axis; its neighbours carry the effect.
  if (distance < 0.001) {
    return { dx: 0, dy: 0, intensity: 1 };
  }

  const intensity = (1 + Math.cos((distance / influence) * Math.PI)) / 2;
  const push = intensity * maxPush;
  return { dx: (dx / distance) * push, dy: (dy / distance) * push, intensity };
}

/** Moves `current` a fraction of the way towards `target`. */
export function approach(current: number, target: number, ease: number = FIELD.ease): number {
  return current + (target - current) * ease;
}
