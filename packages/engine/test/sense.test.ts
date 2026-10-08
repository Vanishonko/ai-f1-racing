import test from "node:test";
import assert from "node:assert/strict";
import { buildCircuitByKey } from "../src/trackLibrary.ts";
import { createCarState, stepCar, DEFAULT_CAR_PARAMS, CLEAN_AIR, type StepContext } from "../src/car.ts";
import {
  createObservation,
  observe,
  OBSERVATION_SIZE,
  RAY_COUNT,
} from "../src/sense.ts";
import { pointAtDistance, type Track } from "../src/track.ts";

const CONTEXT: StepContext = {
  ...CLEAN_AIR,
  surfaceGrip: 1,
  gripNoise: 1,
  dirtyAir: 0,
  brakeScale: 1,
  throttleScale: 1,
};

/** Places a car on the centreline at a distance, facing along the track. */
const placeAt = (track: Track, distance: number) => {
  const car = createCarState();
  const point = pointAtDistance(track, distance);
  car.x = point.x;
  car.y = point.y;
  car.heading = steerHeadingForTest(point.tx, point.ty);
  return car;
};

/** The test needs a heading angle; the engine avoids one internally. */
const steerHeadingForTest = (tx: number, ty: number): number => {
  // Only used to place the car, so a coarse search is fine and keeps the test free of
  // the banned inverse functions.
  let best = 0;
  let bestDot = -Infinity;
  for (let i = 0; i < 4096; i++) {
    const a = (i / 4096) * Math.PI * 2;
    const dot = tx * Math.cos(a) + ty * Math.sin(a);
    if (dot > bestDot) { bestDot = dot; best = a; }
  }
  return best;
};

test("sense: the observation has the declared size", () => {
  const track = buildCircuitByKey("club")!;
  const observation = createObservation();
  assert.equal(observation.values.length, OBSERVATION_SIZE);
  const car = placeAt(track, 100);
  observe(observation, car, track, 0);
  assert.equal(observation.values.length, OBSERVATION_SIZE);
});

test("sense: every input is finite and in a usable range", () => {
  /*
   * An input that can run to thousands, or go NaN, makes an evolutionary search
   * unusable — the network saturates on one feature and the rest contribute nothing. The
   * contract says every input is roughly within [-2, 2], so this checks it holds while
   * the car is actually doing something rather than only at rest.
   */
  const track = buildCircuitByKey("club")!;
  const observation = createObservation();
  const car = placeAt(track, 200);
  let previous = 200;

  for (let tick = 0; tick < 60 * 30; tick++) {
    // Drive hard and steer, so the observation covers cornering and braking.
    car.throttle = tick % 120 < 90 ? 1 : 0;
    car.brake = tick % 120 < 90 ? 0 : 1;
    car.steerCommand = Math.sin(tick / 40) * 0.7;
    stepCar(car, DEFAULT_CAR_PARAMS, 1 / 60, CONTEXT);
    observe(observation, car, track, previous);
    previous = observation.distance;

    for (let i = 0; i < OBSERVATION_SIZE; i++) {
      const value = observation.values[i]!;
      assert.ok(Number.isFinite(value), `input ${i} was ${value} at tick ${tick}`);
      assert.ok(
        Math.abs(value) <= 2,
        `input ${i} was ${value.toFixed(3)}, outside the usable range, at tick ${tick}`,
      );
    }
  }
});

test("sense: on the centreline the car reports itself on the centreline", () => {
  const track = buildCircuitByKey("spa")!;
  const observation = createObservation();
  for (const distance of [0, 500, 2000, 4000, 6500]) {
    const car = placeAt(track, distance);
    observe(observation, car, track, distance);
    assert.ok(
      Math.abs(observation.lateral) < 1,
      `at ${distance} m the lateral offset was ${observation.lateral.toFixed(3)} m`,
    );
    assert.ok(observation.onTrack, `at ${distance} m the car should be on the track`);
    // Facing along the track means the heading error pair should be near (0, 1).
    assert.ok(
      Math.abs(observation.headingErrorSin) < 0.05,
      `at ${distance} m the heading error sine was ${observation.headingErrorSin.toFixed(4)}`,
    );
    assert.ok(
      observation.headingErrorCos > 0.99,
      `at ${distance} m the heading error cosine was ${observation.headingErrorCos.toFixed(4)}`,
    );
  }
});

test("sense: the ray fan sees further down a straight than into a corner", () => {
  /*
   * This is what makes the rays worth having: they describe the shape of the track ahead,
   * so a driver can learn to brake for a corner it can see coming rather than only
   * reacting to what the car is already doing.
   */
  const track = buildCircuitByKey("spa")!;
  const observation = createObservation();

  // Find the straightest and the tightest point on the lap.
  let straightest = 0;
  let tightest = 0;
  let lowestCurvature = Infinity;
  let highestCurvature = 0;
  for (let s = 0; s < track.length; s += 5) {
    const index = Math.min(track.curvature.length - 1, Math.round(s / track.spacing));
    const curvature = Math.abs(track.curvature[index]!);
    if (curvature < lowestCurvature) { lowestCurvature = curvature; straightest = s; }
    if (curvature > highestCurvature) { highestCurvature = curvature; tightest = s; }
  }

  const reachOnStraight = (() => {
    const car = placeAt(track, straightest);
    observe(observation, car, track, straightest);
    return observation.values[RAY_COUNT - 1]!;   // the centre ray's reach, normalized
  })();

  const reachInCorner = (() => {
    const car = placeAt(track, tightest);
    observe(observation, car, track, tightest);
    return observation.values[RAY_COUNT - 1]!;
  })();

  assert.ok(
    reachOnStraight > reachInCorner,
    `the ray should reach further on a straight (${reachOnStraight.toFixed(3)}) than into ` +
      `the tightest corner (${reachInCorner.toFixed(3)})`,
  );
});

test("sense: driving off the track is reported as off the track", () => {
  const track = buildCircuitByKey("club")!;
  const observation = createObservation();
  const car = placeAt(track, 300);
  const point = pointAtDistance(track, 300);
  // Push the car well outside the drivable width, perpendicular to the track.
  car.x = point.x - point.ty * (track.halfWidth * 3);
  car.y = point.y + point.tx * (track.halfWidth * 3);
  observe(observation, car, track, 300);
  assert.equal(observation.onTrack, false, "a car three widths off must report off track");
  assert.ok(
    Math.abs(observation.lateral) > track.halfWidth,
    `lateral offset ${observation.lateral.toFixed(2)} should exceed the half width`,
  );
});
