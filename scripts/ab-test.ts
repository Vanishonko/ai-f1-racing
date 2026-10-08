/**
 * Isolates which change to the objective broke driver performance.
 *
 *   node scripts/ab-test.ts [--generations 30] [--seconds 90] [--circuit club]
 *
 * WHY. Four changes were made to the objective and the controls in one go — an actuator rate limit,
 * an objective of average speed instead of distance, a steering-work penalty, and a gate on staying
 * on the circuit — and together they took the trained driver from lapping at 171 km/h to a plateau
 * around 50. Changing several things at once and measuring the result tells you nothing about which
 * one mattered, and adding a fix on top of an unmeasured regression is how a project ends up worse
 * than it started.
 *
 * This runs the SAME search budget and seed against several configurations, each differing from the
 * known-good baseline in exactly one respect, and reports the elite's pace for each. Whichever
 * single change costs the most is the one to fix.
 *
 * The baseline is the configuration the good driver was trained under: distance as the objective, a
 * power-law on-track bonus, no actuator limit, no smoothing penalty.
 */

import { buildCircuitByKey } from "../packages/engine/src/trackLibrary.ts";
import { createTrainer, trainGeneration, bestDriver } from "../packages/engine/src/evolve.ts";
import { runDriver, type RunOptions } from "../packages/engine/src/environment.ts";
import { drive, type Driver } from "../packages/engine/src/driver.ts";
import { runPolicy } from "../packages/engine/src/environment.ts";

const arg = (name: string, fallback: number): number => {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) return fallback;
  const value = Number(process.argv[index + 1]);
  return Number.isFinite(value) ? value : fallback;
};

const circuitIndex = process.argv.indexOf("--circuit");
const circuitKey = circuitIndex < 0 ? "club" : (process.argv[circuitIndex + 1] ?? "club");
const generations = arg("generations", 30);
const seconds = arg("seconds", 90);
const population = arg("population", 24);
const seed = arg("seed", 3);

const track = buildCircuitByKey(circuitKey);
if (!track) {
  console.error(`no such circuit: ${circuitKey}`);
  process.exit(1);
}

/**
 * Runs a driver WITHOUT the actuator limit, which is how every driver before the smoothing work was
 * driven. Needed so the baseline can be reproduced faithfully.
 */
const runRaw = (driver: Driver, options: RunOptions) =>
  runPolicy(
    (observation, controls) => {
      drive(driver, observation, controls);
    },
    track,
    options,
  );

interface Variant {
  name: string;
  /** Whether the car receives rate-limited controls. */
  smoothed: boolean;
  /** Whether the search is scored on average speed rather than distance. */
  speedObjective: boolean;
}

/*
 * One variable at a time against the known-good baseline.
 */
const VARIANTS: Variant[] = [
  { name: "baseline (raw controls, distance)", smoothed: false, speedObjective: false },
  { name: "+ actuator limit", smoothed: true, speedObjective: false },
  { name: "+ speed objective", smoothed: false, speedObjective: true },
  { name: "both", smoothed: true, speedObjective: true },
];

const scoreElite = (driver: Driver, smoothed: boolean): { kmh: number; laps: number; onTrack: number; steer: number } => {
  const result = smoothed
    ? runDriver(driver, track, { seconds })
    : runRaw(driver, { seconds });
  return {
    kmh: result.averageSpeed * 3.6,
    laps: result.laps,
    onTrack: result.onTrackFraction,
    steer: result.steeringWork,
  };
};

console.log(
  `${track.name}, ${generations} generations each, ${population} perturbations, ` +
    `${seconds} s evaluations, seed ${seed}\n`,
);
console.log("  variant                              elite km/h   laps   on trk   steer");

for (const variant of VARIANTS) {
  /*
   * Train under this variant's objective, then judge every variant by the SAME measure — its pace.
   * A driver selected on distance and one selected on speed are compared on the number that
   * actually matters, so the objective's effect is what differs rather than the yardstick.
   */
  const state = createTrainer(seed, { populationSize: population });
  const options: RunOptions = {
    seconds,
    objective: variant.speedObjective ? "speed" : "distance",
  };
  for (let generation = 1; generation <= generations; generation++) {
    await trainGeneration(state, track, options);
  }
  const elite = bestDriver(state);
  const measured = scoreElite(elite, variant.smoothed);
  console.log(
    `  ${variant.name.padEnd(36)} ${measured.kmh.toFixed(0).padStart(10)}   ` +
      `${String(measured.laps).padStart(4)}   ${(measured.onTrack * 100).toFixed(0).padStart(6)}%   ` +
      `${measured.steer.toFixed(2).padStart(5)}`,
  );
}

