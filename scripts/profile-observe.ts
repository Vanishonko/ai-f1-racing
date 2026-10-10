/*
 * Where does evaluation time actually go, and is the ray fan worth precomputing?
 *
 * `observe` is the largest single cost in an evaluation, and the ray fan is most of `observe`. The
 * open question is whether that work is CACHEABLE: the ray fan casts eleven rays by walking the track
 * in 6 m steps, up to 90 m, and each step projects a point onto the centreline. If the answer is a
 * function of where the car is and which way it points, it can be baked per circuit.
 *
 * This measures the split first, because a cache for something that is 5 per cent of the cost is not
 * worth the invalidation risk.
 *
 *   node scripts/profile-observe.ts [--circuit club] [--steps 5400]
 */
import { buildCircuitByKey } from "../packages/engine/src/trackLibrary.ts";
import { createCarState, DEFAULT_CAR_PARAMS, stepCar, CLEAN_AIR } from "../packages/engine/src/car.ts";
import { createObservation, observe } from "../packages/engine/src/sense.ts";
import { projectToTrackNear, pointAtDistance } from "../packages/engine/src/track.ts";
import { createDriver, driveSmoothed } from "../packages/engine/src/driver.ts";
import { createRng } from "../packages/engine/src/rng.ts";
import { DT } from "../packages/engine/src/environment.ts";
import type { Controls } from "../packages/engine/src/driver.ts";

const arg = (name: string, fallback: string): string => {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 && process.argv[at + 1] ? process.argv[at + 1]! : fallback;
};

const track = buildCircuitByKey(arg("circuit", "club"))!;
const steps = Number(arg("steps", "5400"));

const rng = createRng(12345);
const driver = createDriver(
  Float64Array.from({ length: 675 }, () => rng.nextSigned() * 0.1),
  () => 0.5,
);
const car = createCarState();
const perspective = pointAtDistance(track, 0);
car.x = perspective.x;
car.y = perspective.y;
car.heading = 0;
const observation = createObservation();
const controls: Controls = { throttle: 0, brake: 0, steer: 0 };
const context = { ...CLEAN_AIR };

const time = (label: string, fn: () => void): number => {
  // One warm-up pass so JIT compilation is not attributed to the measurement.
  fn();
  const started = process.hrtime.bigint();
  fn();
  const elapsed = Number(process.hrtime.bigint() - started) / 1e6;
  console.log(`  ${label.padEnd(28)} ${elapsed.toFixed(1).padStart(7)} ms`);
  return elapsed;
};

console.log(`${track.name}: ${steps} steps of ${(DT * 1000).toFixed(1)} ms\n`);

/*
 * The whole loop first, then each stage on its own with the others held constant. Stages are measured
 * against the same number of iterations as the full loop, so the columns add up against the total.
 */
const full = time("full step loop", () => {
  for (let i = 0; i < steps; i++) {
    observe(observation, car, track, 0);
    const applied = driveSmoothed(driver, observation, DT);
    controls.throttle = applied.throttle;
    controls.brake = applied.brake;
    controls.steer = applied.steer;
    car.throttle = controls.throttle;
    car.brake = controls.brake;
    car.steerCommand = controls.steer;
    stepCar(car, DEFAULT_CAR_PARAMS, DT, context);
  }
});

const observeOnly = time("observe", () => {
  for (let i = 0; i < steps; i++) observe(observation, car, track, 0);
});

const driveOnly = time("drive", () => {
  for (let i = 0; i < steps; i++) driveSmoothed(driver, observation, DT);
});

const physicsOnly = time("stepCar", () => {
  for (let i = 0; i < steps; i++) stepCar(car, DEFAULT_CAR_PARAMS, DT, context);
});

/*
 * The ray fan in isolation, cast exactly as `observe` casts it, so its share of `observe` is known
 * rather than guessed.
 */
const RAY_COUNT = 11;
const RAY_RANGE = 90;
const RAY_HALF_ANGLE = 1.0;
/*
 * Must match `RAY_PROBE_WINDOW` in sense.ts, or this column measures the old window and stops agreeing
 * with the `observe` column beside it.
 */
const PROBE_WINDOW = 8;
const rayOnly = time("ray fan + project", () => {
  for (let i = 0; i < steps; i++) {
    for (let ray = 0; ray < RAY_COUNT; ray++) {
      const t = ray / (RAY_COUNT - 1);
      const angle = (t - 0.5) * 2 * RAY_HALF_ANGLE;
      const dirX = Math.cos(car.heading + angle);
      const dirY = Math.sin(car.heading + angle);
      let travelled = 0;
      while (travelled < RAY_RANGE) {
        travelled += 6;
        const probe = projectToTrackNear(
          track,
          car.x + dirX * travelled,
          car.y + dirY * travelled,
          0,
          PROBE_WINDOW,
        );
        if (!probe.onTrack) break;
      }
    }
  }
});

console.log("");
console.log(`  stages sum to               ${(observeOnly + driveOnly + physicsOnly).toFixed(1).padStart(7)} ms`);
console.log(`  ray fan is ${((rayOnly / observeOnly) * 100).toFixed(0)}% of observe and ` +
  `${((rayOnly / full) * 100).toFixed(0)}% of the whole loop`);
