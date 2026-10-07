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

/** Substeps per tick for wheel dynamics, which are stiffer than the chassis. */
export const WHEEL_SUBSTEPS = 4;

/**
 * Below this road speed the slip-ratio denominator is clamped, so a stationary car
 * does not divide by zero. Genuine slip at walking pace is not interesting.
 */
export const MIN_REFERENCE_SPEED = 1.0;

/** Grip multiplier at maximum tire wear. Worn tires lose about a third. */
const WORN_GRIP = 0.65;

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
    brakeBiasFront: 0.6,
    maxBrakeTorque: 6200,
    engine: DEFAULT_ENGINE,
    gearbox: DEFAULT_GEARBOX,
    differential: DEFAULT_DIFF,
    tire: DEFAULT_TIRE,
    downforceFront: 1900,
    downforceRear: 2300,
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
}

export const CLEAN_AIR: StepContext = { surfaceGrip: 1, gripNoise: 1, dirtyAir: 0 };

/** Seconds between tire-wear updates; wear is slow and need not run every tick. */
const STEER_RATE = 6.0; // rad/s, roughly a fast hand movement

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
): void => {
  // --- gearbox and engine ---
  const drivenOmega = (state.omega[WHEEL_RL]! + state.omega[WHEEL_RR]!) * 0.5;
  const gearRatio = params.gearbox.ratios[state.gear] ?? params.gearbox.ratios[0]!;
  state.rpm = rpmFor(drivenOmega, gearRatio, params.gearbox.finalDrive, params.engine);

  if (state.shiftTimer > 0) {
    state.shiftTimer = state.shiftTimer > dt ? state.shiftTimer - dt : 0;
  } else {
    const wanted = nextGear(state.gear, state.rpm, state.throttle, params.gearbox, false);
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

  // --- wheel dynamics, substepped ---
  const substep = dt / WHEEL_SUBSTEPS;
  const grip = context.surfaceGrip * context.gripNoise;
  const axleTorque = engineOut * gearRatio * params.gearbox.finalDrive;
  const diff = params.differential;
  const brakeTotal = clamp(state.brake, 0, 1) * params.maxBrakeTorque;
  const frontBrakeAxle = brakeTotal * params.brakeBiasFront;
  const rearBrakeAxle = brakeTotal * (1 - params.brakeBiasFront);

  const cosD = steerCos(state.steerAngle);
  const sinD = steerSin(state.steerAngle);

  let sumLongAccel = 0;
  let sumLatAccel = 0;
  let sumYawAccel = 0;

  for (let step = 0; step < WHEEL_SUBSTEPS; step++) {
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
      const rate = 0.00002 * force.utilization + (sliding ? 0.0004 : 0) * force.utilization;
      state.wear[wheel] = Math.min(1, wear + rate * substep);
    }

    sumLongAccel += stepLong / params.mass;
    sumLatAccel += stepLat / params.mass;
    sumYawAccel += stepYawMoment / params.inertia;
  }

  // Each substep contributed an acceleration for a slice of the tick; the chassis
  // integrates once per tick, so these are averaged.
  const longAccel = sumLongAccel / WHEEL_SUBSTEPS;
  const latAccel = sumLatAccel / WHEEL_SUBSTEPS;
  const yawAccel = sumYawAccel / WHEEL_SUBSTEPS;

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
