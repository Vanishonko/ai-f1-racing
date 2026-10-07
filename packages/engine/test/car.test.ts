import test from "node:test";
import assert from "node:assert/strict";
import {
  CLEAN_AIR,
  createCarState,
  DEFAULT_CAR_PARAMS,
  stepCar,
  WHEEL_COUNT,
  WHEEL_FL,
  WHEEL_FR,
  WHEEL_RL,
  WHEEL_RR,
  type CarState,
  type StepContext,
} from "../src/car.ts";

const DT = 1 / 60;
const PARAMS = DEFAULT_CAR_PARAMS;

const speedOf = (s: CarState): number => Math.sqrt(s.vx * s.vx + s.vy * s.vy);

/** Puts a car at a road speed with the wheels rolling at exactly that speed. */
const carAtSpeed = (metersPerSecond: number): CarState => {
  const state = createCarState(0, 0, 0);
  state.vx = metersPerSecond;
  state.omega.fill(metersPerSecond / PARAMS.wheelRadius);
  return state;
};

/** Runs until the car is effectively stopped, returning distance travelled. */
const stopDistance = (
  state: CarState,
  context: StepContext,
  brake = 1,
): { distance: number; seconds: number } => {
  const x0 = state.x;
  let ticks = 0;
  while (Math.abs(state.vx) > 0.3 && ticks < 60 * 120) {
    state.throttle = 0;
    state.brake = brake;
    stepCar(state, PARAMS, DT, context);
    ticks++;
  }
  return { distance: state.x - x0, seconds: ticks * DT };
};

test("car: a full-throttle launch moves the car and stays straight", () => {
  const state = createCarState(0, 0, 0);
  for (let i = 0; i < 60 * 10; i++) {
    state.throttle = 1;
    stepCar(state, PARAMS, DT);
  }

  const speed = speedOf(state);
  assert.ok(speed > 30, `car should be moving briskly after 10 s, got ${speed.toFixed(1)} m/s`);
  // Straight line: essentially no lateral velocity and no yaw.
  assert.ok(Math.abs(state.vy) < 1, `straight-line launch drifted sideways: vy=${state.vy}`);
  assert.ok(Math.abs(state.yawRate) < 0.05, `straight-line launch yawed: ${state.yawRate}`);
  assert.ok(state.x > 100, `car should have covered ground, got ${state.x.toFixed(0)} m`);
});

test("car: wheelspin is real at launch and gone once rolling", () => {
  // The whole reason throttle is analog. Full throttle from rest must out-run the
  // road, and the same request in top gear must not.
  const launching = createCarState(0, 0, 0);
  for (let i = 0; i < 12; i++) {
    launching.throttle = 1;
    stepCar(launching, PARAMS, DT);
  }
  const launchSlip = launching.omega[WHEEL_RL]! * PARAMS.wheelRadius - launching.vx;
  assert.ok(launchSlip > 0.5, `first-gear launch must spin the wheels, slip was ${launchSlip.toFixed(2)}`);

  // Same throttle request at cruising speed in a tall gear.
  const cruising = carAtSpeed(80);
  cruising.gear = 5;
  let peakSlip = 0;
  for (let i = 0; i < 60; i++) {
    cruising.throttle = 1;
    stepCar(cruising, PARAMS, DT);
    const slip = cruising.omega[WHEEL_RL]! * PARAMS.wheelRadius - cruising.vx;
    if (slip > peakSlip) peakSlip = slip;
  }
  assert.ok(
    peakSlip < launchSlip,
    `high-gear throttle must not spin the wheels as hard: ${peakSlip.toFixed(2)} vs ${launchSlip.toFixed(2)}`,
  );
});

test("car: at a standing start with wheelspin, drive force uses the whole budget", () => {
  // Guards the bug where slip normalization put the peak at the wrong point, so a
  // launching car only got ~74% of its grip and struggled to move at all.
  const state = createCarState(0, 0, 0);
  for (let i = 0; i < 30; i++) {
    state.throttle = 1;
    stepCar(state, PARAMS, DT);
  }
  assert.ok(
    state.x > 0.1,
    `a launching car must actually get moving, travelled ${state.x.toFixed(3)} m`,
  );
});

test("car: it comes to a complete stop rather than creeping", () => {
  // Rolling resistance is the only thing coupling a coasting wheel to the road.
  // Without it the car settles at a few tenths of a km/h and never stops, and a
  // weak slip-ratio reference makes it drift BACKWARDS instead.
  const state = carAtSpeed(100 / 3.6);
  stopDistance(state, CLEAN_AIR);

  assert.ok(
    Math.abs(state.vx) < 0.3,
    `car must stop, ended at ${(state.vx * 3.6).toFixed(2)} km/h`,
  );
  assert.ok(
    state.x > 0,
    `car must not drift backwards while stopping, ended at x=${state.x.toFixed(2)}`,
  );
});

test("car: full brake pressure locks the fronts first, then the rears", () => {
  // Load transfer unloads the rear under braking, so with forward brake bias the
  // front is the axle that runs out of grip first. This is the behaviour the whole
  // tire model exists to produce, and it must survive any change to the chassis.
  //
  // Measured by SLIP RATIO rather than by wheel speed. A wheel-speed threshold
  // says the two axles lock on the same tick, because both decelerate hard and
  // reach a slow rotation together; the slip ratio says which one actually passed
  // its grip limit first, which is the thing being asserted.
  const state = carAtSpeed(200 / 3.6);
  let frontLockTick = -1;
  let rearLockTick = -1;

  for (let tick = 0; tick < 60 * 30; tick++) {
    state.throttle = 0;
    state.brake = 1;
    stepCar(state, PARAMS, DT);

    const reference = Math.max(Math.abs(state.vx), 1);
    const slipOf = (wheel: number): number =>
      (state.omega[wheel]! * PARAMS.wheelRadius - state.vx) / reference;

    /*
     * Past the grip peak by a wide margin is a lockup in any practical sense.
     *
     * The test requires actual brake demand, because a driven wheel also slows
     * when the throttle closes: engine braking drags the rear wheels backwards
     * through the driveline, which is negative slip but is not a lockup. Checking
     * slip alone reported the rears locking first, which was simply the engine
     * braking the axle it drives.
     */
    if (state.brake < 0.5) continue;
    const lockThreshold = -0.35;
    if (frontLockTick < 0 && slipOf(WHEEL_FL) < lockThreshold && slipOf(WHEEL_FR) < lockThreshold) {
      frontLockTick = tick;
    }
    if (rearLockTick < 0 && slipOf(WHEEL_RL) < lockThreshold && slipOf(WHEEL_RR) < lockThreshold) {
      rearLockTick = tick;
    }
    if (frontLockTick >= 0 && rearLockTick >= 0) break;
  }

  assert.ok(frontLockTick >= 0, "the fronts must lock under full pressure");
  assert.ok(
    rearLockTick < 0 || frontLockTick <= rearLockTick,
    `fronts must lock no later than the rears: front tick ${frontLockTick}, rear ${rearLockTick}`,
  );

  // The two axles should lock within a short window of each other. A brake bias
  // far from the load transfer balance makes one axle saturate long before the
  // other and wastes the other axle's grip, so this also guards the setup.
  if (rearLockTick >= 0) {
    assert.ok(
      rearLockTick - frontLockTick <= 20,
      `axles lock too far apart, suggesting a badly balanced brake bias: ` +
        `front ${frontLockTick}, rear ${rearLockTick}`,
    );
  }
});

test("car: a locked wheel is genuinely slower than one held at the grip peak", () => {
  // THE property that makes the sim worth racing, and the one that force-space
  // tests cannot see. An earlier version passed every single-force assertion
  // while making a pedal slam strictly optimal: a locked wheel held a steady
  // force, while any modulating controller necessarily spent time at low slip
  // making almost none, so locking WON over a whole stop.
  //
  // The reference here pins the front wheels exactly at peak slip each tick. That
  // is not achievable with a pedal — a real controller would lose something to
  // its own response lag — so the gap measured is a LOWER bound on the true cost.
  const SPEED = 200 / 3.6;

  const ideal = carAtSpeed(SPEED);
  const idealContext: StepContext = { ...CLEAN_AIR, brakeScale: 1 };
  let idealTicks = 0;
  while (Math.abs(ideal.vx) > 0.3 && idealTicks < 60 * 120) {
    ideal.throttle = 0;
    ideal.brake = 1;
    stepCar(ideal, PARAMS, DT, idealContext);
    const targetOmega = (ideal.vx * (1 - PARAMS.tire.slipRatioPeak)) / PARAMS.wheelRadius;
    ideal.omega[WHEEL_FL] = targetOmega;
    ideal.omega[WHEEL_FR] = targetOmega;
    idealTicks++;
  }

  const locked = carAtSpeed(SPEED);
  const lockedResult = stopDistance(locked, { ...CLEAN_AIR, brakeScale: 1 });
  const idealDistance = ideal.x;

  assert.ok(Number.isFinite(idealDistance) && idealDistance > 0, "ideal stop must terminate");
  assert.ok(
    lockedResult.distance > idealDistance * 1.08,
    `locking must cost at least 8% more distance: ${lockedResult.distance.toFixed(1)}m locked ` +
      `vs ${idealDistance.toFixed(1)}m holding the peak`,
  );
});

test("car: brake pressure is a real analog decision, not a switch", () => {
  // Sweeping pressure must produce meaningfully different stopping distances.
  // If full pressure were always best, the AI would have nothing to learn about
  // braking and every corner would be decided by grip alone.
  const distances: number[] = [];
  for (const brake of [0.3, 0.5, 0.7, 1.0]) {
    const state = carAtSpeed(150 / 3.6);
    const result = stopDistance(state, { ...CLEAN_AIR, brakeScale: 1 }, brake);
    distances.push(result.distance);
  }
  const spread = Math.max(...distances) / Math.min(...distances);
  assert.ok(
    spread > 1.25,
    `brake pressure must matter: spread was only ${spread.toFixed(3)} across ${distances.map((d) => d.toFixed(0)).join(", ")} m`,
  );
  // And heavier braking should be shorter, at least up to the limit.
  assert.ok(
    distances[distances.length - 1]! <= distances[0]!,
    `full pressure should out-stop light pressure: ${distances.join(", ")}`,
  );
});

test("car: determinism — identical inputs give a bit-identical result", () => {
  // Guards the contract the whole architecture rests on: replays reproduce from
  // `(seed, genome)`, which is what keeps checkpoints small and lets the trainer
  // and the viewer share one engine.
  const run = (): string => {
    const state = carAtSpeed(60);
    const trace: number[] = [];
    for (let tick = 0; tick < 600; tick++) {
      state.throttle = 0.8;
      state.brake = 0;
      state.steerCommand = 0.3;
      stepCar(state, PARAMS, DT);
      if (tick % 50 === 0) {
        trace.push(state.x, state.y, state.heading, state.vx, state.vy, state.yawRate);
      }
    }
    return trace.join(",");
  };

  assert.equal(run(), run(), "two identical runs must produce identical traces");
});

test("car: no state ever goes non-finite, including under abuse", () => {
  // Fuzz the inputs hard. Any NaN here would silently poison a training run
  // rather than failing loudly, so it is asserted rather than assumed.
  const state = carAtSpeed(40);
  for (let tick = 0; tick < 60 * 60; tick++) {
    // Deterministic but erratic input sequence.
    const phase = tick % 240;
    state.throttle = phase < 120 ? 1 : 0;
    state.brake = phase >= 120 && phase < 160 ? 1 : 0;
    state.steerCommand = ((tick * 37) % 200) / 100 - 1;
    stepCar(state, PARAMS, DT);

    for (const value of [state.x, state.y, state.heading, state.vx, state.vy, state.yawRate, state.rpm]) {
      assert.ok(Number.isFinite(value), `non-finite state at tick ${tick}`);
    }
    for (let w = 0; w < WHEEL_COUNT; w++) {
      assert.ok(Number.isFinite(state.omega[w]!), `non-finite omega at tick ${tick}`);
      assert.ok(state.normalLoad[w]! >= 0, `negative wheel load at tick ${tick}`);
      assert.ok(state.wear[w]! >= 0 && state.wear[w]! <= 1, `wear out of range at tick ${tick}`);
    }
    assert.ok(state.gear >= 0 && state.gear < PARAMS.gearbox.ratios.length, "gear out of range");
  }
});

test("car: tire wear degrades grip and eventually matters", () => {
  const fresh = carAtSpeed(60);
  const worn = carAtSpeed(60);
  worn.wear.fill(1);

  let freshLateral = 0;
  let wornLateral = 0;
  for (let tick = 0; tick < 60 * 3; tick++) {
    fresh.steerCommand = 1;
    worn.steerCommand = 1;
    fresh.throttle = 1;
    worn.throttle = 1;
    stepCar(fresh, PARAMS, DT);
    stepCar(worn, PARAMS, DT);
    freshLateral = Math.max(freshLateral, Math.abs(fresh.lastLatAccel));
    wornLateral = Math.max(wornLateral, Math.abs(worn.lastLatAccel));
  }

  assert.ok(
    wornLateral < freshLateral,
    `worn tires must corner less hard: ${wornLateral.toFixed(2)} vs ${freshLateral.toFixed(2)} m/s^2`,
  );
});

test("car: a standing start is smooth — no gear hunting, no runaway wheelspin", () => {
  // A regression test for a cluster of real bugs, all of which are easy to
  // reintroduce and all of which were found by logging a launch rather than by
  // reasoning about one:
  //
  //   - gear hunting, where the box shifted 2 -> 1 -> 2 because the RPM the shift
  //     logic saw during wheelspin was not a measure of road speed;
  //   - a runaway wheel, which happened when engine speed was taken from road
  //     speed so the limiter never fired;
  //   - tire wear accumulating per SUBSTEP rather than per second, which made the
  //     tires reach 100% wear six seconds into a standing start.
  const state = createCarState(0, 0, 0);
  const speeds: number[] = [];
  const gears: number[] = [];
  let shifts = 0;
  let previousGear = state.gear;

  for (let tick = 0; tick < 60 * 12; tick++) {
    state.throttle = 1;
    state.brake = 0;
    stepCar(state, PARAMS, DT);
    speeds.push(Math.sqrt(state.vx * state.vx + state.vy * state.vy));
    gears.push(state.gear);
    if (state.gear !== previousGear) shifts++;
    previousGear = state.gear;

    assert.ok(
      state.rpm <= PARAMS.engine.redlineRpm * 1.02,
      `engine must respect the limiter, saw ${state.rpm.toFixed(0)} rpm at tick ${tick}`,
    );
    assert.ok(Number.isFinite(state.omega[WHEEL_RL]!), "wheel speed must stay finite");
    for (let w = 0; w < WHEEL_COUNT; w++) {
      assert.ok(
        state.wear[w]! < 0.5,
        `tires must not be destroyed 12 s into a start, wear ${state.wear[w]!.toFixed(3)}`,
      );
    }
  }

  // Speed must rise essentially monotonically. A dip means the drivetrain lost
  // drive torque part-way through the launch.
  for (let i = 1; i < speeds.length; i++) {
    assert.ok(
      speeds[i]! > speeds[i - 1]! - 0.5,
      `speed must not collapse mid-launch: ${speeds[i - 1]!.toFixed(2)} -> ${speeds[i]!.toFixed(2)} m/s`,
    );
  }

  // A twelve second launch should not need many shifts, and must never thrash.
  assert.ok(shifts <= 8, `too many gear changes in a launch: ${shifts}`);
  assert.ok(speeds[speeds.length - 1]! > 35, `should be quick after 12 s, got ${speeds[speeds.length - 1]!.toFixed(1)} m/s`);
});
