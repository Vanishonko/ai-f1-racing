import test from "node:test";
import assert from "node:assert/strict";
import { buildCircuitByKey, buildCircuits } from "../src/trackLibrary.ts";
import { pointAtDistance } from "../src/track.ts";
import { createCarState } from "../src/car.ts";
import { createObservation } from "../src/sense.ts";
import { runDriver, runPolicy, DT, DEFAULT_RUN_SECONDS } from "../src/environment.ts";
import {
  createDriver,
  randomGenes,
  PARAMETER_OFFSETS,
  HIDDEN_SIZE,
} from "../src/driver.ts";
import { createRng } from "../src/rng.ts";

const source = (seed: number): (() => number) => {
  const rng = createRng(seed);
  return () => rng.nextFloat();
};

const driverFor = (seed: number) => createDriver(randomGenes(source(seed)), source(seed + 1000));

test("environment: the same genes always score the same", () => {
  /*
   * The basis of the entire training loop. If an evaluation is not reproducible then a
   * training curve is noise and no change can be attributed to anything, which makes the
   * whole exercise unfalsifiable.
   */
  const track = buildCircuitByKey("club")!;
  const genes = randomGenes(source(11));
  const first = runDriver(createDriver(genes, source(1)), track, { seconds: 12 });
  const second = runDriver(createDriver(genes, source(2)), track, { seconds: 12 });

  assert.equal(first.distance, second.distance, "distance must be bit-identical");
  assert.equal(first.fitness, second.fitness, "fitness must be bit-identical");
  assert.equal(first.laps, second.laps);
});

test("environment: a car with no useful driver goes almost nowhere", () => {
  /*
   * The floor of the fitness landscape. An untrained network should not be able to score
   * well by accident, or the search has no gradient to follow. With zero genes every
   * control sits at its neutral value, so the car never touches the throttle.
   */
  const track = buildCircuitByKey("club")!;
  const silent = createDriver(new Float64Array(createDriver(undefined, source(3)).genes.length), source(3));
  const result = runDriver(silent, track, { seconds: 20 });

  assert.ok(
    result.distance < 5,
    `a driver that never asks for throttle covered ${result.distance.toFixed(1)} m; ` +
      `the car should not move on its own`,
  );
  assert.equal(result.laps, 0);
});

test("environment: progress is monotonic and never counts going backwards", () => {
  /*
   * Distance along the centreline is the backbone of fitness, so a car that spins or
   * reverses must not be able to accumulate it. Every result is checked for a negative or
   * non-finite distance across a range of untrained drivers.
   */
  const track = buildCircuitByKey("chicane")!;
  for (let seed = 1; seed <= 6; seed++) {
    const result = runDriver(driverFor(seed), track, { seconds: 15 });
    assert.ok(Number.isFinite(result.distance), `seed ${seed}: distance was ${result.distance}`);
    assert.ok(result.distance >= 0, `seed ${seed}: distance was negative (${result.distance})`);
    assert.ok(result.onTrackFraction >= 0 && result.onTrackFraction <= 1);
    assert.ok(result.meanUtilization >= 0);
    assert.ok(result.lockedFraction >= 0 && result.lockedFraction <= 1);
    assert.ok(result.wheelspinFraction >= 0 && result.wheelspinFraction <= 1);
    assert.ok(Number.isFinite(result.fitness), `seed ${seed}: fitness was ${result.fitness}`);
  }
});

test("environment: every circuit can be evaluated", () => {
  const driver = driverFor(5);
  for (const track of buildCircuits()) {
    const result = runDriver(driver, track, { seconds: 10 });
    assert.ok(Number.isFinite(result.distance), `${track.name}: distance not finite`);
    assert.ok(result.distance >= 0, `${track.name}: negative distance`);
  }
});

test("environment: a driver that asks for full throttle actually moves", () => {
  /*
   * Guards the opposite failure to the "does nothing" test above: a wiring mistake that
   * left the controls disconnected would also produce zero distance, and both tests
   * together distinguish "the search has nowhere to go" from "the throttle does not work".
   *
   * The genes are set so the throttle output is large and positive regardless of input, and
   * the brake output strongly NEGATIVE so that it saturates to zero. A driver holding full
   * throttle and full brake together barely moves, which is correct — the brakes win — and
   * was the first thing this test revealed.
   */
  const track = buildCircuitByKey("club")!;
  const driver = createDriver(undefined, source(9));
  driver.genes.fill(0);
  // Push every hidden unit on, then weight the throttle output strongly positive.
  for (let unit = 0; unit < HIDDEN_SIZE; unit++) {
    driver.genes[PARAMETER_OFFSETS.hiddenBiases + unit] = 5;
  }
  for (let unit = 0; unit < HIDDEN_SIZE; unit++) {
    driver.genes[PARAMETER_OFFSETS.outputWeights + unit] = 2;
  }
  // The brake channel is the second output; drive it to zero.
  for (let unit = 0; unit < HIDDEN_SIZE; unit++) {
    driver.genes[PARAMETER_OFFSETS.outputWeights + HIDDEN_SIZE + unit] = -2;
  }

  const result = runDriver(driver, track, { seconds: 20 });
  assert.ok(
    result.distance > 50,
    `a driver demanding full throttle covered only ${result.distance.toFixed(1)} m in 20 s`,
  );
});

test("environment: the reported step budget matches the requested duration", () => {
  const track = buildCircuitByKey("club")!;
  let steps = 0;
  runDriver(driverFor(2), track, {
    seconds: 5,
    onStep: () => { steps++; },
  });
  assert.equal(steps, Math.round(5 / DT), "the run should step exactly once per timestep");
  assert.equal(DEFAULT_RUN_SECONDS, 90, "the default run length is part of the training cost");
});

test("environment: a snap across the start line is not counted as a step", () => {
  /*
   * `observation.distance` is circular: it runs 0..track.length and snaps back through zero at the
   * start line. Progress used to be accumulated by treating the snap as a step, adding a lap back on
   * when the delta looked large:
   *
   *     if (advanced < -track.length / 2) progress += advanced + track.length;   // forwards: correct
   *     else if (advanced > track.length / 2) progress += advanced - track.length; // backwards: wrong
   *
   * The first branch is right. The second is not: for a car crossing the line BACKWARDS the delta is a
   * large POSITIVE number, and subtracting a lap from it credits the crossing as though the car had
   * driven almost the whole circuit. Measured on a car straddling the line, a single backward crossing
   * added **+3504.7 m** of progress — and a later forward crossing took it back, which is why this
   * survived: the two cancel exactly, so any run ending on the side it started looks right.
   *
   * WHAT THIS FIX DOES AND DOES NOT DO, recorded because it is easy to overclaim. It does not change the
   * score of any driver measured — the lapping elites report 3277 m and 3966 m either way, and a car
   * that spans on the spot reports zero either way. What it removes is a whole lap of progress that
   * exists for as long as the car is on the far side of the line with nothing come to unwind it, which
   * is a state a spinning car spends half of every rotation in. The score of such a car depended on
   * where its run happened to stop. That is still a fault worth not having, but it is a hygiene fix and
   * it is NOT the explanation for a driver that fails to complete a lap.
   */
  const track = buildCircuitByKey("club")!;
  const scratch = {
    car: createCarState(),
    observation: createObservation(),
    controls: { throttle: 0, brake: 0, steer: 0 },
  };

  /*
   * Held a few metres either side of the line, which puts the reported distance at opposite ends of the
   * circular range for two positions that are metres apart. Position is written directly because what is
   * under test is the progress accumulation, not the physics.
   */
  const legs = [8, -8, 0.5];
  let step = 0;
  const result = runPolicy(
    () => {
      const along = legs[Math.min(legs.length - 1, Math.floor(step / 60))]!;
      const point = pointAtDistance(track, along);
      scratch.car.x = point.x;
      scratch.car.y = point.y;
      scratch.car.heading = Math.atan2(point.ty, point.tx);
      scratch.car.vx = 0;
      scratch.car.vy = 0;
      step++;
    },
    track,
    { seconds: 3 },
    scratch,
  );

  assert.ok(Number.isFinite(result.distance), `progress must stay finite, got ${result.distance}`);
  assert.ok(result.distance >= 0, `progress must never be negative, got ${result.distance}`);
  /*
   * The car ends half a metre past the line and has never been more than eight metres from it. A
   * handful of metres is the honest answer; a lap is not.
   */
  assert.ok(
    result.distance < 20,
    `a car held within eight metres of the start line reported ${result.distance.toFixed(0)} m of ` +
      `progress on a ${track.length.toFixed(0)} m circuit; a snap across the line is not a step`,
  );
  assert.equal(result.laps, 0, "and it must not count a lap either");
});
