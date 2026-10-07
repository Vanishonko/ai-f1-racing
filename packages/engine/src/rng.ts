/**
 * Seeded pseudo-random number generation for the simulation core.
 *
 * The sim never calls `Math.random()`. Replays reproduce from `(seed, genome)`,
 * which is what keeps checkpoints small and lets the trainer and the viewer share
 * one engine. `scripts/lint-determinism.ts` enforces that.
 *
 * xorshift128+ is used because it is pure integer arithmetic — no floating point
 * rounding to differ between engines — and has a long enough period for a
 * multi-day training run.
 */

export interface Rng {
  /** Next raw 32-bit unsigned value. State advances. */
  nextUint32(): number;
  /** Uniform float in [0, 1). */
  nextFloat(): number;
  /** Uniform integer in [0, bound). */
  nextInt(bound: number): number;
  /** Uniform float in [-1, 1). */
  nextSigned(): number;
  /** Derives an independent stream, e.g. one per car. */
  fork(label: number): Rng;
}

/** SplitMix64, used only to expand a single seed into two non-zero state words. */
const splitMix64 = (seed: number): [number, number] => {
  let z = BigInt(Math.floor(seed)) ^ 0x9e3779b97f4a7c15n;
  const mask = 0xffffffffffffffffn;

  const next = (): number => {
    z = (z + 0x9e3779b97f4a7c15n) & mask;
    let x = z;
    x = ((x ^ (x >> 30n)) * 0xbf58476d1ce4e5b9n) & mask;
    x = ((x ^ (x >> 27n)) * 0x94d049bb133111ebn) & mask;
    x = x ^ (x >> 31n);
    return Number(x & 0xffffffffn) >>> 0;
  };

  return [next(), next()];
};

export const createRng = (seed: number): Rng => {
  const [s0, s1] = splitMix64(seed);
  // xorshift128+ requires a non-zero state; splitMix64 output could be zero.
  let lo = s0 === 0 ? 0x9e3779b9 : s0;
  let hi = s1 === 0 ? 0x85ebca6b : s1;

  const nextUint32 = (): number => {
    let x = lo;
    const y = hi;
    lo = y;
    // NOTE: regular numbers, not BigInt, because the arithmetic stays inside 53
    // bits; BigInt here would be far slower and the output would be identical.
    x ^= (x << 23) >>> 0;
    x ^= x >>> 17;
    x ^= y ^ (y >>> 26);
    hi = x >>> 0;
    lo = y >>> 0;
    return (hi + lo) >>> 0;
  };

  const nextFloat = (): number => nextUint32() / 4294967296;

  return {
    nextUint32,
    nextFloat,
    nextInt: (bound: number): number =>
      bound <= 0 ? 0 : Math.floor(nextFloat() * bound),
    nextSigned: (): number => nextFloat() * 2 - 1,
    fork: (label: number): Rng => createRng((nextUint32() ^ (label * 0x9e3779b9)) >>> 0),
  };
};

/**
 * Baked grip-noise table.
 *
 * Real asphalt is not perfectly uniform and real drivers deal with that, so tire
 * grip is modulated by a small deterministic wobble along the track. It is baked
 * once at module load from a fixed seed and shared by all cars, so it is a
 * property of the world rather than of any car.
 *
 * Magnitude is deliberately small: enough to make the limit a moving target,
 * not enough to feel random.
 */
export const GRIP_NOISE_STEPS = 4096;
export const GRIP_NOISE_AMPLITUDE = 0.015;

export const GRIP_NOISE = ((): Float64Array => {
  const rng = createRng(0x5eed_1234);
  const table = new Float64Array(GRIP_NOISE_STEPS);
  // Smooth the raw noise so grip varies gradually rather than jittering per step.
  let previous = 0;
  for (let i = 0; i < GRIP_NOISE_STEPS; i++) {
    const raw = rng.nextSigned() * GRIP_NOISE_AMPLITUDE;
    previous = previous * 0.7 + raw * 0.3;
    table[i] = 1 + previous;
  }
  return table;
})();

/**
 * Samples the grip noise table at a track distance.
 *
 * Wraps, because a track is a closed loop. Linear interpolation between samples
 * keeps it smooth as speed varies.
 */
export const gripNoiseAt = (distanceAlongTrack: number, trackLength: number): number => {
  if (trackLength <= 0) return 1;
  const normalized = (distanceAlongTrack / trackLength) % 1;
  const position = (normalized + (normalized < 0 ? 1 : 0)) * GRIP_NOISE_STEPS;
  const index = position | 0;
  const fraction = position - index;
  const lo = GRIP_NOISE[index % GRIP_NOISE_STEPS]!;
  const hi = GRIP_NOISE[(index + 1) % GRIP_NOISE_STEPS]!;
  return lo + (hi - lo) * fraction;
};
