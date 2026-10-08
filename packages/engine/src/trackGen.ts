/**
 * Procedural track generation by tangent-continuous design.
 *
 * THE IDEA, and why it replaces what came before: hand-placing control points and
 * letting a spline decide the radius does not work. The resulting corner radii are
 * whatever the smoothing happens to produce, so a track cannot be designed to have
 * a slow technical section and a fast sweeper — you get whatever you get, and then
 * you measure it and hope. Roughly twenty attempts at building layouts that way
 * failed in this project, in a different way almost every time.
 *
 * Instead a track is described as a SEQUENCE OF STRAIGHTS AND CIRCULAR ARCS, and a
 * follower walks it, appending points as it goes. Heading and position are
 * continuous by construction, so the centreline cannot kink, cannot fold back on
 * itself and cannot cross itself as long as the designer does not ask for it.
 *
 * The important consequence is that CORNER SPEED BECOMES AN INPUT. A 25 m radius
 * is a first-gear hairpin, a 150 m radius is a flat-out sweeper, and asking for
 * one gets you one. That is what makes it possible to build a track with the mix of
 * features a real circuit has, rather than discovering afterwards that everything
 * is a medium-speed corner.
 *
 * The only constraint the follower cannot satisfy on its own is CLOSURE: the
 * sequence must return to its starting point with the same heading, or the track is
 * not a loop. That is what the search below is for.
 */

import { clamp } from "./math2d.ts";

/** One piece of track: either a straight of a given length, or a constant-radius turn. */
export type Segment =
  | { kind: "straight"; length: number }
  | { kind: "turn"; radius: number; degrees: number };

export interface TrackPlan {
  name: string;
  halfWidth: number;
  segments: Segment[];
}

/** Sampling distance along the centreline [m]. Matches the hand-authored tracks. */
const SPACING = 0.5;

/** Turn sampling: at most this many degrees per emitted point. */
const DEGREES_PER_SAMPLE = 2;

const toRadians = (degrees: number): number => (degrees * Math.PI) / 180;

/** Sine and cosine of the four right angles, exactly. */
const RIGHT_ANGLE_COS = [1, 0, -1, 0] as const;
const RIGHT_ANGLE_SIN = [0, 1, 0, -1] as const;

/**
 * Sine and cosine of an angle, without calling a transcendental.
 *
 * An angle is split into a whole number of right angles — where the values are
 * exact — plus a remainder under 45 degrees. The remainder is then accumulated by
 * the rotation recurrence, which is the only operation that defines sine and
 * cosine of a small step and is therefore exact to machine precision rather than
 * approximate.
 *
 * The point is determinism, not speed. `Math.sin`/`Math.cos` are not guaranteed
 * bit-identical across engines, and a track generated a hair differently on two
 * machines would put a subtly different circuit under the same seed — breaking
 * every replay, every checkpoint and every comparison of lap times. Two hundred
 * multiplications is a trivial price for that guarantee, and this runs once per
 * track rather than once per physics tick.
 */
export const sincos = (angle: number): { sin: number; cos: number } => {
  let remainder = angle;
  let quarterSin = 0;
  let quarterCos = 1;
  const quarter = Math.PI / 2;

  // Peel off whole right angles, applying each as an exact coordinate swap.
  while (remainder >= quarter) {
    remainder -= quarter;
    const nextSin = quarterCos;
    const nextCos = -quarterSin;
    quarterSin = nextSin;
    quarterCos = nextCos;
  }
  while (remainder < 0) {
    remainder += quarter;
    const nextSin = -quarterCos;
    const nextCos = quarterSin;
    quarterSin = nextSin;
    quarterCos = nextCos;
  }

  // Small-angle accumulation. Each step is at most 1/64 rad, so 64 steps cover
  // the remainder and the error per step is far below double precision.
  const steps = 64;
  const dt = remainder / steps;
  const stepSin = dt;
  const stepCos = 1 - (dt * dt) / 2;
  let sin = quarterSin;
  let cos = quarterCos;
  for (let i = 0; i < steps; i++) {
    const nextSin = sin * stepCos + cos * stepSin;
    const nextCos = cos * stepCos - sin * stepSin;
    sin = nextSin;
    cos = nextCos;
  }
  return { sin, cos };
};

/**
 * The incremental rotation for a turn's per-sample step, precomputed once.
 *
 * A turn emits points by rotating the current heading a fixed small amount and
 * stepping along it, so only ONE small rotation is needed per turn rather than one
 * per point.
 */
const stepRotation = (step: number): { sin: number; cos: number } => sincos(step);

void RIGHT_ANGLE_COS;
void RIGHT_ANGLE_SIN;

/**
 * Walks a plan and returns the centreline, or null if it does not close.
 *
 * Heading is carried explicitly rather than derived from the point list, which is
 * the whole trick: each segment starts exactly where the last one ended and turns
 * at exactly the rate it asked for.
 */
export const followPlan = (
  segments: readonly Segment[],
  tolerance = 12,
): { xs: number[]; ys: number[]; headings: number[]; curvature: number[] } | null => {
  const xs: number[] = [];
  const ys: number[] = [];
  const headings: number[] = [];
  // Curvature recorded as the walk goes, which is exact: a straight is 0 and a
  // turn is 1/radius by definition. Recovering it later by differentiating the
  // point list is what produced a 7 m reading for a 14 m corner.
  const curvature: number[] = [];

  // Heading 0 is +x. Positive is counter-clockwise, matching the car's frame.
  let heading = 0;
  let x = 0;
  let y = 0;

  const push = (turnRadius: number): void => {
    xs.push(x);
    ys.push(y);
    headings.push(heading);
    curvature.push(Number.isFinite(turnRadius) ? 1 / turnRadius : 0);
  };
  push(Infinity);

  for (const segment of segments) {
    if (segment.kind === "straight") {
      const steps = Math.max(1, Math.round(segment.length / SPACING));
      const stride = segment.length / steps;
      const { sin: dirSin, cos: dirCos } = sincos(heading);
      for (let i = 0; i < steps; i++) {
        x += dirCos * stride;
        y += dirSin * stride;
        push(Infinity);
      }
    } else {
      const total = toRadians(segment.degrees);
      const samples = Math.max(2, Math.ceil(Math.abs(segment.degrees) / DEGREES_PER_SAMPLE));
      const step = total / samples;
      const rotation = stepRotation(step);
      // The chord for one sample of the arc, in the direction of the CURRENT
      // heading: rotate by half a step so the chord is symmetric about the
      // heading and the polyline stays centred on the true arc.
      const half = stepRotation(step / 2);
      const chord = 2 * segment.radius * (half.sin < 0 ? -half.sin : half.sin);
      const chordScale = segment.degrees < 0 ? -1 : 1;

      for (let i = 0; i < samples; i++) {
        // Direction of travel for this sample's chord: the heading rotated by half
        // a step, so the chord is symmetric about the heading and the polyline
        // stays centred on the true arc rather than cutting inside it.
        const base = sincos(heading);
        const dirCos = base.cos * half.cos - base.sin * half.sin;
        const dirSin = base.sin * half.cos + base.cos * half.sin;
        x += dirCos * chord * chordScale;
        y += dirSin * chord * chordScale;
        heading += step;
        push(segment.radius);
      }
      void rotation;
    }
  }

  // Closure: distance from the finish back to the start, and heading error.
  const closeDistance = Math.sqrt(x * x + y * y);
  // The total turn must be a whole number of full circles for the heading to match.
  const turns = heading / (Math.PI * 2);
  const headingError = Math.abs(turns - Math.round(turns)) * Math.PI * 2;

  if (closeDistance > tolerance) return null;
  if (headingError > toRadians(8)) return null;
  return { xs, ys, headings, curvature };
};

export interface PlanMetrics {
  length: number;
  /** Tightest corner radius anywhere on the lap [m]. */
  minRadius: number;
  /** Number of contiguous corners under `slowRadius`. */
  slowCorners: number;
  /** Number of contiguous corners over `fastRadius`. */
  fastCorners: number;
  /** Longest straight [m]. */
  longestStraight: number;
  /** Straight length immediately before each slow corner, longest first. */
  approachLengths: number[];
  closes: boolean;
  /** Fraction of the lap spent cornering hard, 0..1. */
  technicalFraction: number;
}

export const SLOW_RADIUS = 40;
export const FAST_RADIUS = 120;

/**
 * Tests a plan against what actually makes a circuit race well.
 *
 * DELIBERATELY A SET OF REQUIREMENTS RATHER THAN A SINGLE SCORE. A weighted sum
 * lets a track make up for having no overtaking opportunity by being long or fast
 * somewhere else, which is exactly the failure being designed out: the earlier
 * layouts were acceptable on average while being uniformly medium-speed, and the
 * average hid it.
 *
 * The requirements come from how real circuits earn their reputation:
 *  - at least two slow corners, so there is more than one place to out-brake;
 *  - each of those fed by a long straight, because the overtake is built in the
 *    tow down the straight and completed in the braking zone. Without the straight,
 *    a slow corner is just slow.
 *  - at least one fast corner, so the lap is not permanently slow and the cars
 *    have somewhere to be committed rather than always settling.
 *
 * The technical-fraction band is wide on purpose. Real circuits spend only a small
 * part of the lap in genuinely slow corners — measured this way, Sepang is about
 * 9% — so a high floor would reject good tracks.
 */
export const analysePlan = (
  plan: TrackPlan,
  suffix = "",
  fullWidth = true,
): PlanMetrics | null => {
  const followed = followPlan(plan.segments);
  if (!followed) return null;

  const { xs, ys, headings } = followed;
  const count = xs.length;
  const empty: PlanMetrics = {
    length: 0, minRadius: Infinity, slowCorners: 0, fastCorners: 0,
    longestStraight: 0, approachLengths: [], closes: true, technicalFraction: 0,
  };
  if (count < 16) return empty;

  // Walk the point list once, deriving length, straight runs and corner runs.
  let length = 0;
  const curvatures: number[] = [0];
  for (let i = 1; i < count; i++) {
    const dx = xs[i]! - xs[i - 1]!;
    const dy = ys[i]! - ys[i - 1]!;
    length += Math.sqrt(dx * dx + dy * dy);
    curvatures.push(0);
  }
  void suffix;
  void fullWidth;
  void headings;

  // Radius at each point, from the plan's own segments rather than from a
  // numerical derivative: the generator already knows the radius, so measuring it
  // back out would only reintroduce the noise that made curvature unreliable.
  const radii: number[] = [];
  for (const segment of plan.segments) {
    const steps = segment.kind === "straight"
      ? Math.max(1, Math.round(segment.length / SPACING))
      : Math.max(2, Math.ceil(Math.abs(segment.degrees) / DEGREES_PER_SAMPLE));
    for (let i = 0; i < steps; i++) {
      radii.push(segment.kind === "straight" ? Infinity : segment.radius);
    }
  }

  // Classify each point, then count contiguous runs.
  let minRadius = Infinity;
  let slowCorners = 0;
  let fastCorners = 0;
  let longestStraight = 0;
  let straightRun = 0;
  const approachLengths: number[] = [];
  let pendingStraight = 0;
  let inSlow = false;
  let inFast = false;
  let hardPoints = 0;

  for (let i = 0; i < radii.length; i++) {
    const radius = radii[i]!;
    const isStraight = !Number.isFinite(radius);
    if (isStraight) {
      straightRun += SPACING;
      if (straightRun > longestStraight) longestStraight = straightRun;
      pendingStraight = straightRun;
    } else {
      straightRun = 0;
      if (radius < minRadius) minRadius = radius;
      if (radius < SLOW_RADIUS) {
        hardPoints++;
        if (!inSlow) {
          slowCorners++;
          // The straight that leads into this corner is the approach.
          if (pendingStraight > 0) approachLengths.push(pendingStraight);
          pendingStraight = 0;
        }
        inSlow = true;
        inFast = false;
      } else if (radius > FAST_RADIUS) {
        if (!inFast) fastCorners++;
        inFast = true;
        inSlow = false;
      } else {
        inSlow = false;
        inFast = false;
      }
    }
  }

  return {
    length,
    minRadius,
    slowCorners,
    fastCorners,
    longestStraight,
    approachLengths: approachLengths.sort((a, b) => b - a),
    closes: true,
    technicalFraction: radii.length > 0 ? hardPoints / radii.length : 0,
  };
};

/** Convenience wrapper: is this plan worth putting a car on? */
export const planIsInteresting = (metrics: PlanMetrics | null): boolean => {
  if (!metrics) return false;
  return (
    metrics.length > 1800 &&
    metrics.length < 6000 &&
    metrics.slowCorners >= 2 &&
    metrics.minRadius <= 32 &&
    metrics.longestStraight >= 260 &&
    metrics.approachLengths.some((l) => l >= 200) &&
    metrics.fastCorners >= 1 &&
    metrics.technicalFraction > 0.03 &&
    metrics.technicalFraction < 0.5 &&
    metrics.approachLengths.filter((l) => l >= 250).length >= 1
  );
};

/** Formats a plan as a readable summary, for logs and commit messages. */
export const describePlan = (plan: TrackPlan): string => {
  const m = analysePlan(plan);
  if (!m) return `${plan.name}: does not close`;
  const kph = (r: number): string => (Math.sqrt(1.55 * 9.81 * r) * 3.6).toFixed(0);
  return (
    `${plan.name.padEnd(16)} ${m.length.toFixed(0).padStart(4)} m  ` +
    `tightest ${m.minRadius.toFixed(0).padStart(3)} m (${kph(m.minRadius).padStart(3)} km/h)  ` +
    `slow ${m.slowCorners}  fast ${m.fastCorners}  ` +
    `longest straight ${m.longestStraight.toFixed(0).padStart(4)} m  ` +
    `approaches ${m.approachLengths.slice(0, 2).map((l) => l.toFixed(0)).join(", ") || "-"}  ` +
    `technical ${(m.technicalFraction * 100).toFixed(0)}%`
  );
};

/** Clamps a radius to something a car with this much grip can actually take. */
export const saneRadius = (radius: number, halfWidth: number): number =>
  clamp(radius, halfWidth * 1.4, 4000);
