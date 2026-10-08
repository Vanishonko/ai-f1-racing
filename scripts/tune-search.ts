/**
 * Sweeps the search's own settings and reports which ones actually learn.
 *
 *   node scripts/tune-search.ts [--generations 12] [--seconds 45] [--circuit club]
 *
 * WHY. The step size and the perturbation scale are the two settings that decide whether an
 * evolution strategy works at all, and both had been guessed: 0.05 and 0.02, picked by feel in the
 * first version and never revisited. A search whose perturbations are too small cannot tell its
 * samples apart — every score is noise, the ranking carries no information, and the run oscillates
 * instead of climbing. One whose steps are too large overshoots and never settles.
 *
 * Neither failure looks like a bug. Both look like a training curve that goes up a little and then
 * wanders. That is exactly what happened here, twice, for hours at a time.
 *
 * The metric is the ELITE'S PACE after a fixed, short budget, which is cheap and comparable across
 * settings, plus how many generations it took to get there. A setting that reaches a good score
 * quickly is better than one that crawls to the same place.
 */

import { buildCircuitByKey } from "../packages/engine/src/trackLibrary.ts";
import { createTrainer, trainGeneration, bestDriver } from "../packages/engine/src/evolve.ts";
import { runDriver } from "../packages/engine/src/environment.ts";

const arg = (name: string, fallback: number): number => {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) return fallback;
  const value = Number(process.argv[index + 1]);
  return Number.isFinite(value) ? value : fallback;
};

const circuitIndex = process.argv.indexOf("--circuit");
const circuitKey = circuitIndex < 0 ? "club" : (process.argv[circuitIndex + 1] ?? "club");
const generations = arg("generations", 12);
const seconds = arg("seconds", 45);
const population = arg("population", 24);
const seed = arg("seed", 3);

const track = buildCircuitByKey(circuitKey);
if (!track) {
  console.error(`no such circuit: ${circuitKey}`);
  process.exit(1);
}

interface Outcome {
  learningRate: number;
  sigma: number;
  eliteKmh: number;
  bestFitness: number;
  improvedAt: number;
}

const outcomes: Outcome[] = [];

/*
 * A deliberately wide sweep. The point is to find the ORDER OF MAGNITUDE that works, not to
 * fine-tune: a setting that is wrong by a factor of ten will look flat no matter how it is nudged.
 */
const LEARNING_RATES = [0.01, 0.03, 0.1, 0.3];
const SIGMAS = [0.01, 0.03, 0.1, 0.3];

console.log(
  `${track.name}, ${generations} generations per setting, ${population} perturbations, ` +
    `${seconds} s evaluations\n`,
);
console.log("  lr     sigma   elite km/h   best fitness   first improvement");

for (const learningRate of LEARNING_RATES) {
  for (const sigma of SIGMAS) {
    const state = createTrainer(seed, { populationSize: population, learningRate, sigma });
    let improvedAt = -1;
    for (let generation = 1; generation <= generations; generation++) {
      const before = state.bestFitness;
      trainGeneration(state, track, { seconds });
      if (improvedAt < 0 && state.bestFitness > before) improvedAt = generation;
    }
    const elite = runDriver(bestDriver(state), track, { seconds });
    const outcome: Outcome = {
      learningRate,
      sigma,
      eliteKmh: elite.averageSpeed * 3.6,
      bestFitness: state.bestFitness,
      improvedAt,
    };
    outcomes.push(outcome);
    console.log(
      `  ${String(learningRate).padEnd(6)} ${String(sigma).padEnd(7)} ` +
        `${outcome.eliteKmh.toFixed(0).padStart(10)}   ${outcome.bestFitness.toFixed(2).padStart(12)}   ` +
        `${improvedAt < 0 ? "never" : String(improvedAt).padStart(17)}`,
    );
  }
}

const ranked = outcomes.slice().sort((a, b) => b.eliteKmh - a.eliteKmh);
const best = ranked[0]!;
const worst = ranked[ranked.length - 1]!;

console.log(
  `\nbest  : learning rate ${best.learningRate}, sigma ${best.sigma} -> ` +
    `${best.eliteKmh.toFixed(0)} km/h`,
);
console.log(
  `worst : learning rate ${worst.learningRate}, sigma ${worst.sigma} -> ` +
    `${worst.eliteKmh.toFixed(0)} km/h`,
);

/*
 * If the spread across settings is small the search is insensitive to them and something else is
 * the limit — the network, the objective or the observation. Saying so is more useful than
 * reporting a winner among near-identical numbers.
 */
const spread = best.eliteKmh - worst.eliteKmh;
console.log(
  spread < 5
    ? `\nSPREAD IS ONLY ${spread.toFixed(0)} km/h: the search is insensitive to these settings, ` +
      `so something else is the limit`
    : `\nspread is ${spread.toFixed(0)} km/h, so these settings matter`,
);
