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

import { DEFAULT_TIRE, tireForces, type TireParams } from "./tire.ts";
import {
  DEFAULT_DIFF,
  DEFAULT_ENGINE,
  DEFAULT_GEARBOX,
  buildShiftSchedule,
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
export const DEFAULT_WHEEL_SUBSTEPS = 16;

/**
 * Below this road speed the slip-ratio denominator is clamped, so a stationary car
 * does not divide by zero. Genuine slip at walking pace is not interesting.
 */
export const MIN_REFERENCE_SPEED = 1.0;

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

/**
 * Speed below which the car is snapped to a complete stop [m/s].
 *
 * Below the slip-ratio reference speed, slip ratio loses physical meaning, so the
 * longitudinal force computed from it becomes noise and flips sign between ticks.
 * Left alone that makes a "stopped" car oscillate and slowly accelerate BACKWARDS
 * — it drifted to -0.66 m/s in testing.
 *
 * The rule is deliberately narrow, so it can never mask real dynamics:
 *   - the driver must not be demanding throttle, and
 *   - they must be braking, or already crawling below the threshold anyway.
 *
 * A car under power, or coasting at speed, is untouched by this.
 */
const STOP_SPEED = 0.35;

/** Lateral velocity below which a near-stationary car is considered settled [m/s]. */
const SETTLE_LATERAL_SPEED = 0.2;

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
    brakeBiasFront: 0.64,
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
  gear: 0,
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
export const downforceAt = (speed: number, valueAt50: number): number => {
  const ratio = speed / 50;
  return valueAt50 * ratio * ratio;
};

/**
 * Per-wheel normal loads, including longitudinal and lateral weight transfer.
 *
 * `longAccel` is measured longitudinal acceleration, NEGATIVE under braking. Its
 * sign is what produces the behaviour the whole tire model depends on: braking
 * unloads the rear axle and loads the front, so with forward brake bias the fronts
 * are the first to run out of grip.
 *
 * Lateral transfer is the same steady-state relation applied side to side. It
 * unloads the inside wheel in a corner, which is why a car can lock its inside
 * front or spin up its inside rear while the other side looks fine.
 *
 * Loads here are the FULL axle load split across its two wheels.
 */
export const computeNormalLoads = (
  state: CarState,
  params: CarParams,
  longAccel: number,
  latAccel: number,
): void => {
  const g = 9.81;
  const totalWeight = params.mass * g;

  // Capped so a collision spike cannot hand out an absurd grip advantage.
  const maxTransfer = totalWeight * 0.5;
  const longTransfer = clamp(
    (params.mass * longAccel * params.cgHeight) / params.wheelbase,
    -maxTransfer,
    maxTransfer,
  );

  const speed = len(state.vx, state.vy);
  const frontAxle = Math.max(
    0,
    totalWeight * params.weightDistFront - longTransfer + downforceAt(speed, params.downforceFront),
  );
  const rearAxle = Math.max(
    0,
    totalWeight * (1 - params.weightDistFront) +
      longTransfer +
      downforceAt(speed, params.downforceRear),
  );

  // Positive `latAccel` means accelerating toward body +y (left), which loads the
  // LEFT wheel of each pair.
  const frontTransfer = ((params.mass * latAccel * params.cgHeight) / params.trackFront) * 0.5;
  const rearTransfer = ((params.mass * latAccel * params.cgHeight) / params.trackRear) * 0.5;

  const frontHalf = frontAxle * 0.5;
  const rearHalf = rearAxle * 0.5;

  state.normalLoad[WHEEL_FL] = Math.max(0, frontHalf + frontTransfer);
  state.normalLoad[WHEEL_FR] = Math.max(0, frontHalf - frontTransfer);
  state.normalLoad[WHEEL_RL] = Math.max(0, rearHalf + rearTransfer);
  state.normalLoad[WHEEL_RR] = Math.max(0, rearHalf - rearTransfer);
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
}

export const CLEAN_AIR: StepContext = {
  surfaceGrip: 1,
  gripNoise: 1,
  dirtyAir: 0,
  brakeScale: 1,
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
  const rollingRpm = rpmFor(state.vx / params.wheelRadius, gearRatio, params.gearbox.finalDrive, params.engine);

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

  // No drive torque while the gear is changing.
  const engineOut =
    engineTorque(state.rpm, state.throttle, params.engine) * (state.shiftTimer > 0 ? 0 : 1);

  // --- steering actuator, rate limited so full lock takes time to apply ---
  const steerTarget = clamp(state.steerCommand, -1, 1) * MAX_STEER_ANGLE;
  const maxSteerDelta = STEER_RATE * dt;
  state.steerAngle += clamp(steerTarget - state.steerAngle, -maxSteerDelta, maxSteerDelta);

  // --- load transfer from the previous tick's acceleration ---
  computeNormalLoads(state, params, state.lastLongAccel, state.lastLatAccel);

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

/** Signed road speed along the car's heading [m/s]. */
export const forwardSpeed = (state: CarState): number => state.vx;
