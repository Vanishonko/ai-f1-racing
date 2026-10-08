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
  /**
   * Fraction of peak torque available at idle.
   *
   * Race engines are NOT production engines: a naturally aspirated racing engine
   * makes most of its torque from low revs, which is exactly why it can be
   * launched and driven out of slow corners at all.
   *
   * An earlier version scaled torque linearly from zero at zero RPM, which is a
   * road-car shape. At idle it produced 12% of peak, so a standing start made
   * almost no torque and the car crawled away at 3 m/s after a full second of
   * full throttle. The launch was not slow because of grip; it was slow because
   * the engine was barely running.
   */
  idleTorqueFraction: number;
  /** RPM at which torque falls to `torqueFalloff` of peak. */
  torqueFalloffRpm: number;
  /** Fraction of peak torque available at `torqueFalloffRpm`. */
  torqueFalloff: number;
  /** Fraction of peak torque still available at the rev limit. */
  torqueFalloffAtRedline: number;
  /** Hard rev limit. Fuel cut above this. */
  redlineRpm: number;
  /** Idle RPM, the floor when the clutch is slipping at low speed. */
  idleRpm: number;
  /**
   * RPM at which the clutch is fully engaged.
   *
   * Below this the clutch is slipping, so the engine and the road are only partly
   * connected. Real cars need this or they stall; the simulation needed it because
   * without it engine braking pushed the car BACKWARDS from a standstill.
   */
  clutchEngageRpm: number;
  /** Braking torque from the engine when the throttle is closed [N m]. */
  engineBrakingTorque: number;
}

export const DEFAULT_ENGINE: EngineSpec = {
  peakTorque: 480,
  peakTorqueRpm: 10500,
  idleTorqueFraction: 0.43,
  torqueFalloffRpm: 13000,
  torqueFalloff: 0.85,
  torqueFalloffAtRedline: 0.6,
  redlineRpm: 15000,
  idleRpm: 1800,
  clutchEngageRpm: 700,
  engineBrakingTorque: 90,
};

/**
 * Torque as a fraction of peak, from three anchor points.
 *
 * A race engine makes useful torque off idle, peaks in the mid range, then falls
 * away to the limiter. Modelling that needs a curve with an interior maximum, and
 * two asymptotic terms multiplied together CANNOT produce one — that attempt
 * peaked at zero RPM. Three anchors with straight segments between them gives the
 * right shape, hits every named value exactly, and leaves no hidden algebra to
 * get wrong.
 *
 * Anchors: idle, peak, redline.
 */
const torqueFraction = (rpm: number, spec: EngineSpec): number => {
  const r = clamp(rpm, 0, spec.redlineRpm);
  if (r <= 0) return 0;

  const idle = spec.idleRpm;
  const peak = spec.peakTorqueRpm;
  const redline = spec.redlineRpm;

  if (r <= idle) {
    // Below idle the clutch is slipping, so the engine is held near its idle
    // torque rather than stalling to zero. This is what makes a standing start
    // possible at all.
    return spec.idleTorqueFraction * (r / idle);
  }

  if (r <= peak) {
    const t = peak > idle ? (r - idle) / (peak - idle) : 1;
    return spec.idleTorqueFraction + (1 - spec.idleTorqueFraction) * t;
  }

  if (r <= spec.torqueFalloffRpm) {
    const span = spec.torqueFalloffRpm - peak;
    const t = span > 0 ? (r - peak) / span : 1;
    return 1 - (1 - spec.torqueFalloff) * t;
  }

  // Beyond the falloff point torque drops to the limiter, where the driver should
  // already have shifted.
  const span = redline - spec.torqueFalloffRpm;
  const t = span > 0 ? (r - spec.torqueFalloffRpm) / span : 1;
  return spec.torqueFalloff * (1 - t) + spec.torqueFalloffAtRedline * t;
};

/**
 * Engine torque at a given RPM and throttle.
 *
 * `throttle` scales the torque ABOVE the engine-braking baseline rather than
 * scaling it to zero, so a closed throttle produces drag instead of nothing.
 *
 * ZERO THROTTLE MEANS ZERO DRIVE TORQUE, however much torque the curve shows at that
 * RPM, and that is not a detail. The torque curve reserves a sizeable fraction of peak
 * at idle — 0.43 — which is right for an engine turning by itself, but it was reaching
 * the gearbox too. Through a 3.4 first gear and a 3.7 final drive the residue comes to
 * a few newton-metres at the driven wheels, and a few is enough: a stationary car with
 * no controls crept backwards on its own idle, reaching 4 m of reverse travel.
 *
 * An idling engine's torque goes into overcoming its own friction and pumping losses to
 * keep turning. It is not available at the flywheel to drive the car, and in a real car
 * the torque converter or a slipping clutch absorbs what little is left. Whatever the
 * curve says at that RPM, the driver is asking for nothing.
 */
export const engineTorque = (rpm: number, throttle: number, spec: EngineSpec): number => {
  // Rev limiter. A fuel cut is abrupt, and that abruptness is the point: it is how
  // a driver knows to shift. Without it the engine kept making power past the
  // stated limit, and in testing the log read 15,512 rpm against a 15,000 rpm
  // limiter, which also confused the shift schedule into changing down a gear it
  // should have stayed out of.
  const limited = rpm >= spec.redlineRpm ? 0 : clamp(throttle, 0, 1);
  const commanded = spec.peakTorque * torqueFraction(rpm, spec) * limited;

  // Closed throttle: only drag, and more of it at higher RPM.
  const drag = spec.engineBrakingTorque * (clamp(rpm, 0, spec.redlineRpm) / spec.redlineRpm);
  return commanded - drag;
};

/**
 * The fraction of the drivetrain's torque that reaches the road.
 *
 * THE BUG THIS FIXES. With no controls, the car accelerated BACKWARDS at 0.36 m/s^2
 * and travelled 12 m in reverse in eight seconds. The cause was engine braking: a
 * closed throttle produces drag proportional to RPM, and at idle that is about
 * -13 N m, which through a 3.4 first gear and a 3.7 final drive becomes roughly
 * -206 N at the contact patch. Nothing opposed it, because at a standstill the tires
 * generate no force at all, so the car simply crept backwards — and then, once
 * moving, the tires pushed forwards against the drag and it settled at a steady
 * 10 km/h. A car that drives itself backwards is not a subtle modelling error.
 *
 * The physical answer is the one real cars use: the clutch SLIPS at low speed, so the
 * engine is only partly connected to the wheels. Without it a real car would stall
 * the moment you lifted off at a standstill.
 *
 * WHY IT RAMPS RATHER THAN SWITCHING. A first attempt let the clutch transmit NOTHING
 * below idle RPM, which is the obvious reading of "slipping" and is a deadlock: the
 * clutch needs wheel speed to engage, the wheels need torque to turn, and the car
 * could never pull away at all — it sat at exactly 0 km/h at full throttle. A slipping
 * clutch does not transmit nothing, it transmits a LIMITED torque, so this ramps from
 * a small fraction at rest to fully engaged, letting the car creep away and then lock
 * up as it gains speed.
 *
 * Engagement is keyed to WHEEL-derived RPM rather than engine RPM, because engine RPM
 * is held at idle by definition and would never show that the car is stopped.
 */
export const clutchEngagement = (rollingRpm: number, spec: EngineSpec): number => {
  /*
   * Nearly fully engaged EVEN AT REST, because this is a racing clutch.
   *
   * Earlier versions used a floor of 0.12 and then 0.35, which stopped the car
   * creeping but also strangled the launch: first gear could no longer spin the
   * wheels, which is the whole character of the car and which the tests check for.
   * A racing clutch is not a torque converter — it is dumped, and the car either
   * spins its wheels or bogs.
   *
   * What actually stops the reverse creep is not this number but the fact that at
   * zero wheel speed the engine's drag term is very small and engine braking is
   * discarded below idle (see `STEP` in car.ts). The clutch only needs to soften the
   * very first moments of a standing start, which is what the narrow ramp here does.
   */
  const floor = 0.9;
  if (rollingRpm <= 0) return floor;
  if (rollingRpm >= spec.clutchEngageRpm) return 1;
  return floor + (1 - floor) * (rollingRpm / spec.clutchEngageRpm);
};

export interface GearboxSpec {
  /** Ratio per gear, first to last. Must be descending. */
  ratios: number[];
  finalDrive: number;
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
};

/**
 * Automatic shift schedule.
 *
 * A two-threshold scheme (shift up at X, down at Y) is the obvious approach and
 * it HUNTS. With a wide gap between the thresholds an upshift can land the next
 * gear below the downshift threshold, so the box immediately shifts back: in
 * testing that produced 1 -> 2 -> 1 -> 3 within a couple of seconds, which is
 * both unphysical and a source of jitter the drivers would have to learn around.
 *
 * Instead the schedule is computed once, at build time, by asking one question
 * for every (gear, RPM) pair: would the NEXT gear make more torque at the wheels
 * than the current one? That is the actual criterion for shifting, it derives
 * from the torque curve and the ratios rather than from hand-tuned RPM numbers,
 * and it cannot hunt because the answer does not depend on history.
 *
 * Ties break toward the lower gear, so the engine sits high in the range where an
 * overtake is available.
 */
export const buildShiftSchedule = (
  engine: EngineSpec,
  gearbox: GearboxSpec,
): { upshiftRpm: Float64Array; downshiftRpm: Float64Array } => {
  const gears = gearbox.ratios.length;
  const upshiftRpm = new Float64Array(gears);
  const downshiftRpm = new Float64Array(gears);

  /*
   * The criterion is POWER, not torque at the wheels.
   *
   * A comparison of wheel torque was tried first and concluded that the car should
   * never shift at all: first gear multiplies by 3.4 against second gear's 2.6, and
   * engine torque never falls enough to close a gap that wide, so "the next gear
   * makes more wheel torque" is false at every RPM. Shifting is not about peak
   * torque, it is about staying near the engine's power peak as road speed rises.
   *
   * So the test is: for a given engine speed in the current gear, would the next
   * gear make more power at the engine speed it would then be turning?
   */

  /** Torque available at an engine speed, or zero outside the usable range. */
  const torqueAt = (rpm: number): number =>
    rpm < engine.idleRpm || rpm > engine.redlineRpm ? 0 : engineTorque(rpm, 1, engine);

  /** Would shifting UP from `rpm` produce more power? */
  const upshiftWins = (rpm: number, ratioCurrent: number, ratioNext: number): boolean => {
    const rpmNext = rpm * (ratioNext / ratioCurrent);
    return torqueAt(rpmNext) * rpmNext > torqueAt(rpm) * rpm;
  };

  /** Would shifting DOWN from `rpm` produce more power? */
  const downshiftWins = (rpm: number, ratioCurrent: number, ratioPrevious: number): boolean => {
    const rpmPrevious = rpm * (ratioPrevious / ratioCurrent);
    return torqueAt(rpmPrevious) * rpmPrevious > torqueAt(rpm) * rpm;
  };

  for (let gear = 0; gear < gears; gear++) {
    if (gear + 1 < gears) {
      // First engine speed at which the next gear would out-pull this one.
      let rpm = engine.redlineRpm;
      for (let candidate = engine.idleRpm; candidate <= engine.redlineRpm; candidate += 25) {
        if (upshiftWins(candidate, gearbox.ratios[gear]!, gearbox.ratios[gear + 1]!)) {
          rpm = candidate;
          break;
        }
      }
      upshiftRpm[gear] = rpm;
    } else {
      upshiftRpm[gear] = engine.redlineRpm;
    }

    if (gear > 0) {
      /*
       * The downshift threshold must sit BELOW where the matching upshift lands,
       * and that is what creates usable hysteresis.
       *
       * Deriving it independently does not work. For the 1.35/1.12 pair the
       * upshift lands at 12,444 rpm while an independently computed downshift
       * threshold sat at 12,600 rpm — above the landing point — so the box shifted
       * up and immediately back down, forever. In testing that produced 71 gear
       * changes in a single twelve second launch.
       *
       * Instead: find the RPM at which the gear below genuinely becomes the better
       * choice, and take the larger of that and a margin below the landing point.
       * The previous gear is checked at the speed it would actually be turning, so
       * a downshift is refused when it would simply over-rev.
       */
      const ratioCurrent = gearbox.ratios[gear]!;
      const ratioPrevious = gearbox.ratios[gear - 1]!;

      // Engine speed this gear will be turning in the gear below, at the point
      // where the upshift happened.
      const landingRpm = upshiftRpm[gear - 1]! * (ratioCurrent / ratioPrevious);
      const floor = landingRpm * 0.88;

      let rpm = engine.idleRpm;
      for (let candidate = engine.idleRpm; candidate <= engine.redlineRpm; candidate += 25) {
        if (downshiftWins(candidate, ratioCurrent, ratioPrevious)) {
          rpm = candidate;
          break;
        }
      }
      downshiftRpm[gear] = clamp(
        rpm < floor ? floor : rpm,
        engine.idleRpm,
        engine.redlineRpm,
      );
    } else {
      downshiftRpm[gear] = 0;
    }
  }

  return { upshiftRpm, downshiftRpm };
};

/**
 * Automatic shift decision against a prebuilt schedule.
 *
 * Returns the current gear whenever no shift is warranted, so it is safe to call
 * every tick.
 */
export const nextGear = (
  currentGear: number,
  rpm: number,
  throttle: number,
  gearbox: GearboxSpec,
  schedule: { upshiftRpm: Float64Array; downshiftRpm: Float64Array },
  engineRedline: number,
): number => {
  const lastGear = gearbox.ratios.length - 1;
  if (currentGear < 0) return 0;
  if (currentGear > lastGear) return lastGear;

  // An upshift needs actual throttle demand, so lifting off does not make the box
  // hunt upward.
  //
  // The rev limit OVERRIDES that test, and has to. A wheel spinning into the
  // limiter sits at an engine speed far above the upshift threshold, while the
  // fuel cut has zeroed the torque — so a demand-gated upshift never fires, no
  // downshift can fire either because the revs are too high, and the car is stuck
  // in one gear at zero drive torque with a spinning wheel. In testing that pinned
  // it in first at 105 km/h. Above the limiter the driver's demand is irrelevant
  // anyway: the only sensible action is to change up.
  const overRev = rpm >= engineRedline;
  if (currentGear < lastGear && rpm > schedule.upshiftRpm[currentGear]! && (throttle > 0.05 || overRev)) {
    return currentGear + 1;
  }
  if (currentGear > 0 && rpm < schedule.downshiftRpm[currentGear]!) {
    /*
     * NEVER shift down into a gear that would immediately over-rev.
     *
     * The shift schedule is built from engine speed alone, but a car can be
     * travelling fast enough that the lower gear is already past the limiter.
     * Without this guard the box drops a gear, instantly hits the limiter, loses
     * all drive torque, and then shifts back up — a hunting cycle that cost real
     * speed. In testing it bounced between first and second at 83 km/h.
     *
     * The check is a pure ratio, so it needs no state: at the same road speed the
     * lower gear turns `ratioLower / ratioCurrent` times as fast.
     */
    const lowerRpm = rpm * (gearbox.ratios[currentGear - 1]! / gearbox.ratios[currentGear]!);
    if (lowerRpm < engineRedline) {
      return currentGear - 1;
    }
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
  const raw = rawRpmFor(wheelOmega, gearRatio, finalDrive);
  return raw < spec.idleRpm ? spec.idleRpm : raw;
};

/**
 * The same conversion WITHOUT the idle floor.
 *
 * The floor exists so that a reported engine speed never reads below idle, which is
 * right for a tachometer and WRONG for anything asking "is the car moving?". A
 * clamped value is a constant 1800 rpm at a standstill, and that constant was being
 * used as the wheel-derived engine speed, so:
 *
 *   - the clutch believed the car was rolling at 1800 rpm and stayed nearly half
 *     engaged with the car parked, which let engine braking through to the road
 *   - the result was a stationary car creeping backwards under no controls, reaching
 *     4 m of reverse travel, with a standing start that behaved oddly as well
 *
 * Anything deriving a decision from whether the wheels are turning must use this one.
 */
export const rawRpmFor = (wheelOmega: number, gearRatio: number, finalDrive: number): number =>
  wheelOmega * gearRatio * finalDrive * (60 / (2 * Math.PI));

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
