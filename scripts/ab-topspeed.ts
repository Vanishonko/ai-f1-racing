/**
 * Does rewarding top speed produce a faster driver?
 *
 *   node scripts/ab-topspeed.ts [--generations 60] [--seconds 90] [--population 32]
 *
 * WHY. "Give them a reason to reach high speed" is a reasonable idea and also the kind of idea that
 * can be argued forever. It costs a few minutes to answer instead.
 *
 * The concern worth testing is specific: an average-speed objective does not directly ask for
 * outright speed, so a driver could hold a respectable average by never slowing much while never
 * using the throttle properly either — which is exactly what the first trained driver did, full
 * throttle for eight per cent of a run and a peak of 196 km/h in a car capable of 308.
 *
 * But a top-speed reward has an obvious failure mode too: it is one number from one moment, so a
 * driver could earn it with a single fast straight and drive the rest of the lap badly. The test is
 * whether it improves the WHOLE run, not whether it raises the peak.
 *
 * Both arms are trained from the same seed for the same budget and judged on the same measures.
 */

import { buildCircuitByKey } from "../packages/engine/src/trackLibrary.ts";
import { createTrainer, trainGeneration, bestDriver } from "../packages/engine/src/evolve.ts";
import { runDriver, type RunOptions } from "../packages/engine/src/environment.ts";
import { createEvaluationPool } from "../packages/trainer/src/evaluationPool.ts";

const arg = (name: string, fallback: number): number => {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) return fallback;
  const value = Number(process.argv[index + 1]);
  return Number.isFinite(value) ? value : fallback;
};

const circuitIndex = process.argv.indexOf("--circuit");
const circuitKey = circuitIndex < 0 ? "club" : (process.argv[circuitIndex + 1] ?? "club");
const generations = arg("generations", 60);
const seconds = arg("seconds", 90);
const population = arg("population", 32);
const seed = arg("seed", 5);

const track = buildCircuitByKey(circuitKey);
if (!track) {
  console.error(`no such circuit: ${circuitKey}`);
  process.exit(1);
}

interface Arm {
  label: string;
  topSpeedWeight: number;
}

const ARMS: Arm[] = [
  { label: "pace only", topSpeedWeight: 0 },
  { label: "pace + top speed", topSpeedWeight: 0.15 },
];

const pool = createEvaluationPool();
const started = Date.now();

console.log(
  `${track.name}, ${generations} generations per arm, ${population} perturbations, ` +
    `${seconds} s evaluations, seed ${seed}`,
);
console.log(`using ${pool.size} worker threads, started ${new Date().toISOString()}\n`);

const summarize = (driver: ReturnType<typeof bestDriver>, options: RunOptions) => {
  const result = runDriver(driver, track, options);
  return {
    peak: result.topSpeed * 3.6,
    mean: result.averageSpeed * 3.6,
    distance: result.distance,
    laps: result.laps,
    onTrack: result.onTrackFraction,
    steer: result.steeringWork,
    // How much of the run is spent anywhere near the car's limit, which is the thing top speed is a
    // proxy for and average speed is not.
    fitness: result.fitness,
  };
};

const results: Array<{ arm: Arm; summary: ReturnType<typeof summarize>; minutes: number }> = [];

for (const arm of ARMS) {
  const state = createTrainer(seed, { populationSize: population });
  const options: RunOptions = { seconds, objective: "speed", topSpeedWeight: arm.topSpeedWeight };
  const armStart = Date.now();

  for (let generation = 1; generation <= generations; generation++) {
    await trainGeneration(state, track, options, undefined, pool);
    if (generation % 20 === 0) {
      const running = runDriver(bestDriver(state), track, { seconds });
      console.log(
        `  ${arm.label.padEnd(18)} gen ${String(generation).padStart(3)}  ` +
          `peak ${(running.topSpeed * 3.6).toFixed(0).padStart(3)}  ` +
          `mean ${(running.averageSpeed * 3.6).toFixed(0).padStart(3)} km/h  ` +
          `on track ${(running.onTrackFraction * 100).toFixed(0).padStart(3)}%`,
      );
    }
  }
  results.push({
    arm,
    summary: summarize(bestDriver(state), { seconds }),
    minutes: (Date.now() - armStart) / 60000,
  });
}

await pool.close();

console.log(`\n  arm                  peak    mean   laps  on trk  steer   fitness`);
for (const entry of results) {
  const s = entry.summary;
  console.log(
    `  ${entry.arm.label.padEnd(18)} ${s.peak.toFixed(0).padStart(4)}  ${s.mean.toFixed(0).padStart(5)}  ` +
      `${String(s.laps).padStart(5)}  ${(s.onTrack * 100).toFixed(0).padStart(5)}%  ` +
      `${s.steer.toFixed(2).padStart(5)}  ${s.fitness.toFixed(0).padStart(8)}`,
  );
}

const [plain, boosted] = results;
if (plain && boosted) {
  const meanGain = boosted.summary.mean - plain.summary.mean;
  const peakGain = boosted.summary.peak - plain.summary.peak;
  console.log(
    `\ntop speed reward: mean speed ${meanGain >= 0 ? "+" : ""}${meanGain.toFixed(0)} km/h, ` +
      `peak ${peakGain >= 0 ? "+" : ""}${peakGain.toFixed(0)} km/h`,
  );
  /*
   * The honest verdict, stated in terms of the thing that matters. A reward that raises the peak
   * while lowering the average has made the driver worse at racing and better at one measurement.
   */
  if (meanGain > 2) console.log("VERDICT: it helps — the whole run is faster, not just the peak");
  else if (peakGain > 5 && meanGain < 0) {
    console.log("VERDICT: it is a trap — the peak rises while the lap gets slower");
  } else console.log("VERDICT: no meaningful difference at this budget");
}
console.log(`\ntotal elapsed ${((Date.now() - started) / 60000).toFixed(1)} minutes`);

