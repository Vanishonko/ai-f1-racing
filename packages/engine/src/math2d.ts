/**
 * Deterministic scalar helpers for the simulation core.
 *
 * DETERMINISM CONTRACT (see docs/DESIGN.md):
 *   The sim core may only use + - * / % and the Math functions listed in
 *   DETERMINISTIC_MATH below. Transcendentals (sin/cos/tan/atan2/exp/log/pow/
 *   hypot/cbrt) are FORBIDDEN in core, because their results are not guaranteed
 *   bit-identical across engines and platforms. Trigonometry that the sim needs
 *   is baked into lookup tables at track-load time and interpolated linearly.
 *
 *   `node scripts/lint-determinism.ts` enforces this.
 */

export const clamp = (v: number, lo: number, hi: number): number =>
  v < lo ? lo : v > hi ? hi : v;

export const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * Deterministic vector length: sqrt(x*x + y*y).
 *
 * Deliberately NOT Math.hypot, which is permitted to scale internally to avoid
 * overflow and therefore is not guaranteed to be bit-identical across engines.
 */
export const len = (x: number, y: number): number => Math.sqrt(x * x + y * y);

/** Linear interpolation, clamped to the segment. */
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;


/**
 * Ratio helper that never divides by zero and never returns a negative
 * magnitude when the denominator is clamped to its own sign.
 */
export const safeDiv = (num: number, den: number, eps = 1e-6): number => {
  if (den >= eps) return num / den;
  if (den <= -eps) return num / den;
  return den >= 0 ? num / eps : num / -eps;
};

/**
 * Smoothly saturate a value onto [0, 1) as its magnitude grows.
 *
 * Built from sqrt + a rational curve so it stays inside the determinism
 * contract: exactly 1/sqrt(2) at `magnitude == 1`, and monotonically
 * increasing toward an asymptote of 1.
 */
export const saturate = (magnitude: number): number => {
  const m = magnitude < 0 ? -magnitude : magnitude;
  if (m < 1e-9) return 0;
  return m / Math.sqrt(1 + m * m);
};

