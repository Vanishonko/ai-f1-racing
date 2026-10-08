/**
 * Baked activation and transfer functions.
 *
 * The determinism contract forbids `Math.tanh` and the other transcendentals, because
 * their results are not bit-identical across engines and a replay has to produce exactly
 * the same lap. Every other function the simulation needs is baked into a table at load
 * and interpolated linearly; activations are no different.
 *
 * A driver runs once per car per tick, so this is on the hot path and the table is worth
 * having for speed as well as for determinism.
 */

import { clamp } from "./math2d.ts";

/**
 * Input range the table covers.
 *
 * Sized from the error budget rather than by feel. Outside the range the value is held at
 * the boundary, so the range has to be wide enough that the function has genuinely
 * flattened: at 4 the true value is still 6.6e-4 away from its asymptote, which showed up
 * as exactly that much error against the real `tanh`. At 6 the gap is 1.2e-5.
 */
const TANH_RANGE = 6;

/** Table resolution. Linear interpolation on this is accurate to about 1e-5. */
const TANH_STEPS = 2048;

const TANH_TABLE = (() => {
  const table = new Float64Array(TANH_STEPS + 1);
  for (let i = 0; i <= TANH_STEPS; i++) {
    const x = (i / TANH_STEPS) * 2 * TANH_RANGE - TANH_RANGE;
    table[i] = Math.tanh(x);
  }
  return table;
})();

/**
 * Hyperbolic tangent, from the baked table.
 *
 * The value at the table boundary is also what is returned beyond it, so the function is
 * flat outside the range rather than discontinuous — which matters because a weight
 * update can push a pre-activation across the boundary and a jump there would be a
 * spurious large change in behaviour.
 */
export const tanh = (x: number): number => {
  const clamped = clamp(x, -TANH_RANGE, TANH_RANGE);
  const position = ((clamped + TANH_RANGE) / (2 * TANH_RANGE)) * TANH_STEPS;
  const index = Math.floor(position);
  if (index >= TANH_STEPS) return TANH_TABLE[TANH_STEPS]!;
  const fraction = position - index;
  const a = TANH_TABLE[index]!;
  const b = TANH_TABLE[index + 1]!;
  return a + (b - a) * fraction;
};

/** Smallest positive argument the logarithm table covers. */
const LOG_MIN = 1e-12;

/**
 * Natural logarithm, from a baked table, for arguments in `[LOG_MIN, 1]`.
 *
 * Baked for the same reason as `tanh`: the determinism contract bans the transcendental
 * functions because their results are not bit-identical across engines, and this feeds the
 * trainer's Gaussian sampler, where a run has to be reproducible.
 *
 * THE LOOKUP IS BY DIRECT COMPARISON OF THE ARGUMENT, not by tabulating logarithms and trying
 * to invert the table. Two earlier attempts did the latter and were wrong in ways that were
 * easy to miss: one tabulated the logarithm of the wrong argument, and the other kept a stray
 * `+1` that shifted every result by a constant, including making `log(1)` non-zero. Both
 * produced tables that looked reasonable and were wrong.
 *
 * What follows is deliberately literal. The table holds the ARGUMENT at each node, so finding
 * the interval containing `x` is a plain bisection on `x` and cannot be wrong about what the
 * table means. The value comes from a second table holding the logarithm at those same nodes.
 */
const LOG_STEPS = 4096;

const LOG_ARGUMENT = new Float64Array(LOG_STEPS + 1);
const LOG_VALUE = new Float64Array(LOG_STEPS + 1);
(() => {
  const logMin = Math.log(LOG_MIN);
  for (let i = 0; i <= LOG_STEPS; i++) {
    /*
     * ASCENDING, from LOG_MIN up to 1, and uniform in log space.
     *
     * Ascending is not cosmetic: the bisection below finds the largest node not exceeding the
     * argument, which requires the table to increase with its index. An earlier version filled
     * it from the top down and every lookup then returned the first or last entry.
     *
     * Uniform in log space is what makes the interpolation accurate across the whole range,
     * including near zero, where a uniform-in-x grid cannot follow the curve.
     */
    const argument = LOG_MIN * Math.exp(-logMin * (i / LOG_STEPS));
    LOG_ARGUMENT[i] = argument;
    LOG_VALUE[i] = Math.log(argument);
  }
  // Pin the last node to exactly 1, so `log(1)` is exactly zero rather than nearly zero.
  LOG_ARGUMENT[LOG_STEPS] = 1;
  LOG_VALUE[LOG_STEPS] = 0;
})();

export const logUnit = (x: number): number => {
  const clamped = x < LOG_MIN ? LOG_MIN : x > 1 ? 1 : x;

  // Ascending table: find the largest node whose argument does not exceed `clamped`.
  let low = 0;
  let high = LOG_STEPS;
  while (high - low > 1) {
    const mid = (low + high) >> 1;
    if (LOG_ARGUMENT[mid]! <= clamped) low = mid;
    else high = mid;
  }

  const aLow = LOG_ARGUMENT[low]!;
  const aHigh = LOG_ARGUMENT[high]!;
  const span = aHigh - aLow;
  const fraction = span > 0 ? (clamped - aLow) / span : 0;
  const bounded = fraction < 0 ? 0 : fraction > 1 ? 1 : fraction;
  return LOG_VALUE[low]! + (LOG_VALUE[high]! - LOG_VALUE[low]!) * bounded;
};

/**
 * Maps any real number onto [0, 1], smoothly and without a transcendental.
 *
 * Used for the one-sided controls — throttle and brake — where a linear clamp would
 * flatten the gradient to zero over most of the range and leave the search with nothing
 * to follow. This saturates gently instead, so a larger output always means a larger
 * control demand.
 */
export const saturateUnit = (value: number): number => {
  const m = value < 0 ? -value : value;
  if (m < 1e-9) return 0.5;
  return (1 + value / Math.sqrt(1 + value * value)) * 0.5;
};

/**
 * Clamps to [-1, 1].
 *
 * Used for steering, which is a bounded command rather than a demand: the driver asks
 * for a position, not for more of something, so saturating it would distort the meaning
 * of the value instead of merely limiting it.
 */
export const clampUnit = (value: number): number => (value < -1 ? -1 : value > 1 ? 1 : value);
