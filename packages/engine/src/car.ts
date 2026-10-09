/**
 * Chassis, four-wheel tire integration, and the per-tick physics step.
 *
 * The car is a rigid body with per-wheel rotational state. Forces come from the
 * tire model, so everything the drivers must learn — locking the fronts and
 * ploughing straight on, spinning the rears on corner exit, getting loose over a
 * kerb — is emergent rather than scripted.
 *
 * CONVENTIONS, applied consistently and worth stating once:
 *   - World: x right, y up. Heading 0 points along +x.
 *   - Body: x forward, y LEFT. This is an ISO 8855 right-handed frame.
 *   - Yaw rate, steering angle, and heading are all POSITIVE counter-clockwise,
 *     so a positive steering input turns the car left.
 *   - Positive slip ratio drives the car forward. Positive slip angle means the
 *     contact patch slides toward the wheel's +y, so the tire pushes back in -y.
 *     `tireForces` already returns that convention.
 *
 * Deterministic: pure arithmetic plus `sqrt`, the baked slip-curve table, and the
 * baked angle tables. No transcendental reaches the hot path.
 */

import { DEFAULT_TIRE, tireForces, wheelNormalLoads, type TireParams } from "./tire.ts";
import {
  DEFAULT_DIFF,
  DEFAULT_ENGINE,
  DEFAULT_GEARBOX,
  buildShiftSchedule,
  clutchEngagement,
  rawRpmFor,
  engineTorque,
  nextGear,
  rpmFor,
  SHIFT_DURATION,
  type DifferentialSpec,
  type EngineSpec,
  type GearboxSpec,
} from "./powertrain.ts";
import { clamp, len } from "./math2d.ts";
import { headingBasis, MAX_STEER_ANGLE, steerCos, steerSin } from "./steerLut.ts";

export const WHEEL_FL = 0;
export const WHEEL_FR = 1;
export const WHEEL_RL = 2;
export const WHEEL_RR = 3;
export const WHEEL_COUNT = 4;

/**
 * Substeps per tick for the wheel dynamics.
 *
 * The tire's initial slip stiffness is enormous — around 86,000 N per unit slip
 * ratio — against a wheel inertia of a couple of kg m^2, which makes the
 * wheel-road coupling a genuinely stiff system with a time constant of a few
 * milliseconds. An explicit update at 60 Hz is far too coarse for that and
 * produces a visible oscillation in wheel speed on a hard launch.
 *
 * Passing the substep count as an argument lets the trainer and the viewer share
 * one implementation, and lets a future adaptive caller raise it without forking
 * the physics.
 */
const DEFAULT_WHEEL_SUBSTEPS = 16;

/**
 * Below this road speed the slip-ratio denominator is clamped, so a stationary car
 * does not divide by zero. Genuine slip at walking pace is not interesting.
 */
const MIN_REFERENCE_SPEED = 1.0;

/** Grip multiplier at maximum tire wear. Worn tires lose about a third. */
const WORN_GRIP = 0.65;

/**
 * Tire wear accumulation rates, PER SECOND.
 *
 * Both are multiplied by `substep`, which is a duration, so the total wear per
 * tick is independent of the substep count.
 *
 * That independence is the whole point and it was missing. The previous version
 * multiplied by a factor that stood in for "per tick" and then also by `substep`,
 * which made wear accumulate `wheelSubsteps` times faster than intended. At 16
 * substeps the tires reached 100% wear about six seconds into a standing start,
 * grip collapsed to 65%, and the car began spinning its drive wheels, losing
 * speed and oscillating its wheel speeds. A subtle unit error, and the resulting
 * behaviour looked exactly like a physics bug rather than a bookkeeping one.
 */
const WEAR_RATE_IDLE = 0.0012;
const WEAR_RATE_SLIDING = 0.024;

/**
 * Rolling-resistance coefficient, as a fraction of the wheel's normal load.
 *
 * Small, but not optional. Without it nothing couples a coasting wheel to the
 * road, so the wheel keeps its angular momentum forever and the car never quite
 * stops — it settles at a few tenths of a km/h instead of coming to rest. That is
 * both unphysical and a nuisance, since a race needs cars to be able to stop.
 *
 * It also gives lift-and-coast and engine-braking behaviour something physical to
 * stand on, rather than having the car coast at constant speed.
 */
const ROLLING_RESISTANCE = 0.014;

/*
 * A `STOP_SPEED` threshold used to live here, snapping the car to a halt below
 * 0.35 m/s to stop it creeping backwards in neutral. It is gone because the causes of
 * that creep were found and fixed properly: the idle torque was reaching the road,
 * engine braking could push a stationary car backwards, and the wheel-derived engine
 * speed was clamped to idle so the clutch never knew the car had stopped. See
 * `clutchEngagement` in powertrain.ts and the `rawRpmFor` note below.
 *
 * Do not reintroduce a snap-to-stop. It hides the symptom and breaks the ability to
 * creep, which a driver needs at walking pace in the pit lane.
 */

/**
 * Cornering acceleration the front tires can supply, in metres per second squared.
 *
 * Used only to decide how much steering authority is useful at a given speed. Deliberately a little
 * below the true limit so the ceiling is reached slightly before the tires are, which leaves a driver
 * a margin to feel rather than a cliff to fall off.
 */
const FRONT_LATERAL_LIMIT = 15;

/**
 * The fraction of full lock that is worth having at a given speed.
 *
 * From `R = wheelbase / tan(angle)` and the requirement `R >= v^2 / a`, the largest useful angle
 * satisfies `tan(angle) <= wheelbase * a / v^2`. Closed form, evaluated once per tick, written as
 * arithmetic so it stays on the right side of the determinism contract.
 *
 * `tan(MAX_STEER_ANGLE)` is a constant of the car, so the comparison is against a value computed once
 * rather than per tick.
 */
const steeringCeiling = (speed: number, wheelbase: number): number => {
  const bound = (wheelbase * FRONT_LATERAL_LIMIT) / (speed * speed);
  const maxTangent = TAN_MAX_STEER;
  if (bound >= maxTangent) return 1;
  return bound / maxTangent;
};

/**
 * The tangent of full lock, written as a literal.
 *
 * Verified against `Math.tan(MAX_STEER_ANGLE)` by a test, because it was first typed WRONG — off in
 * the seventh decimal — and a mistyped constant that is only ever used in a ratio is exactly the kind
 * of thing that never shows up as a symptom. If `MAX_STEER_ANGLE` changes, this must change with it,
 * and the test is what will say so.
 *
 * A literal rather than a call, because `Math.tan` is not bit-identical across engines and the
 * determinism linter rightly rejects it in the simulation core. It is the tangent of
 * `MAX_STEER_ANGLE` and nothing else — if that constant changes, this must change with it, which is
 * why the derivation is written down rather than the number simply appearing.
 */
export const TAN_MAX_STEER = 0.613105213288136;

export interface CarParams {
  mass: number;
  /** Yaw moment of inertia [kg m^2]. */
  inertia: number;
  wheelbase: number;
  /** Distance from the CG to the front axle [m]. */
  cgToFront: number;
  /** Distance from the CG to the rear axle [m]. */
  cgToRear: number;
  trackFront: number;
  trackRear: number;
  cgHeight: number;
  wheelRadius: number;
  wheelInertia: number;
  /** Static fraction of weight on the front axle, 0..1. */
  weightDistFront: number;
  /** Fraction of total brake torque sent to the front axle, 0..1. */
  brakeBiasFront: number;
  /** Maximum total brake torque across all four wheels [N m]. */
  maxBrakeTorque: number;
  engine: EngineSpec;
  gearbox: GearboxSpec;
  differential: DifferentialSpec;
  tire: TireParams;
  /** Front downforce [N] at 50 m/s; scales with speed squared. */
  downforceFront: number;
  downforceRear: number;
  /**
   * Effective drag area, `Cd * A` [m^2]. Multiplied by air density and speed
   * squared to give drag force.
   *
   * Without this the car accelerated without limit — it reached 441 km/h on a
   * 20 second run, which made braking distances meaningless and let it out-brake
   * any corner. Top speed has to be a real limit for corner entry to be a
   * decision.
   */
  dragArea: number;
}

export const DEFAULT_CAR_PARAMS: CarParams = (() => {
  const mass = 798;
  const wheelbase = 3.6;
  const weightDistFront = 0.45;
  return {
    mass,
    inertia: mass * 1.1,
    wheelbase,
    cgToFront: wheelbase * (1 - weightDistFront),
    cgToRear: wheelbase * weightDistFront,
    trackFront: 1.6,
    trackRear: 1.55,
    cgHeight: 0.3,
    wheelRadius: 0.33,
    wheelInertia: 1.1,
    weightDistFront,
    brakeBiasFront: 0.82,
    maxBrakeTorque: 6200,
    engine: DEFAULT_ENGINE,
    gearbox: DEFAULT_GEARBOX,
    differential: DEFAULT_DIFF,
    tire: DEFAULT_TIRE,
    downforceFront: 1900,
    downforceRear: 2300,
    // Tuned for a terminal velocity near 315 km/h, which is roughly right for a
    // high-downforce single-seater. Slightly more drag is needed than a bare
    // Cd*A calculation suggests because the tire model's own rolling behaviour
    // does not drain energy here.
    dragArea: 1.1,
  };
})();

export interface CarState {
  x: number;
  y: number;
  heading: number;
  /** Body-frame longitudinal velocity [m/s]. */
  vx: number;
  /** Body-frame lateral velocity [m/s], positive to the left. */
  vy: number;
  yawRate: number;

  /** Road-wheel angular velocity per wheel [rad/s]. */
  omega: Float64Array;
  /** Steering angle currently achieved [rad], rate limited toward the command. */
  steerAngle: number;
  /** Normal load per wheel [N] from the current tick. */
  normalLoad: Float64Array;
  /** Tire force as a fraction of the friction budget, per wheel. */
  utilization: Float64Array;
  /** 1 when a wheel is locked or spinning past its slip peak. */
  saturated: Uint8Array;
  /** 0..1 tire wear per wheel. */
  wear: Float64Array;

  gear: number;
  rpm: number;
  /** Time left in the current gearshift [s]; drive torque is cut while positive. */
  shiftTimer: number;

  /** Driver inputs: throttle 0..1, brake 0..1, steer -1..1 with -1 full left. */
  throttle: number;
  brake: number;
  steerCommand: number;

  /** Distance travelled since spawn [m], for grip-noise sampling and telemetry. */
  distance: number;
  /** Accumulated seconds with either front locked. */
  frontLockTime: number;
  /** Accumulated seconds with a driven wheel spinning. */
  wheelspinTime: number;
  /** Accumulated seconds with any wheel saturated, for telemetry. */
  saturatedTime: number;

  /** Measured acceleration from the previous tick, used for load transfer. */
  lastLongAccel: number;
  lastLatAccel: number;
}

export const createCarState = (x = 0, y = 0, heading = 0): CarState => ({
  x,
  y,
  heading,
  vx: 0,
  vy: 0,
  yawRate: 0,
  omega: new Float64Array(WHEEL_COUNT),
  steerAngle: 0,
  normalLoad: new Float64Array(WHEEL_COUNT),
  utilization: new Float64Array(WHEEL_COUNT),
  saturated: new Uint8Array(WHEEL_COUNT),
  wear: new Float64Array(WHEEL_COUNT),
  /*
   * Gear index ZERO IS FIRST GEAR — there is no neutral in the ratios array, so a
   * car left at index 0 is in first with the clutch engaged, which is correct for a
   * car sitting on the grid. It also has to be explicit: leaving it at 0 while
   * treating 0 as neutral made the car unable to pull away at all.
   */
  gear: 1,
  rpm: DEFAULT_ENGINE.idleRpm,
  shiftTimer: 0,
  throttle: 0,
  brake: 0,
  steerCommand: 0,
  distance: 0,
  frontLockTime: 0,
  wheelspinTime: 0,
  saturatedTime: 0,
  lastLongAccel: 0,
  lastLatAccel: 0,
});

/** Aerodynamic downforce [N] at a given speed, scaling with speed squared. */
const downforceAt = (speed: number, valueAt50: number): number => {
  const ratio = speed / 50;
  return valueAt50 * ratio * ratio;
};

/**
 * Fills in the per-wheel normal loads for this tick.
 *
 * Delegates to `wheelNormalLoads` in the tire module, which is the single source of
 * truth for static weight, downforce and weight transfer in both axes. This used to be
 * a second implementation living here, which meant the model the tests exercised and
 * the model the car actually ran could drift apart without anything noticing.
 */
const applyNormalLoads = (
  state: CarState,
  params: CarParams,
  longAccel: number,
  latAccel: number,
): void => {
  const speed = len(state.vx, state.vy);
  const downforce =
    downforceAt(speed, params.downforceFront) + downforceAt(speed, params.downforceRear);

  const loads = wheelNormalLoads(
    params.mass,
    9.81,
    params.weightDistFront,
    params.wheelbase,
    params.cgHeight,
    longAccel,
    latAccel,
    params.trackFront,
    params.trackRear,
    downforce,
  );

  state.normalLoad[WHEEL_FL] = loads.fl;
  state.normalLoad[WHEEL_FR] = loads.fr;
  state.normalLoad[WHEEL_RL] = loads.rl;
  state.normalLoad[WHEEL_RR] = loads.rr;
};

export interface StepContext {
  /** Grip multiplier for the surface under the car, 1.0 on asphalt. */
  surfaceGrip: number;
  /** Deterministic grip variation from track position, near 1. */
  gripNoise: number;
  /** Fraction of downforce lost to dirty air, 0 in clean air. */
  dirtyAir: number;
  /**
   * Per-tick brake-pressure scale, 0..1, multiplying the driver's brake demand.
   *
   * This exists so brake pressure can be MODULATED within a braking event, which
   * is what makes slip management a skill. A car with no ABS cannot simply hold
   * full pressure and stop fastest: on these tires maximum deceleration happens
   * at a slip ratio near 0.11, while full pressure drives the wheels to a slip
   * ratio of -1 where about 86% of the peak force is available.
   *
   * Modelling it as a separate input also means the evolutionary trainer can
   * discover threshold braking and lift-off on its own, rather than having it
   * handed to the population as an assumption baked into the brake pedal.
   */
  brakeScale: number;
  /**
   * Per-tick throttle scale, 0..1, multiplying the driver's throttle demand.
   *
   * Exists so a driver can feather the power rather than only asking for all of it
   * or none. A standing start is the clearest case: full throttle in first gear
   * spins the rear wheels at three times road speed, and the tire model's fold-back
   * means a spinning wheel makes LESS forward force than one just past its slip
   * peak. The fastest launch is therefore not full throttle, and a policy needs a
   * way to express a partial one to discover that.
   *
   * It also gives the trainer somewhere to put traction control, engine-braking
   * balance on corner entry, and lift-and-coast, without those becoming hardcoded
   * in the physics.
   */
  throttleScale: number;
}

export const CLEAN_AIR: StepContext = {
  surfaceGrip: 1,
  gripNoise: 1,
  dirtyAir: 0,
  brakeScale: 1,
  throttleScale: 1,
};

const STEER_RATE = 6.0; // rad/s, roughly a fast hand movement

/**
 * The shift schedule, built once from the default engine and gearbox.
 *
 * Built at module load because it depends only on the torque curve and the gear
 * ratios, neither of which changes at runtime. A car with different hardware
 * builds its own; see `buildShiftSchedule`.
 */
const SHIFT_SCHEDULE = buildShiftSchedule(DEFAULT_ENGINE, DEFAULT_GEARBOX);

/**
 * Advances one car by `dt` seconds, mutating `state`.
 *
 * Per tick: gearbox, steering actuator, load transfer, then wheel dynamics
 * (substepped), then chassis and world integration. Load transfer uses the
 * PREVIOUS tick's acceleration; the one-tick lag is deliberate, since solving
 * loads and forces simultaneously would need an inner iteration for no visible
 * gain at 60 Hz, and this way the result is deterministic.
 */
export const stepCar = (
  state: CarState,
  params: CarParams = DEFAULT_CAR_PARAMS,
  dt = 1 / 60,
  context: StepContext = CLEAN_AIR,
  wheelSubsteps = DEFAULT_WHEEL_SUBSTEPS,
): void => {
  // --- gearbox and engine ---
  //
  // Engine speed follows the DRIVEN WHEELS, which is what the gearbox physically
  // sees whenever the clutch is engaged. Road speed was tried and is wrong: the
  // engine then goes blind to wheelspin, so a spinning wheel never reaches the
  // limiter, the fuel cut never fires, and the wheel spins up without bound. In
  // testing the car reached 252 km/h and then decelerated back to 195 while the
  // drive wheels kept spinning at full throttle.
  //
  // Taking the maximum of wheel and road speed was also tried, and made the car
  // shift down a gear at 83 km/h while revving past its limiter, because wheel
  // speed and road speed were feeding different parts of the shift logic.
  //
  // With a wheel-derived engine speed the whole thing is self-regulating, and the
  // reason is the tire model rather than any limiter: as slip grows the tire's
  // longitudinal force folds away, so the wheel accelerates into an equilibrium
  // near 60-70% slip instead of running away. The feedback is physical.
  const gearRatio = params.gearbox.ratios[state.gear] ?? params.gearbox.ratios[0]!;
  const drivenOmega = (state.omega[WHEEL_RL]! + state.omega[WHEEL_RR]!) * 0.5;
  const rawRpm = rpmFor(drivenOmega, gearRatio, params.gearbox.finalDrive, params.engine);
  // Reported engine speed is clipped at the limiter. The physical speed can sit a
  // few percent above it because the fuel cut zeroes torque while the wheel still
  // has rotational momentum to spend, and a real rev counter does not display
  // past its stop either.
  state.rpm = rawRpm < params.engine.redlineRpm ? rawRpm : params.engine.redlineRpm;

  /**
   * The RPM the engine would be turning if the tires were gripping, from road
   * speed alone.
   *
   * The GEARBOX decides from this rather than from actual engine speed, and the
   * distinction matters whenever the wheels are sliding. During wheelspin the
   * wheels turn several times faster than the car is moving, so engine speed is
   * not a measure of road speed at all — in testing the box shifted down at
   * 83 km/h because the spinning wheel made a lower gear look revvable when it
   * would in fact have gone straight past the limiter.
   *
   * The ENGINE still uses actual speed for torque, power delivery and the rev
   * limiter, which is what keeps the feedback physical. Only the gear choice is
   * taken from the car's true speed.
   */
  const rollingRpm = rawRpmFor(state.vx / params.wheelRadius, gearRatio, params.gearbox.finalDrive);

  // Gear selection. A shift takes time, so the drive torque is cut for its
  // duration and no further shift is considered until it completes.
  if (state.shiftTimer > 0) {
    state.shiftTimer = state.shiftTimer > dt ? state.shiftTimer - dt : 0;
  } else {
    const wanted = nextGear(
      state.gear,
      rollingRpm,
      state.throttle,
      params.gearbox,
      SHIFT_SCHEDULE,
      params.engine.redlineRpm,
    );
    if (wanted !== state.gear) {
      state.gear = wanted;
      state.shiftTimer = SHIFT_DURATION;
    }
  }

  /*
   * Drive torque at the crank, cut while the gear is changing and scaled by how far
   * the clutch is engaged.
   *
   * The clutch term is what stops the car driving itself BACKWARDS with no controls:
   * engine braking is real, but at a standstill the clutch is slipping, so almost
   * none of it reaches the road. See `clutchEngagement`.
   */
  const throttleDemand = clamp(state.throttle, 0, 1) * clamp(context.throttleScale, 0, 1);
  const clutch = clutchEngagement(rollingRpm, params.engine);
  let engineOut =
    engineTorque(state.rpm, throttleDemand, params.engine) *
    (state.shiftTimer > 0 ? 0 : 1) *
    clutch;

  /*
   * ENGINE BRAKING CANNOT DRIVE THE CAR BACKWARDS.
   *
   * A slipping clutch transmits torque in both directions, which is fine for the
   * engine driving the wheels but wrong for the reverse: a stationary car cannot be
   * pushed backwards by its own engine braking, because there is nothing turning the
   * engine to produce that drag in the first place. Leaving it in produced a slow
   * reverse creep of about 0.15 m/s^2 that never quite stopped.
   *
   * Below roughly idle in wheel terms the drivetrain therefore transmits DRIVE only,
   * and drag is discarded. Above it the normal model applies, so lifting off at speed
   * still slows the car the way engine braking should.
   */
  if (engineOut < 0 && rollingRpm < params.engine.idleRpm * 0.75) engineOut = 0;

  /*
   * STEERING AUTHORITY FALLS WITH SPEED, because at speed there is nothing to steer with.
   *
   * This was the cause of the car being undriveable, and it took a long time to see because the
   * symptom looked like a tire problem. Full lock is 0.55 radians of road-wheel angle, which
   * geometrically means a 5.7 metre turning radius — so commanding it at 140 km/h demands TWENTY-SEVEN
   * GEE of cornering force. No tire has ever made 27 g. The tires therefore saturate every time a
   * large input is asked for, and a saturated car does not come back.
   *
   * Measured before this: a smooth speed-holding driver spun at EVERY steering input above 80 km/h,
   * and at 200 km/h a steering input of 0.05 — five per cent of lock — was enough. That is not a
   * driving problem. There was no input small enough to be safe at speed.
   *
   * The limit is derived from the physics rather than tuned: the front tires can supply about
   * `lateralLimit` of acceleration, and a steady turn at speed v needs `v^2 / R`. Asking for more is
   * asking for grip that does not exist, so the maximum useful angle is the one where those are equal.
   * Understeer at the limit is a real and useful behaviour; an instant spin is not.
   *
   * Real cars have exactly this property — the steering is slower at speed, whether by ratio, by
   * power assistance or simply because a driver cannot hold lock — and the effect is that the fastest
   * way through a corner is a measured input rather than a binary one.
   */
  const speed = Math.sqrt(state.vx * state.vx + state.vy * state.vy);
  const steerCeiling = steeringCeiling(speed, params.wheelbase) * MAX_STEER_ANGLE;
  const steerTarget = clamp(state.steerCommand, -1, 1) * steerCeiling;
  const maxSteerDelta = STEER_RATE * dt;
  state.steerAngle += clamp(steerTarget - state.steerAngle, -maxSteerDelta, maxSteerDelta);

  // --- load transfer from the previous tick's acceleration ---
  applyNormalLoads(state, params, state.lastLongAccel, state.lastLatAccel);

  /**
   * Aerodynamic drag, applied per substep alongside the tire forces so it scales
   * correctly with the substep and so the load transfer on the next tick sees the
   * net acceleration rather than only the tractive one.
   *
   * Drag acts along the velocity vector, which is why it is split into body-frame
   * components rather than applied purely longitudinally: at a slip angle the car
   * is genuinely being dragged sideways too.
   */
  const AIR_DENSITY = 1.225;
  const speedForDrag = len(state.vx, state.vy);
  const dragMagnitude = 0.5 * AIR_DENSITY * params.dragArea * speedForDrag * speedForDrag;
  const dragLong = speedForDrag > 1e-6 ? (-dragMagnitude * state.vx) / speedForDrag : 0;
  const dragLat = speedForDrag > 1e-6 ? (-dragMagnitude * state.vy) / speedForDrag : 0;

  // --- wheel dynamics, substepped ---
  const substep = dt / wheelSubsteps;
  const grip = context.surfaceGrip * context.gripNoise;
  const axleTorque = engineOut * gearRatio * params.gearbox.finalDrive;
  const diff = params.differential;
  // Brake torque is the driver's demand scaled by the per-tick pressure control,
  // which is what allows a braking event to be modulated rather than merely
  // slammed. See `StepContext.brakeScale`.
  const brakeTotal =
    clamp(state.brake, 0, 1) * clamp(context.brakeScale, 0, 1) * params.maxBrakeTorque;
  const frontBrakeAxle = brakeTotal * params.brakeBiasFront;
  const rearBrakeAxle = brakeTotal * (1 - params.brakeBiasFront);

  const cosD = steerCos(state.steerAngle);
  const sinD = steerSin(state.steerAngle);

  let sumLongAccel = 0;
  let sumLatAccel = 0;
  let sumYawAccel = 0;

  for (let step = 0; step < wheelSubsteps; step++) {
    // --- differential ---
    let torqueRL = axleTorque * 0.5;
    let torqueRR = axleTorque * 0.5;
    if (diff.lock > 0 && axleTorque !== 0) {
      const speedDifference = state.omega[WHEEL_RR]! - state.omega[WHEEL_RL]!;
      const authority = diff.lock * Math.abs(axleTorque) * 0.5;
      const correction = clamp(speedDifference * diff.lock * 200, -authority, authority);
      torqueRL -= correction;
      torqueRR += correction;
    }

    let stepLong = 0;
    let stepLat = 0;
    let stepYawMoment = 0;

    for (let wheel = 0; wheel < WHEEL_COUNT; wheel++) {
      const isFront = wheel === WHEEL_FL || wheel === WHEEL_FR;
      const Fz = Math.max(0, state.normalLoad[wheel]!);

      // Body to wheel is a rotation by -steering: [[c, s], [-s, c]].
      const c = isFront ? cosD : 1;
      const s = isFront ? sinD : 0;

      const cgOffset = isFront ? params.cgToFront : -params.cgToRear;
      const vxPatch = state.vx;
      // Lateral velocity of this contact patch: body lateral velocity plus the
      // component contributed by yawing about the CG.
      const vyPatch = state.vy + state.yawRate * cgOffset;

      const vxW = vxPatch * c + vyPatch * s;
      const vyW = -vxPatch * s + vyPatch * c;

      // --- slip ---
      const reference = Math.abs(vxW) < MIN_REFERENCE_SPEED ? MIN_REFERENCE_SPEED : Math.abs(vxW);
      const wheelSpeed = state.omega[wheel]! * params.wheelRadius;
      const slipRatio = (wheelSpeed - vxW) / reference;
      // Velocity ratio rather than an angle, which avoids `atan2` entirely. For
      // the small angles that matter here the two agree to well under a percent.
      const slipAngle = vyW / reference;

      const wear = state.wear[wheel]!;
      const wearGrip = 1 - wear * (1 - WORN_GRIP);

      const force = tireForces(
        Fz,
        slipRatio,
        slipAngle,
        grip * wearGrip,
        params.tire,
        state.omega[wheel]!,
      );

      state.utilization[wheel] = force.utilization;
      state.saturated[wheel] = force.utilization > 0.99 ? 1 : 0;

      // --- wheel frame back to body frame ---
      const fxBody = force.fx * c - force.fy * s;
      const fyBody = force.fx * s + force.fy * c;

      stepLong += fxBody;
      stepLat += fyBody;
      stepYawMoment += cgOffset * fyBody;

      if (isFront) {
        if (force.locked) state.frontLockTime += substep;
      } else if (force.utilization > 0.99 && slipRatio > 0.4) {
        state.wheelspinTime += substep;
      }
      if (force.utilization > 0.99) state.saturatedTime += substep;

      // --- integrate this wheel's rotation ---
      // A positive longitudinal force drives the car forward, which spins the
      // wheel DOWN relative to it: the wheel is what pushes the car along.
      const driveTorque = wheel === WHEEL_RL ? torqueRL : wheel === WHEEL_RR ? torqueRR : 0;
      let netTorque = driveTorque - force.fx * params.wheelRadius;

      const brakeShare = (isFront ? frontBrakeAxle : rearBrakeAxle) * 0.5;
      const omega = state.omega[wheel]!;

      /**
       * Rolling resistance: a small opposing torque that always acts.
       *
       * This is the ONLY thing coupling a coasting wheel to the road. Without it
       * a wheel in neutral keeps its angular momentum forever, so the car never
       * quite stops and settles at a few tenths of a km/h instead of rest. It
       * also gives lift-and-coast and engine-braking behaviour something physical
       * to stand on.
       */
      const rollingResistance = ROLLING_RESISTANCE * Fz * params.wheelRadius;
      // Applied as a speed-proportional term that exactly cancels at rest, so it
      // can never drive the wheel backwards and set up a limit cycle.
      const rollingScale = omega > 0 ? 1 : omega < 0 ? -1 : 0;
      const rollingMagnitude = rollingResistance < Math.abs(omega) * params.wheelInertia / substep
        ? rollingResistance
        : Math.abs(omega) * params.wheelInertia / substep;
      netTorque -= rollingScale * rollingMagnitude;

      if (omega > 0) {
        netTorque -= brakeShare;
      } else if (omega < 0) {
        netTorque += brakeShare;
      } else {
        // The wheel is at rest. Apply only as much brake torque as is needed to
        // hold it, otherwise the substep overshoots through zero and the wheel
        // oscillates instead of staying locked.
        const applied = brakeShare < Math.abs(netTorque) ? brakeShare : Math.abs(netTorque);
        netTorque -= netTorque > 0 ? applied : -applied;
      }

      let nextOmega = omega + (netTorque / params.wheelInertia) * substep;

      // Under braking, hold at rest rather than let the tire reverse the rotation:
      // that IS a locked wheel, and allowing the sign flip produces chatter.
      if (brakeShare > 0) {
        if (omega > 0 && nextOmega < 0) nextOmega = 0;
        else if (omega < 0 && nextOmega > 0) nextOmega = 0;
        else if (omega === 0 && Math.abs(nextOmega) < 0.5) nextOmega = 0;
      }

      state.omega[wheel] = nextOmega;

      // --- tire wear ---
      // Work against the tire accumulates wear, and a sliding tire wears far
      // faster. This is what makes stint length a real decision rather than a
      // fixed number of laps.
      const sliding = force.locked || Math.abs(slipRatio) > 0.3;
      const rate = WEAR_RATE_IDLE * force.utilization + (sliding ? WEAR_RATE_SLIDING : 0) * force.utilization;
      state.wear[wheel] = Math.min(1, wear + rate * substep);
    }

    sumLongAccel += stepLong / params.mass;
    sumLatAccel += stepLat / params.mass;
    sumYawAccel += stepYawMoment / params.inertia;
  }

  // Each substep contributed an acceleration for a slice of the tick; the chassis
  // integrates once per tick, so these are averaged. Drag is a per-tick force, not
  // a per-substep one, so it is added once here after the average.
  const longAccel = sumLongAccel / wheelSubsteps + dragLong / params.mass;
  const latAccel = sumLatAccel / wheelSubsteps + dragLat / params.mass;
  const yawAccel = sumYawAccel / wheelSubsteps;

  state.lastLongAccel = longAccel;
  state.lastLatAccel = latAccel;

  // --- chassis integration in the body frame ---
  // A body-fixed frame rotates, so the velocity components pick up terms from the
  // rotation itself. Positive yaw rate is counter-clockwise, a rotation from body
  // +x toward body +y, which gives these signs.
  const vx = state.vx;
  const vy = state.vy;
  const yawRate = state.yawRate;

  state.vx = vx + (longAccel + yawRate * vy) * dt;
  state.vy = vy + (latAccel - yawRate * vx) * dt;
  state.yawRate = yawRate + yawAccel * dt;
  state.heading += state.yawRate * dt;

  // --- world integration ---
  const basis = headingBasis(state.heading);
  state.x += (state.vx * basis.c - state.vy * basis.s) * dt;
  state.y += (state.vx * basis.s + state.vy * basis.c) * dt;
  state.distance += len(state.vx, state.vy) * dt;
};

