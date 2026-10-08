/**
 * What a driver can see.
 *
 * THE OBSERVATION CONTRACT — the interface between the car and whatever is driving it.
 * It is fixed-size and fully specified, so a trained driver is a pure function of this
 * array and a replay of one is meaningful.
 *
 * DESIGN NOTES, because a sensor layout decides what a driver can possibly learn.
 *
 *  - RAYS AHEAD, NOT GLOBAL STATE. The car does not get to know the whole circuit
 *    layout. It gets a fan of rays out of the nose, which is roughly what a driver has.
 *    Handing it the full centreline instead would let it learn a lookup table for each
 *    circuit rather than how to drive, and it would be useless on a layout it had not
 *    seen.
 *
 *  - ANGLES ARE SIN AND COS, never raw radians. A raw angle wraps, so 359 degrees and 1
 *    degree look maximally different to a network when they are nearly the same. The
 *    pair is continuous everywhere, which removes a whole class of training pathology.
 *    The engine does the same for heading elsewhere for the same reason.
 *
 *  - EVERYTHING NORMALIZED to roughly [-1, 1] or [0, 1]. Inputs on wildly different
 *    scales make an evolutionary search much harder to steer, and a speed in m/s next
 *    to a wear fraction in 0..1 would do exactly that.
 *
 *  - NO TRANSCENDENTALS. Ray directions come from the baked sine and cosine tables in
 *    `steerLut`, and the arithmetic is multiply and add, so the whole observation is
 *    inside the determinism contract.
 */

import { steerSin, steerCos, headingBasis, MAX_STEER_ANGLE } from "./steerLut.ts";
import { len } from "./math2d.ts";
import { projectToTrackNear, type Track } from "./track.ts";
import { WHEEL_FL, WHEEL_FR, WHEEL_RL, WHEEL_RR, type CarState } from "./car.ts";

/** Number of distance rays cast ahead of the car. */
export const RAY_COUNT = 11;

/** Furthest a ray reaches [m]. Beyond this the car is effectively off the circuit. */
export const RAY_RANGE = 90;

/** How far the fan spreads either side of the nose, in radians. */
const RAY_HALF_ANGLE = 1.0;

/**
 * Inputs per observation.
 *
 * Laid out as: ray fan, then speed and control state, then attitude, then tires.
 * Grouped so the layout is readable in a debugger rather than being an anonymous block
 * of sixty floats.
 */
export const OBSERVATION_SIZE =
  RAY_COUNT * 2 +   // each ray: proximity, and lateral offset of the track edge
  4 +               // forward speed, lateral speed, yaw rate, steering angle
  4 +               // heading error as sin/cos, and lateral offset as fraction of width
  4 +               // engine speed, gear, throttle, brake
  4;                // the four tire utilization values

/** Speeds are reported as a fraction of this, so the input stays near [-1, 1]. */
const SPEED_SCALE = 80;

/**
 * Yaw rates divide by this.
 *
 * A tight corner at 50 km/h produces roughly one radian per second, and a spin rather
 * more, so this keeps the input in the same range as the rest without clipping the
 * information a driver needs to catch a slide.
 */
const YAW_RATE_SCALE = 3;

/**
 * Maps the whole real line smoothly into (-1, 1), preserving sign and order.
 *
 * Written here rather than imported because it is the same curve as `saturateUnit`
 * reflected about zero; sharing one would mean the sense module importing an activation
 * helper, which is the wrong direction of dependency.
 */
const signedSaturate = (value: number): number => {
  const m = value < 0 ? -value : value;
  if (m < 1e-9) return 0;
  return value / Math.sqrt(1 + value * value);
};

export interface Observation {
  /** Fixed-length input vector. Reused between steps to avoid per-tick allocation. */
  values: Float64Array;
  /** Distance along the track this observation was taken at [m]. */
  distance: number;
  /** Signed lateral offset from the centreline [m]. */
  lateral: number;
  /** Sine of the car's heading relative to the track. Positive means pointing left. */
  headingErrorSin: number;
  /** Cosine of the same, so the pair is continuous through a half turn. */
  headingErrorCos: number;
  /** True when the car is within the drivable width. */
  onTrack: boolean;
}

/** Allocates an observation buffer. One per car, reused every tick. */
export const createObservation = (): Observation => ({
  values: new Float64Array(OBSERVATION_SIZE),
  distance: 0,
  lateral: 0,
  headingErrorSin: 0,
  headingErrorCos: 0,
  onTrack: true,
});

/**
 * Fills `out` from the current car and track state.
 *
 * @param previousDistance the car's last known distance along the track, so the
 *        projection can search locally. See `projectToTrackNear` for why a global
 *        nearest-sample search is wrong on a circuit that folds back near itself.
 */
export const observe = (
  out: Observation,
  car: CarState,
  track: Track,
  previousDistance: number,
): void => {
  const projection = projectToTrackNear(track, car.x, car.y, previousDistance);
  out.distance = projection.s;
  out.lateral = projection.d;
  out.onTrack = projection.onTrack;

  /*
   * The car's heading RELATIVE TO THE TRACK, as a direction rather than an angle.
   *
   * Both the car's heading and the centreline's direction are known, so the relative
   * rotation between them falls out of two multiplications each way. Forming the angle
   * first would need an inverse trigonometric function, which is both banned on a hot
   * path and unnecessary — the network wants a continuous pair, not radians, and the
   * pair is what it gets.
   *
   * These are the components of the car's heading expressed in the track's frame, so
   * `errorSin` is positive when the car points to the track's left. That is the same
   * convention as steering, which is what lets a driver learn to correct a slide.
   */
  const carBasis = headingBasis(car.heading);
  const errorSin = carBasis.s * projection.tangentX - carBasis.c * projection.tangentY;
  const errorCos = carBasis.c * projection.tangentX + carBasis.s * projection.tangentY;
  out.headingErrorSin = errorSin;
  out.headingErrorCos = errorCos;

  const values = out.values;
  let at = 0;

  /*
   * Ray fan.
   *
   * Each ray is cast by walking the track forward from the car's own position, which is
   * cheap and exact because the track is already a sampled centreline. A ray reports two
   * things: how far it got before leaving the drivable width, and where the centreline
   * sits laterally at that range. Together those describe the corner ahead — a tight
   * corner shows a near ray with a large offset, a straight shows distant rays with
   * almost none.
   */
  const halfWidth = track.halfWidth;
  for (let ray = 0; ray < RAY_COUNT; ray++) {
    const t = ray / (RAY_COUNT - 1);
    const angle = (t - 0.5) * 2 * RAY_HALF_ANGLE;
    const sin = steerSin(angle);
    const cos = steerCos(angle);

    // Direction of this ray in world space.
    const dirX = projection.tangentX * cos - projection.tangentY * sin;
    const dirY = projection.tangentX * sin + projection.tangentY * cos;

    let travelled = 0;
    let centreOffset = 0;
    const step = 6;
    while (travelled < RAY_RANGE) {
      travelled += step;
      const probeX = car.x + dirX * travelled;
      const probeY = car.y + dirY * travelled;
      const probe = projectToTrackNear(track, probeX, probeY, projection.s + travelled);
      if (!probe.onTrack) break;
      centreOffset = probe.d;
    }

    values[at++] = travelled / RAY_RANGE;
    values[at++] = centreOffset / halfWidth;
  }

  /*
   * Speed and control state.
   *
   * Every one of these is SCALED so a typical extreme lands near the unit interval. Raw
   * units would put a yaw rate of a few radians per second next to a wear fraction in
   * 0..1, and an evolutionary search cannot steer a space whose axes differ by orders of
   * magnitude — the large ones dominate the distance metric and the others are invisible.
   */
  values[at++] = car.vx / SPEED_SCALE;
  values[at++] = car.vy / SPEED_SCALE;
  values[at++] = car.yawRate / YAW_RATE_SCALE;
  values[at++] = car.steerAngle / MAX_STEER_ANGLE;

  // Attitude relative to the track.
  values[at++] = errorSin;
  values[at++] = errorCos;
  /*
   * Lateral offset as a signed fraction of the half width, SATURATED rather than
   * clamped. A car can be arbitrarily far off the circuit, and a raw ratio reached -23 in
   * testing, which would swamp every other input. Saturating maps the whole real line
   * smoothly into (-1, 1) while preserving the sign and the ordering, so "further off
   * track" still means a larger value right out to the horizon.
   */
  values[at++] = signedSaturate(projection.d / halfWidth);
  values[at++] = len(car.vx, car.vy) / SPEED_SCALE;

  // Engine and driver state.
  values[at++] = car.rpm / 15000;
  values[at++] = car.gear / 6;
  values[at++] = car.throttle;
  values[at++] = car.brake;

  // Tire state, so wear and saturation are observable rather than guessed.
  values[at++] = car.utilization[WHEEL_FL]!;
  values[at++] = car.utilization[WHEEL_FR]!;
  values[at++] = car.utilization[WHEEL_RL]!;
  values[at++] = car.utilization[WHEEL_RR]!;
};
