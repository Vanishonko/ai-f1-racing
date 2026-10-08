/**
 * Designing a circuit from corner types.
 *
 * THE PROBLEM, and why the obvious approaches all failed. A track must return to
 * its starting point with its starting heading. Getting the heading right is easy
 * — the turn angles just have to sum to a whole number of full turns. Getting the
 * POSITION right is what killed every hand-placed attempt in this project: the
 * straights have to be the right lengths, and those lengths are not inspectable.
 *
 * Two attempted solutions and why they were both abandoned:
 *
 *   1. Place points and hope. Produced layouts that failed to close, folded back
 *      through themselves, or both. Roughly twenty attempts, nearly all broken.
 *   2. A closed-form polygon identity. It closed a square exactly, which made it
 *      look correct, and was 0.7 m wrong on an irregular quadrilateral — precisely
 *      the case that matters. A formula that is right for the one case you test
 *      first is worse than no formula.
 *
 * What works: fix the ANGLES, which are the design decision, and SOLVE for the
 * straight lengths. With angles fixed the endpoint is affine in each length —
 * moving a straight by dL moves the endpoint by dL along the heading there — so
 * each length can be solved in closed form in turn, and coordinate descent over a
 * handful of straights converges to exactly zero. No search, no tolerance games.
 *
 * This module runs at LOAD time to produce a circuit and is never executed inside a
 * physics tick, so it uses the ordinary maths library rather than the engine's
 * baked tables. It is listed as an explicit exemption in the determinism linter,
 * with that reason, because the rationale differs from the baking files: those fix
 * their values once, this simply never runs during simulation.
 *
 * The result is that CORNER SPEED AND CORNER ANGLE BECOME INPUTS. A 90 km/h corner
 * is a 90 km/h corner by construction, not something to be measured afterwards and
 * hoped for.
 *
 * WHAT THIS DOES NOT DO, learned by exhausting it. Solving closure does not imply a
 * valid SHAPE. A closed polygon whose straights are unequal wraps around itself and
 * crosses its own centreline; a deliberate design with good angles and sensible
 * radii still crossed at every corner scale tried, and scaling the radii cannot fix
 * it because the angles determine the shape and the radii only determine how
 * tightly the path turns through it. Roughly sixty thousand generated designs were
 * tried across this work; the ones that closed and did not cross were never also
 * well proportioned. The solver here is correct and worth keeping as a tool; using
 * it to SEARCH for circuits is not a solved problem and should not be attempted
 * again without a different idea.
 */

export interface Corner {
  /** Angle turned, in degrees. Positive is counter-clockwise. */
  degrees: number;
  /** Corner radius in metres. Sets the corner speed directly. */
  radius: number;
}

/** Radius that gives a chosen corner speed, for this car's grip. */
export const radiusForSpeed = (kph: number): number => (kph / 3.6) ** 2 / (1.55 * 9.81);

/** A corner of a chosen angle and speed, in the terms a driver would use. */
export const corner = (degrees: number, kph: number): Corner => ({
  degrees,
  radius: radiusForSpeed(kph),
});

const toRad = (degrees: number): number => (degrees * Math.PI) / 180;

/**
 * Where a turn of `degrees` at `radius` puts the car, in the frame it starts in.
 *
 *     (R sin t, R (1 - cos t))
 *
 * A turn is NOT an instantaneous rotation, and treating it as one is what made an
 * earlier solver report exact closure while the real walk was 200 m adrift: the arc
 * carries the car forward as well as round, and that forward component has to be
 * composed in.
 */
const turnDisplacement = (degrees: number, radius: number): { x: number; y: number } => {
  const t = toRad(degrees);
  return { x: radius * Math.sin(t), y: radius * (1 - Math.cos(t)) };
};

/** Endpoint of a design walked through its real arc geometry. */
const endpointOf = (
  corners: readonly Corner[],
  lengths: readonly number[],
): { x: number; y: number } => {
  let heading = 0;
  let x = 0;
  let y = 0;
  for (let i = 0; i < corners.length; i++) {
    x += Math.cos(heading) * lengths[i]!;
    y += Math.sin(heading) * lengths[i]!;

    const d = turnDisplacement(corners[i]!.degrees, corners[i]!.radius);
    const cos = Math.cos(heading);
    const sin = Math.sin(heading);
    x += d.x * cos - d.y * sin;
    y += d.x * sin + d.y * cos;
    heading += toRad(corners[i]!.degrees);
  }
  return { x, y };
};

const headingBefore = (corners: readonly Corner[], index: number): number => {
  let heading = 0;
  for (let i = 0; i < index; i++) heading += toRad(corners[i]!.degrees);
  return heading;
};

export interface SolvedDesign {
  name: string;
  halfWidth: number;
  corners: Corner[];
  straights: number[];
  /** Distance between the loop's end and its start. Zero means it closes. */
  closureError: number;
}

export interface DesignSpec {
  name: string;
  halfWidth: number;
  corners: Corner[];
  /**
   * Preferred straight lengths, in the order driven. These are BIASES, not
   * commands: the solver moves them as far as it must to close the loop, so a
   * wanted long straight is a request rather than a guarantee.
   */
  preferredStraights?: number[];
}

/**
 * Solves a design's straight lengths so the loop closes.
 *
 * @param minStraight shortest straight the solver may produce. Zero-length
 *        straights are geometrically legal but produce a track that changes
 *        direction instantly, so they are suppressed.
 */
export const solveDesign = (
  spec: DesignSpec,
  minStraight = 55,
  sweeps = 400,
): SolvedDesign | null => {
  const corners = spec.corners;
  const count = corners.length;
  if (count < 3) return null;

  const total = corners.reduce((sum, c) => sum + c.degrees, 0);
  const turns = total / 360;
  if (Math.abs(turns - Math.round(turns)) > 1e-6) return null;

  const preferred = spec.preferredStraights ?? corners.map(() => 200);
  if (preferred.length !== count) return null;

  const lengths = preferred.map((v) => Math.max(minStraight, v));

  // Coordinate descent. Each step solves one length exactly, because the endpoint
  // is affine in it: with that straight removed the endpoint is some point `a`,
  // and the best length is the projection of `-a` onto the heading there.
  for (let sweep = 0; sweep < sweeps; sweep++) {
    for (let i = 0; i < count; i++) {
      const heading = headingBefore(corners, i);
      const ux = Math.cos(heading);
      const uy = Math.sin(heading);

      const saved = lengths[i]!;
      lengths[i] = 0;
      const a = endpointOf(corners, lengths);
      const solved = -(a.x * ux + a.y * uy);
      lengths[i] = solved > minStraight ? solved : saved * 0.999;
      if (lengths[i]! < minStraight) lengths[i] = minStraight;
    }
  }

  const error = endpointOf(corners, lengths);

  return {
    name: spec.name,
    halfWidth: spec.halfWidth,
    corners,
    straights: lengths,
    closureError: Math.sqrt(error.x * error.x + error.y * error.y),
  };
};

/** Expands a solved design into the flat walk the track builder consumes. */
export const toWalk = (
  design: SolvedDesign,
): Array<{ kind: "straight"; length: number } | { kind: "turn"; radius: number; degrees: number }> => {
  const steps: Array<
    { kind: "straight"; length: number } | { kind: "turn"; radius: number; degrees: number }
  > = [];
  for (let i = 0; i < design.corners.length; i++) {
    const c = design.corners[i]!;
    steps.push({ kind: "straight", length: design.straights[i]! });
    steps.push({ kind: "turn", radius: c.radius, degrees: c.degrees });
  }
  return steps;
};

export interface DesignMetrics {
  length: number;
  /** Corner speeds in the order driven, km/h. */
  cornerSpeeds: number[];
  /** Straight lengths in the order driven, metres. */
  straights: number[];
  /** For each corner, the length of the straight leading into it. */
  approachLengths: number[];
  slowCorners: number;
  fastCorners: number;
  minLength: number;
  maxLength: number;
  longestStraight: number;
}

const kphForRadius = (radius: number): number => Math.sqrt(1.55 * 9.81 * radius) * 3.6;

/** Measures a solved design, so its character can be checked rather than assumed. */
export const measureDesign = (design: SolvedDesign): DesignMetrics => {
  const cornerSpeeds = design.corners.map((c) => kphForRadius(c.radius));
  const arcLength = design.corners.reduce(
    (sum, c) => sum + Math.abs(toRad(c.degrees)) * c.radius,
    0,
  );
  const straightTotal = design.straights.reduce((sum, v) => sum + v, 0);

  return {
    length: arcLength + straightTotal,
    cornerSpeeds,
    straights: design.straights.slice(),
    // The straight before corner i is the one at the same index, because the walk
    // emits straight-then-corner.
    approachLengths: design.straights.slice(),
    slowCorners: cornerSpeeds.filter((s) => s < 100).length,
    fastCorners: cornerSpeeds.filter((s) => s > 150).length,
    minLength: Math.min(...straightTotal > 0 ? design.straights : [0]),
    maxLength: Math.max(...(straightTotal > 0 ? design.straights : [0])),
    longestStraight: Math.max(...(straightTotal > 0 ? design.straights : [0])),
  };
};
