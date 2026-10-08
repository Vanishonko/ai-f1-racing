/**
 * Watches a short training run and reports whether the search is healthy.
 *
 *   node scripts/evolution-health.ts [--generations 30] [--seconds 90] [--population 24] [--seed 7]
 *
 * WHY THIS EXISTS. A thirteen-hour run improved for six generations and then achieved nothing for
 * five thousand three hundred more. The information was in the log the whole time — the best-ever
 * column simply never changed — and nothing was reading it. Diagnosing that took a throwaway script
 * in a temporary directory, which is not a diagnosis, it is an anecdote.
 *
 * What it reports, per generation: the elite's pace, the search centre's own score, the
 * population's mean distance and on-track fraction, and any health warning. The centre column is the
 * one that matters most and the one a normal training log omits: if the centre is far below the
 * elite, the search has wandered into a worse region and is no longer exploring anywhere useful.
 *
 * Exits non-zero if the run looks dead, so it can be used as a check rather than read by eye.
 */

import { buildCircuitByKey } from "../packages/engine/src/trackLibrary.ts";
import { createTrainer, trainGeneration, bestDriver, assessRun } from "../packages/engine/src/evolve.ts";
import { runDriver } from "../packages/engine/src/environment.ts";
import { createEvaluationPool } from "../packages/engine/src/evaluationPool.ts";

const arg = (name: string, fallback: number): number => {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) return fallback;
  const value = Number(process.argv[index + 1]);
  return Number.isFinite(value) ? value : fallback;
};

const circuitKey = (() => {
  const index = process.argv.indexOf("--circuit");
  return index < 0 ? "club" : (process.argv[index + 1] ?? "club");
})();

const generations = arg("generations", 30);
const seconds = arg("seconds", 90);
const population = arg("population", 24);
const seed = arg("seed", 7);

const track = buildCircuitByKey(circuitKey);
if (!track) {
  console.error(`no such circuit: ${circuitKey}`);
  process.exit(1);
}

/*
 * REPORT THE COST BEFORE SPENDING IT.
 *
 * A run's duration is the thing anyone deciding whether to start one actually wants to know, and
 * working it out afterwards is useless. One evaluation is a fixed amount of simulation, so the
 * whole run is arithmetic: generations x perturbations x 2 (antithetic pairs) x the cost of one
 * evaluation. The cost is measured here rather than assumed, because it depends on the circuit and
 * the evaluation length.
 */
const measureEvaluationCost = async (pool: ReturnType<typeof createEvaluationPool>): Promise<number> => {
  const state = createTrainer(seed, { populationSize: 2 });
  const started = Date.now();
  await trainGeneration(state, track, { seconds }, undefined, pool);
  // Two perturbations are four evaluations, plus the centre's own.
  return (Date.now() - started) / 1000 / 5;
};
const pool = createEvaluationPool();
const SAMPLE = await measureEvaluationCost(pool);

const totalEvaluations = generations * population * 2 + generations;
const estimatedSeconds = totalEvaluations * SAMPLE;
const finish = new Date(Date.now() + estimatedSeconds * 1000);

console.log(`started ${new Date().toISOString()}`);
console.log(`using ${pool.size} worker threads`);
console.log(
  `${track.name}, ${generations} generations, ${population} perturbations, ` +
    `${seconds} s evaluations, seed ${seed}`,
);
console.log(
  `one evaluation takes ${(SAMPLE * 1000).toFixed(0)} ms, so ${totalEvaluations} evaluations ` +
    `will take about ${(estimatedSeconds / 60).toFixed(1)} minutes`,
);
console.log(`estimated finish around ${finish.toISOString()}\n`);

if (process.argv.includes("--estimate-only")) { await pool.close(); process.exit(0); }

const state = createTrainer(seed, { populationSize: population });
console.log("gen   elite    centre   mean-dist  on-track  steer   sample-best   note");

let lastWarning = "";
let collapses = 0;
let bestAtStart = -Infinity;

for (let generation = 1; generation <= generations; generation++) {
  const report = await await trainGeneration(state, track, { seconds });
  const health = assessRun(state, report);
  const elite = runDriver(bestDriver(state), track, { seconds });

  if (health.collapsed) collapses++;
  const note = health.warning && health.warning !== lastWarning ? `  <-- ${health.warning}` : "";
  lastWarning = health.warning;

  if (generation <= 3 || generation % 3 === 0 || note) {
    console.log(
      `${String(generation).padStart(3)}   ${(elite.averageSpeed * 3.6).toFixed(0).padStart(4)}   ` +
        `${report.currentFitness.toFixed(2).padStart(7)}   ${report.meanDistance.toFixed(0).padStart(9)}  ` +
        `${(report.meanOnTrack * 100).toFixed(0).padStart(7)}%  ${elite.steeringWork.toFixed(2).padStart(5)}   ` +
        `${report.bestSampleFitness.toFixed(2).padStart(11)}${note}`,
    );
  }
  if (generation === 1) bestAtStart = report.bestEverFitness;
}

const finalElite = runDriver(bestDriver(state), track, { seconds });
const improved = state.bestFitness > Math.max(bestAtStart, 0.01);

console.log(
  `\nelite after ${generations} generations: ${finalElite.distance.toFixed(0)} m, ` +
    `${(finalElite.averageSpeed * 3.6).toFixed(0)} km/h average, ` +
    `${finalElite.laps} laps, on track ${(finalElite.onTrackFraction * 100).toFixed(0)}%, ` +
    `steering work ${finalElite.steeringWork.toFixed(2)}, ` +
    `braking ${(finalElite.lockedFraction * 100).toFixed(1)}%`,
);
console.log(`best-so-far fitness ${state.bestFitness.toFixed(2)} found at generation ${state.bestGeneration}`);
console.log(
  `health: ${collapses} collapsed generations, ` +
    `${generations - state.bestGeneration} since the last improvement`,
);

/*
 * A non-zero exit when the search never improved is the whole point of the tool: it makes "the run
 * is dead" something a script can act on rather than something a person has to notice.
 */
await pool.close();

if (!improved) {
  console.error("\nFAIL: the search produced no improvement at all");
  process.exit(2);
}
