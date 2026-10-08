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
   * CHOSEN BY SWEEPING, not by feel. Both of these were originally guessed — 0.05 and 0.02, picked
   * in the first version and never revisited — and both were wrong in a way that is invisible
   * without a sweep.
   *
   * `scripts/tune-search.ts` runs the search across a grid of settings and reports the elite's pace
   * each reaches. Measured over ten generations: learning rate 0.03 with sigma 0.03 reaches 80 km/h,
   * while the old 0.05/0.02 reaches 22. Sigma 0.01 collapses to ZERO at every learning rate,
   * because perturbations that small cannot change behaviour enough for the ranking to mean
   * anything — every sample scores the same and the update has nothing to follow.
   *
   * That is the failure mode worth remembering: a search whose perturbations are too small does not
   * look broken, it looks like a training curve that wanders. It cost a thirteen-hour run to find
   * out.
   */
  learningRate: 0.03,
  sigma: 0.03,
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

  /*
   * RESTART FROM THE ELITE WHEN THE SEARCH HAS LOST ITS WAY.
   *
   * Diagnosed from a training curve, and it was the whole reason a thirteen-hour run produced
   * nothing. The centre's fitness peaked at generation six and then DECAYED — 1047, then 562, then
   * 8 — while the elite stayed put because elitism keeps a copy. The search had walked into a bad
   * region with no way back: a rank-normalised update is equally content to march deeper into a
   * basin as out of it.
   *
   * The measurement that proved it: taking the stuck centre and applying forty ordinary
   * perturbations, THIRTEEN of them scored better. Better parameters were all around it and its own
   * updates could not find them.
   *
   * So when the centre has fallen behind the elite, it is SNAPPED ONTO THE ELITE and the next
   * generation explores from there. A first attempt at this pulled the centre halfway back every
   * generation instead, which is a different thing entirely and much worse: a continuous pull
   * drags every sample towards one point, so the population loses its variation and the ranking
   * stops carrying information. Measured with the pull, the centre's fitness went to zero within
   * four generations and never recovered. A reset happens once and leaves the next generation free
   * to spread out again.
   */
  if (current.fitness < state.bestFitness) {
    state.mean.set(state.best);
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

/**
 * How healthy a run looks, judged from its own history.
 *
 * BUILT BECAUSE A THIRTEEN-HOUR RUN WAS WASTED. It resumed at generation 294 and reached its
 * best-ever score by generation 300, then produced NO improvement for 5,300 further generations —
 * twelve hours fifty of computation that achieved nothing, and nothing in the output said so. The
 * information was all there: the best-ever column was identical in every line. Nobody was reading
 * it, which is the same as not measuring it.
 *
 * Three failure modes are detectable from the numbers a generation already reports:
 *
 *  - PLATEAU: the best-ever score has not moved for a long time. Either the search is finished or
 *    it is stuck, and either way the run should be told rather than left to burn hours.
 *  - COLLAPSE: the population's centre is far worse than the best ever found. This is the specific
 *    failure that wasted the long run — the centre decayed from 1047 to 8 while elitism kept the
 *    elite, so the search was exploring a region it had already left behind.
 *  - STAGNATION: the whole population is clustered at one score, so the ranking carries no
 *    information and the update has nothing to follow.
 */
export interface RunHealth {
  /** Generations since the best-ever score last improved. */
  generationsSinceImprovement: number;
  /** True when the centre has fallen far behind the best ever recorded. */
  collapsed: boolean;
  /** True when the population's scores are so similar that ranking says nothing. */
  stagnant: boolean;
  /** True when nothing has improved for long enough that the run is unlikely to recover. */
  plateaued: boolean;
  /** A one-line summary, empty when the run looks healthy. */
  warning: string;
}

/** Generations without improvement before a run is called plateaued. */
const PLATEAU_GENERATIONS = 150;
/** How far below the elite the centre may fall before the search is called collapsed. */
const COLLAPSE_FRACTION = 0.5;

export const assessRun = (state: TrainerState, report: GenerationReport): RunHealth => {
  const sinceImprovement = report.generation - state.bestGeneration;
  /*
   * The centre is compared against the elite's score. A modest gap is normal and healthy — the
   * elite is the best of many samples, so it sits above the average by construction. A large gap
   * means the search centre has wandered somewhere much worse, which is the collapse above.
   */
  /*
   * Guarded against a tiny or negative best, which the ratio would turn into a false alarm. Early
   * generations legitimately have a best near zero while the centre has not found its feet yet.
   */
  const collapsed =
    state.bestFitness > 1 && report.currentFitness < state.bestFitness * COLLAPSE_FRACTION;
  const stagnant = report.bestSampleFitness - report.meanFitness < 1e-9 && report.meanFitness > 0;
  const plateaued = sinceImprovement >= PLATEAU_GENERATIONS;

  let warning = "";
  if (collapsed) {
    warning =
      `the search centre (${report.currentFitness.toFixed(0)}) has fallen far below its best ` +
      `(${state.bestFitness.toFixed(0)}); it has wandered into a worse region`;
  } else if (stagnant) {
    warning =
      `every sample scores the same (${report.meanFitness.toFixed(0)}), so ranking carries no ` +
      `information and the update has nothing to follow`;
  } else if (plateaued) {
    warning =
      `no improvement for ${sinceImprovement} generations; the search is either finished or stuck`;
  }
  return { generationsSinceImprovement: sinceImprovement, collapsed, stagnant, plateaued, warning };
};

/** A driver built from the best parameters found so far. */
export const bestDriver = (state: TrainerState): Driver =>
  createDriver(state.best.slice(), () => 0);

/** A driver built from the current search centre, for comparison. */
export const meanDriver = (state: TrainerState): Driver =>
  createDriver(state.mean.slice(), () => 0);
