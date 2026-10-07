/**
 * Powertrain: engine torque curve, gearbox with automatic shifting, final drive,
 * and a limited-slip differential.
 *
 * This exists so throttle is a genuinely analog input with consequences. The
 * same 100% throttle request produces wheelspin in first gear and merely brisk
 * progress in sixth, because the torque actually delivered to the wheels depends
 * on the gear, the RPM, and what the tires can put down.
 *
 * Deterministic: pure arithmetic, no transcendentals, no randomness.
 */

import { clamp } from "./math2d.ts";

export interface EngineSpec {
  /** Peak torque [N m]. */
  peakTorque: number;
  /** RPM at which torque peaks. */
  peakTorqueRpm: number;
  /** RPM at which torque falls to `torqueFalloff` of peak. */
  torqueFalloffRpm: number;
  /** Fraction of peak torque available at `torqueFalloffRpm` and beyond. */
  torqueFalloff: number;
  /** Hard rev limit. Fuel cut above this. */
  redlineRpm: number;
  /** Idle RPM, the floor when the clutch is in effect at low speed. */
  idleRpm: number;
  /** Braking torque from the engine when the throttle is closed [N m]. */
  engineBrakingTorque: number;
}

export const DEFAULT_ENGINE: EngineSpec = {
  peakTorque: 480,
  peakTorqueRpm: 10500,
  torqueFalloffRpm: 13000,
  torqueFalloff: 0.8,
  redlineRpm: 15000,
  idleRpm: 1800,
  engineBrakingTorque: 90,
};

/**
 * Engine torque at a given RPM and throttle.
 *
 * A simple triangular curve: rises linearly to the torque peak, then falls to
 * `torqueFalloff` of peak at the falloff point, staying flat beyond it. Real
 * curves are lumpier; what matters here is that torque is NOT constant, so gear
 * choice changes the outcome and short-shifting costs lap time.
 *
 * `throttle` scales the torque ABOVE the engine-braking baseline rather than
 * scaling it to zero, so a closed throttle produces drag instead of nothing.
 */
export const engineTorque = (rpm: number, throttle: number, spec: EngineSpec): number => {
  const rpmClamped = clamp(rpm, 0, spec.redlineRpm);
  let torque: number;

  if (rpmClamped <= spec.peakTorqueRpm) {
    // Rising limb, from zero torque at zero RPM to peak torque at the peak.
    torque = spec.peakTorque * (rpmClamped / spec.peakTorqueRpm);
  } else if (rpmClamped <= spec.torqueFalloffRpm) {
    const t = (rpmClamped - spec.peakTorqueRpm) / (spec.torqueFalloffRpm - spec.peakTorqueRpm);
    torque = spec.peakTorque * (1 - t * (1 - spec.torqueFalloff));
  } else {
    torque = spec.peakTorque * spec.torqueFalloff;
  }

  // Closed throttle: only drag, and more of it at higher RPM.
  const drag = spec.engineBrakingTorque * (rpmClamped / spec.redlineRpm);
  const commanded = torque * clamp(throttle, 0, 1);
  return commanded - drag;
};

export interface GearboxSpec {
  /** Ratio per gear, first to last. Must be descending. */
  ratios: number[];
  finalDrive: number;
  /** RPM to shift up at, chosen to land the next gear in its power band. */
  shiftUpRpm: number;
  /** RPM to shift down at. Below shiftUp to create hysteresis. */
  shiftDownRpm: number;
}

/**
 * Six speeds. First gear is deliberately tall enough to spin the wheels: with
 * 480 N m through a 3.4 first gear and a 3.7 final drive, the rear axle sees
 * roughly 6000 N m, far more than two loaded tires can transmit. That is the
 * wheelspin the reward function will eventually teach the drivers to manage.
 */
export const DEFAULT_GEARBOX: GearboxSpec = {
  ratios: [3.4, 2.6, 2.05, 1.65, 1.35, 1.12],
  finalDrive: 3.7,
  shiftUpRpm: 13500,
  shiftDownRpm: 7500,
};

/**
 * Automatic shift decision.
 *
 * Both thresholds are checked at once so they can never fight each other. The
 * gap between `shiftUpRpm` and `shiftDownRpm` is hysteresis: without it a car
 * sitting near a threshold would shift up and down every tick, which is both
 * unphysical and a source of jitter the drivers would have to learn around.
 */
export const nextGear = (
  currentGear: number,
  rpm: number,
  throttle: number,
  spec: GearboxSpec,
  shifting: boolean,
): number => {
  const lastGear = spec.ratios.length - 1;
  if (currentGear < 0) return 0;
  if (currentGear > lastGear) return lastGear;

  // Upshift when revving out under load.
  if (rpm > spec.shiftUpRpm && throttle > 0.1 && currentGear < lastGear) {
    return currentGear + 1;
  }
  // Downshift when the revs drop, regardless of throttle, so the car is always
  // in a gear it can accelerate out of.
  if (rpm < spec.shiftDownRpm && currentGear > 0) {
    return currentGear - 1;
  }
  return currentGear;
};

/**
 * Engine RPM implied by road speed in a gear.
 *
 * Includes the idle floor, which stands in for a slipping clutch at low speed.
 * Without it the engine would stall the instant the car stops, and RPM would go
 * to zero and stay there.
 */
export const rpmFor = (
  wheelOmega: number,
  gearRatio: number,
  finalDrive: number,
  spec: EngineSpec,
): number => {
  const raw = wheelOmega * gearRatio * finalDrive * (60 / (2 * Math.PI));
  return raw < spec.idleRpm ? spec.idleRpm : raw;
};

/** Time taken for one gearshift [s]. Drive torque is cut for its duration. */
export const SHIFT_DURATION = 0.05;

export interface DifferentialSpec {
  /**
   * 0 = fully open, 1 = fully locked.
   *
   * An open differential always splits torque equally, so a wheel with no grip
   * simply spins and the car goes nowhere. A locked differential forces both
   * wheels to the same speed, which puts the torque down but makes the car
   * resist turning. The interesting behaviour lives between the two, and the
   * drivers will eventually have opinions about which they want.
   */
  lock: number;
  /** Torque bias ratio cap, so one spinning wheel cannot take everything. */
  maxBias: number;
}

export const DEFAULT_DIFF: DifferentialSpec = {
  lock: 0.35,
  maxBias: 3.0,
};
