/**
 * Training by evolution strategy.
 *
 * WHY AN EVOLUTION STRATEGY RATHER THAN GRADIENT DESCENT. There is no gradient here. The
 * fitness of a driver is the outcome of a ninety-second physics simulation involving
 * collisions with track limits, tire saturation and gear changes; it is not differentiable
 * and cannot be back-propagated through. Evolution strategies are the standard answer: they
 * estimate a search direction from a population of perturbations, which needs only the
 * ability to SCORE a candidate.
 *
 * THE ALGORITHM. OpenAI-ES with antithetic sampling, rank-normalised fitness and Adam on the
 * search distribution. Each generation:
 *
 *   1. Draw a set of perturbations. Every perturbation is used TWICE, once positive and once
 *      negative, which cancels the first-order noise in the estimate for free — the standard
 *      variance-reduction trick.
 *   2. Score each perturbed driver on the circuit.
 *   3. Rank the scores and map them to a fixed distribution rather than using the raw
 *      values. This is the part that matters most in practice: lap-distance fitness has a
 *      long right tail, so one lucky driver would otherwise dominate the update and a few
 *      outliers would set the whole search direction. Ranking throws away the magnitudes and
 *      keeps only the ordering, so the step size is set by Adam rather than by luck.
 *   4. Take an Adam step along the estimated gradient.
 *
 * ELITISM. The best-ever parameters are kept separately and never mutated. A run therefore
 * cannot get worse than its best, which matters when a training run is left going overnight
 * and the results need to be usable whatever state it is interrupted in.
 *
 * SEEDING. Every random source is seeded and every evaluation is deterministic, so a run
 * with a given seed produces exactly the same curve. Without that, a training curve is noise
 * and no change to the code can be attributed to anything.
 */

import { runDriver, type RunResult, type RunOptions } from "./environment.ts";
import { createDriver, PARAMETER_COUNT, type Driver } from "./driver.ts";
import { createRng, type Rng } from "./rng.ts";
import { logUnit } from "./activation.ts";
import type { Track } from "./track.ts";

export interface EvolutionConfig {
  /** Perturbations per generation. Each is evaluated twice, so this is half the cost. */
  populationSize: number;
  /** Adam step size. The dominant knob: too large diverges, too small crawls. */
  learningRate: number;
  /** Standard deviation of the perturbation noise. */
  sigma: number;
  /** Adam first-moment decay. */
  beta1: number;
  /** Adam second-moment decay. */
  beta2: number;
  /** Adam denominator floor. */
  epsilon: number;
}

const DEFAULT_EVOLUTION: EvolutionConfig = {
  populationSize: 16,
  /*
   * Sized for the fitness scale rather than picked by feel. Fitness is roughly metres
   * covered, so it runs to hundreds; a step of 0.05 moves a weight by a fraction of a
   * percent per generation, which is slow but stable, and the rank normalisation below
   * keeps the effective step independent of how large the scores happen to be.
   */
  learningRate: 0.05,
  sigma: 0.02,
  beta1: 0.9,
  beta2: 0.999,
  epsilon: 1e-8,
};

export interface GenerationReport {
  /** 1-based generation number. */
  generation: number;
  /** Mean fitness of the sampled perturbations this generation. */
  meanFitness: number;
  /** Best fitness seen among this generation's samples. */
  bestSampleFitness: number;
  /** Fitness of the unperturbed parameters. */
  currentFitness: number;
  /** Best fitness ever recorded, and the generation it was found in. */
  bestEverFitness: number;
  bestEverGeneration: number;
  /** Mean distance of the samples, as a human-readable progress measure. */
  meanDistance: number;
  /** Fraction of the samples that stayed on the circuit. */
  meanOnTrack: number;
}

export interface TrainerState {
  config: EvolutionConfig;
  /** Current search centre. */
  mean: Float64Array;
  /** Best parameters ever found, never mutated. */
  best: Float64Array;
  bestFitness: number;
  bestGeneration: number;
  /** Adam moments. */
  moment1: Float64Array;
  moment2: Float64Array;
  generation: number;
  /** Random source for perturbations and scoring, so a run is reproducible. */
  rng: Rng;
  /*
   * Adam's bias-correction denominators, carried as RUNNING PRODUCTS rather than recomputed
   * with `Math.pow` each generation.
   *
   * `Math.pow` is not required to be bit-identical across JavaScript engines, so computing
   * `beta^step` would make a run's arithmetic depend on the engine it happened to run on —
   * which defeats the point of seeding everything else. Multiplying by beta once per
   * generation is exact and gives the same answer everywhere.
   */
  bias1Product: number;
  bias2Product: number;
}

/**
 * Standard normal samples, by Marsaglia's polar method.
 *
 * Written here rather than added to the seeded PRNG because the trainer is the only
 * consumer. The rejection loop draws uniform pairs and discards those outside the unit
 * disc, which keeps the arithmetic inside the determinism contract; the logarithm comes
 * from the baked table for the same reason, since a training run has to be reproducible.
 */
const createGaussian = (rng: Rng): (() => number) => {
  let spare: number | null = null;
  return () => {
    if (spare !== null) {
      const value = spare;
      spare = null;
      return value;
    }
    let u = 0;
    let v = 0;
    let s = 0;
    do {
      u = rng.nextSigned();
      v = rng.nextSigned();
      s = u * u + v * v;
    } while (s >= 1 || s <= 1e-12);
    const factor = Math.sqrt((-2 * logUnit(s)) / s);
    spare = v * factor;
    return u * factor;
  };
};

/**
 * Starts a trainer, optionally from parameters that already exist.
 *
 * RESUMING MATTERS FOR LONG RUNS. A thirteen-hour run is worth five hours of progress by the
 * time anything goes wrong, and without a way to continue, any interruption throws that away. An
 * earlier version could only start from a fresh random draw, so a restart meant starting over.
 *
 * The Adam moments deliberately restart from zero. They are an exponentially weighted average of
 * recent gradients, so they rebuild within a few generations, whereas carrying them across a
 * restart would apply a stale step size to a search that has moved on.
 */
export const createTrainer = (
  seed: number,
  config: Partial<EvolutionConfig> = {},
  initial?: Float64Array,
): TrainerState => {
  if (initial && initial.length !== PARAMETER_COUNT) {
    throw new Error(
      `resuming needs ${PARAMETER_COUNT} parameters but was given ${initial.length}; ` +
        `a checkpoint from a different network shape cannot be continued`,
    );
  }
  const rng = createRng(seed);
  const mean = new Float64Array(PARAMETER_COUNT);
  if (initial) {
    mean.set(initial);
  } else {
    const scale = 1 / Math.sqrt(PARAMETER_COUNT);
    for (let i = 0; i < PARAMETER_COUNT; i++) mean[i] = rng.nextSigned() * scale;
  }

  return {
    config: { ...DEFAULT_EVOLUTION, ...config },
    mean,
    best: mean.slice(),
    /*
     * A resumed run starts with its best unknown, so the first generation re-measures it. That
     * is deliberate: it means the recorded elite is always produced by this process rather than
     * inherited on trust from a file.
     */
    bestFitness: -Infinity,
    bestGeneration: 0,
    moment1: new Float64Array(PARAMETER_COUNT),
    moment2: new Float64Array(PARAMETER_COUNT),
    generation: 0,
    rng,
    bias1Product: 1,
    bias2Product: 1,
  };
};

/**
 * Scores one parameter vector, with its own driver and car state.
 *
 * EVERY EVALUATION GETS FRESH STATE, and that is a deliberate choice rather than an
 * oversight. An earlier version reused one driver, car and observation across a whole
 * generation to avoid allocating, which is the obvious optimisation — and it made
 * evaluation depend on the caller: the same genes scored differently depending on what had
 * been evaluated before, so a recorded elite could not be reproduced by re-running it. The
 * run reported a best fitness of 1751 for a driver that measured 786.
 *
 * The saving was never worth it. A generation is dominated by the physics — ninety seconds
 * of simulation at sixty hertz, per sample — and the driving state is a few small arrays.
 * Reproducibility is the foundation the whole trainer rests on, so the allocation is kept
 * and the reuse is gone.
 */
const score = (genes: Float64Array, track: Track, options: RunOptions): RunResult =>
  runDriver(createDriver(genes.slice(), () => 0), track, options);

/**
 * Runs one generation and returns what happened.
 *
 * @param track the circuit to train on
 * @param onSample called after each evaluation, for progress reporting
 */
export const trainGeneration = (
  state: TrainerState,
  track: Track,
  runOptions: RunOptions = {},
  onSample?: (done: number, total: number, result: RunResult) => void,
): GenerationReport => {
  const { config, rng } = state;
  const samples = config.populationSize;
  const gaussian = createGaussian(rng);

  // Antithetic pairs: one perturbation, scored in both directions.
  const perturbations: Float64Array[] = [];
  for (let i = 0; i < samples; i++) {
    const noise = new Float64Array(PARAMETER_COUNT);
    for (let p = 0; p < PARAMETER_COUNT; p++) noise[p] = gaussian() * config.sigma;
    perturbations.push(noise);
  }

  /*
   * The exact vectors that were scored, kept so the elite can be promoted by COPYING one
   * rather than by reconstructing it.
   *
   * Reconstructing from the mean is what an earlier version did, and it was wrong: Adam
   * updates the mean before the promotion runs, so `mean + noise` no longer equals the vector
   * that was evaluated. The recorded elite was therefore a different set of parameters from
   * the one that earned the score, and the run reported a best fitness its best driver could
   * not reproduce — 1751 claimed against 40 measured.
   */
  const variants: Float64Array[] = [];
  for (let i = 0; i < samples * 2; i++) variants.push(new Float64Array(PARAMETER_COUNT));
  const scores = new Float64Array(samples * 2);
  let meanFitness = 0;
  let bestSample = -Infinity;
  let meanDistance = 0;
  let onTrackSum = 0;

  const evaluate = (genes: Float64Array, index: number): void => {
    const result = score(genes, track, runOptions);
    scores[index] = result.fitness;
    meanFitness += result.fitness;
    meanDistance += result.distance;
    onTrackSum += result.onTrackFraction;
    if (result.fitness > bestSample) bestSample = result.fitness;
    onSample?.(index + 1, samples * 2, result);
  };

  // Score the unperturbed centre first, so progress is visible from generation one and the
  // elite can be updated even if every perturbation this generation happens to be worse.
  const scoredMean = state.mean.slice();
  const current = score(state.mean, track, runOptions);

  for (let i = 0; i < samples; i++) {
    const noise = perturbations[i]!;
    const plus = variants[i]!;
    const minus = variants[samples + i]!;
    for (let p = 0; p < PARAMETER_COUNT; p++) {
      plus[p] = state.mean[p]! + noise[p]!;
      minus[p] = state.mean[p]! - noise[p]!;
    }
    evaluate(plus, i);
    evaluate(minus, samples + i);
  }

  /*
   * RANK NORMALISATION, which is the step that makes this work on a fitness function with a
   * heavy tail. Raw distances can differ by an order of magnitude between a driver that
   * completes laps and one that crashes immediately, and using them directly lets a single
   * lucky sample set the entire search direction. Ranking keeps only the ordering, so the
   * step size is governed by the learning rate rather than by the spread of the scores.
   *
   * The mapping is the standard centred-and-scaled rank: utilities are spread evenly over
   * [-0.5, 0.5], so their mean is zero and the update is a proper weighted average of the
   * perturbations.
   */
  const order = Array.from({ length: scores.length }, (_, i) => i);
  order.sort((a, b) => scores[a]! - scores[b]!);
  const utilities = new Float64Array(scores.length);
  for (let rank = 0; rank < order.length; rank++) {
    utilities[order[rank]!] = rank / (order.length - 1) - 0.5;
  }

  // Estimated gradient, accumulated straight into the Adam update.
  const gradient = new Float64Array(PARAMETER_COUNT);
  for (let i = 0; i < samples; i++) {
    const noise = perturbations[i]!;
    const weight = utilities[i]! - utilities[samples + i]!;
    for (let p = 0; p < PARAMETER_COUNT; p++) gradient[p] = gradient[p]! + weight * noise[p]!;
  }
  const normalise = 1 / (samples * config.sigma);
  for (let p = 0; p < PARAMETER_COUNT; p++) gradient[p] = gradient[p]! * normalise;

  const step = state.generation + 1;
  state.bias1Product *= config.beta1;
  state.bias2Product *= config.beta2;
  const bias1 = 1 - state.bias1Product;
  const bias2 = 1 - state.bias2Product;
  for (let p = 0; p < PARAMETER_COUNT; p++) {
    state.moment1[p] = config.beta1 * state.moment1[p]! + (1 - config.beta1) * gradient[p]!;
    state.moment2[p] = config.beta2 * state.moment2[p]! + (1 - config.beta2) * gradient[p]! * gradient[p]!;
    const m = state.moment1[p]! / bias1;
    const v = state.moment2[p]! / bias2;
    state.mean[p] = state.mean[p]! + config.learningRate * (m / (Math.sqrt(v) + config.epsilon));
  }

  state.generation = step;
  if (current.fitness > state.bestFitness) {
    state.best.set(scoredMean);
    state.bestFitness = score(state.best, track, runOptions).fitness;
    state.bestGeneration = step;
  }
  /*
   * A sample can also beat the centre, and it would be wasteful to discard it: it is a
   * genuinely better set of parameters that has already been paid for. The best sample is
   * therefore promoted if it wins.
   */
  let bestIndex = 0;
  for (let i = 1; i < scores.length; i++) if (scores[i]! > scores[bestIndex]!) bestIndex = i;
  if (scores[bestIndex]! > state.bestFitness) {
    state.best.set(variants[bestIndex]!);
    // Confirm with an isolated evaluation, so the recorded number always belongs to the
    // recorded vector.
    state.bestFitness = score(state.best, track, runOptions).fitness;
    state.bestGeneration = step;
  }

  const total = samples * 2;
  return {
    generation: step,
    meanFitness: meanFitness / total,
    bestSampleFitness: bestSample,
    currentFitness: current.fitness,
    bestEverFitness: state.bestFitness,
    bestEverGeneration: state.bestGeneration,
    meanDistance: meanDistance / total,
    meanOnTrack: onTrackSum / total,
  };
};

/**
 * The parameter count, re-exported so a caller can size a checkpoint without importing the
 * driver module as well.
 */
export const PARAMETER_COUNT_CHECK = PARAMETER_COUNT;

/** A driver built from the best parameters found so far. */
export const bestDriver = (state: TrainerState): Driver =>
  createDriver(state.best.slice(), () => 0);

/** A driver built from the current search centre, for comparison. */
export const meanDriver = (state: TrainerState): Driver =>
  createDriver(state.mean.slice(), () => 0);
