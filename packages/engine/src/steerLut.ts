/**
 * Baked trigonometry for heading and steering.
 *
 * Two different problems, both solved by the same trick:
 *
 *  - STEERING spans a bounded range (the car's physical lock), so a small
 *    uniformly sampled table covers the whole reachable domain and no wrap is
 *    needed.
 *  - HEADING spans the full circle and is unbounded over a long race, so its
 *    table covers 0..2pi and the angle is wrapped before lookup.
 *
 * Both are baked once at load and interpolated linearly. The determinism
 * contract forbids calling `sin`/`cos` in the hot path, and this is also simply
 * faster than the library calls it replaces.
 *
 * THIS FILE IS DELIBERATELY EXEMPT from `scripts/lint-determinism.ts`. It is the
 * one place trigonometry is permitted, because values computed once at startup
 * cannot drift between engines.
 */

export const MAX_STEER_ANGLE = 0.55; // rad, about 31 degrees of lock
const TWO_PI = Math.PI * 2;

/**
 * Resolution of both tables.
 *
 * 4096 steps over 2pi gives a spacing of 0.0015 rad, at which linear
 * interpolation is accurate to about 1e-7 — far finer than any physical effect
 * in the sim. The heading table is deliberately finer than the steering table
 * because heading error accumulates over a long run while steering error does
 * not.
 */
const STEER_STEPS = 1024;
const HEADING_STEPS = 4096;

const STEER_SPAN = MAX_STEER_ANGLE * 2;

const bake = (steps: number, span: number, offset: number, fn: (a: number) => number): Float64Array => {
  const table = new Float64Array(steps + 1);
  for (let i = 0; i <= steps; i++) {
    table[i] = fn(offset + (i / steps) * span);
  }
  return table;
};

const STEER_SIN = bake(STEER_STEPS, STEER_SPAN, -MAX_STEER_ANGLE, Math.sin);
const STEER_COS = bake(STEER_STEPS, STEER_SPAN, -MAX_STEER_ANGLE, Math.cos);
const HEADING_SIN = bake(HEADING_STEPS, TWO_PI, 0, Math.sin);
const HEADING_COS = bake(HEADING_STEPS, TWO_PI, 0, Math.cos);

/** Linear interpolation with a clamped upper index. */
const sample = (table: Float64Array, position: number, steps: number): number => {
  const index = position | 0;
  if (index >= steps) return table[steps]!;
  const fraction = position - index;
  const lo = table[index]!;
  const hi = table[index + 1]!;
  return lo + (hi - lo) * fraction;
};

export const steerSin = (steering: number): number => {
  const clamped =
    steering < -MAX_STEER_ANGLE
      ? -MAX_STEER_ANGLE
      : steering > MAX_STEER_ANGLE
        ? MAX_STEER_ANGLE
        : steering;
  return sample(STEER_SIN, ((clamped + MAX_STEER_ANGLE) / STEER_SPAN) * STEER_STEPS, STEER_STEPS);
};

export const steerCos = (steering: number): number => {
  const clamped =
    steering < -MAX_STEER_ANGLE
      ? -MAX_STEER_ANGLE
      : steering > MAX_STEER_ANGLE
        ? MAX_STEER_ANGLE
        : steering;
  return sample(STEER_COS, ((clamped + MAX_STEER_ANGLE) / STEER_SPAN) * STEER_STEPS, STEER_STEPS);
};

/** Wraps an unbounded heading into 0..2pi. */
const wrapHeading = (heading: number): number => {
  const wrapped = heading - Math.floor(heading / TWO_PI) * TWO_PI;
  return wrapped < 0 ? wrapped + TWO_PI : wrapped;
};

export interface HeadingBasis {
  c: number;
  s: number;
}

/**
 * Sine and cosine of the heading.
 *
 * Over a long race a car accumulates thousands of radians of heading, so the
 * wrap is essential: without it the table position would grow without bound and
 * eventually lose all precision.
 */
export const headingBasis = (heading: number): HeadingBasis => {
  const position = (wrapHeading(heading) / TWO_PI) * HEADING_STEPS;
  const index = position | 0;
  if (index >= HEADING_STEPS) {
    return { c: HEADING_COS[HEADING_STEPS]!, s: HEADING_SIN[HEADING_STEPS]! };
  }
  const fraction = position - index;
  const cosLo = HEADING_COS[index]!;
  const sinLo = HEADING_SIN[index]!;
  return {
    c: cosLo + (HEADING_COS[index + 1]! - cosLo) * fraction,
    s: sinLo + (HEADING_SIN[index + 1]! - sinLo) * fraction,
  };
};
