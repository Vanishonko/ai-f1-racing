/**
 * Track geometry.
 *
 * A track is a closed centreline sampled at uniform arc length, plus a half-width.
 * Everything else — surfaces, boundaries, the visual ribbon, and eventually the
 * observation raycasts — is derived from that one list of samples.
 *
 * Uniform arc-length sampling matters more than it looks: the car's `(s, d)`
 * track position, the grip-noise lookup, and the lookahead curvature samples all
 * index by distance along the track. If samples were spaced by spline parameter
 * instead of distance, a car at constant speed would appear to accelerate and
 * decelerate through the corners.
 *
 * Deterministic: no transcendentals at load beyond the ones baked here once.
 */

import { len } from "./math2d.ts";

export interface TrackControlPoints {
  /** Closed loop of waypoints, in world metres. Not repeated at the end. */
  points: ReadonlyArray<readonly [number, number]>;
  /** Half-width of the drivable surface [m]. */
  halfWidth: number;
}


/**
 * Rebuilds `s` and `length` as CUMULATIVE CHORD LENGTH along the sampled polyline.
 *
 * WHY THIS IS NEEDED. Two different definitions of "distance along the track" had
 * grown up: the hand-placed circuits measured true arc length when resampling by
 * distance, while the designed circuits summed the straight-line steps between
 * samples. On a curved circuit those differ — the chord across a corner is shorter
 * than the arc — so `s[i+1] - s[i]` did not equal the distance between the points
 * that `s` describes, by 0.4 m on the Chicane.
 *
 * Chord length is the one that matters, because the car moves along the sampled
 * polyline, not along the ideal curve. Making every track agree on it means the
 * distance-to-sample lookup, the projection and the lap counter all describe the
 * same path.
 */
const rebuildArcLength = (track: Track): Track => {
  const count = track.xs.length;
  if (count === 0) return track;

  const s = new Float64Array(count);
  let running = 0;
  for (let i = 0; i < count; i++) {
    s[i] = running;
    const next = (i + 1) % count;
    running += len(track.xs[next]! - track.xs[i]!, track.ys[next]! - track.ys[i]!);
  }

  return { ...track, s, length: running, spacing: running / count };
};

export interface Track {
  /** Centreline samples, uniformly spaced by arc length. */
  xs: Float64Array;
  ys: Float64Array;
  /** Cumulative distance along the track at each sample [m]. */
  s: Float64Array;
  /** Unit tangent per sample, pointing in the direction of travel. */
  tx: Float64Array;
  ty: Float64Array;
  /** Signed curvature per sample [1/m], positive turning left. */
  curvature: Float64Array;
  /** Total centreline length [m]. */
  length: number;
  /** Spacing between samples [m]. */
  spacing: number;
  halfWidth: number;
  name: string;
  /**
   * Stable identifier for this circuit, matching its entry in the circuit list.
   *
   * The display name is not usable as a lookup key — it contains spaces and is meant to be
   * human-readable — and anything that crosses a process boundary needs to name a circuit rather
   * than carry it. A worker thread cannot be sent a `Track`, so it is sent this instead.
   */
  key: string;
}

/** Distance between adjacent resampled centreline points [m]. */
const SAMPLE_SPACING = 0.5;

/**
 * Distance over which the tangent is differenced to measure curvature [m].
 *
 * Large enough that genuine curvature dominates coordinate noise, small enough
 * that a real corner is not averaged away. A few metres matches the length scale
 * of the features that matter.
 */
const CURVATURE_SPAN = 4;

/** Moving-average window applied to curvature afterwards [m]. */
const CURVATURE_SMOOTHING = 3;

/** Catmull-Rom basis, evaluated with only + - * / — no transcendentals. */
const catmullRom = (
  p0: number,
  p1: number,
  p2: number,
  p3: number,
  t: number,
): number => {
  const t2 = t * t;
  const t3 = t2 * t;
  return (
    0.5 *
    (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3)
  );
};

/**
 * Builds a track by smoothing the control polygon with a closed Catmull-Rom
 * spline, then resampling the result at uniform arc length.
 *
 * The spline passes through every control point, so the waypoints describe the
 * intended shape directly. Corner sharpness is controlled by how close together
 * the waypoints around a corner are: two points bunched together produce a
 * tighter radius.
 */
export const buildTrack = (
  spec: TrackControlPoints,
  name = "unnamed",
  key = name,
): Track => {
  const points = spec.points;
  const count = points.length;
  if (count < 3) throw new Error("a track needs at least three control points");

  /**
   * First pass: sample the spline densely enough that resampling loses nothing.
   * Fixed subdivisions per span is enough because the control polygon is later
   * resampled by distance anyway.
   */
  const densePerSpan = 64;
  const dense: number[] = [];
  const denseCount = count * densePerSpan;

  for (let span = 0; span < count; span++) {
    const p0 = points[(span - 1 + count) % count]!;
    const p1 = points[span]!;
    const p2 = points[(span + 1) % count]!;
    const p3 = points[(span + 2) % count]!;
    for (let i = 0; i < densePerSpan; i++) {
      const t = i / densePerSpan;
      dense.push(catmullRom(p0[0], p1[0], p2[0], p3[0], t));
      dense.push(catmullRom(p0[1], p1[1], p2[1], p3[1], t));
    }
  }

  // Second pass: measure the dense polyline so it can be resampled by distance.
  const cumulative: number[] = new Array(denseCount + 1);
  cumulative[0] = 0;
  for (let i = 0; i < denseCount; i++) {
    const ax = dense[i * 2]!;
    const ay = dense[i * 2 + 1]!;
    const bx = dense[((i + 1) % denseCount) * 2]!;
    const by = dense[((i + 1) % denseCount) * 2 + 1]!;
    cumulative[i + 1] = cumulative[i]! + len(bx - ax, by - ay);
  }
  const totalLength = cumulative[denseCount]!;
  const samples = Math.max(8, Math.round(totalLength / SAMPLE_SPACING));

  const xs = new Float64Array(samples);
  const ys = new Float64Array(samples);
  const s = new Float64Array(samples);

  // Walk the dense polyline once, emitting a sample every `spacing` metres. A
  // single forward pass keeps this O(n) rather than O(n*m).
  const spacing = totalLength / samples;
  let cursor = 0;
  let denseIndex = 0;
  for (let i = 0; i < samples; i++) {
    const target = i * spacing;
    while (denseIndex < denseCount - 1 && cumulative[denseIndex + 1]! < target) {
      denseIndex++;
    }
    const segStart = cumulative[denseIndex]!;
    const segEnd = cumulative[denseIndex + 1]!;
    const segLength = segEnd - segStart;
    const t = segLength <= 0 ? 0 : (target - segStart) / segLength;

    const ax = dense[denseIndex * 2]!;
    const ay = dense[denseIndex * 2 + 1]!;
    const bi = ((denseIndex + 1) % denseCount) * 2;
    const bx = dense[bi]!;
    const by = dense[bi + 1]!;

    xs[i] = ax + (bx - ax) * t;
    ys[i] = ay + (by - ay) * t;
    s[i] = target;
    cursor = target;
  }
  void cursor;

  /**
   * Third pass: tangents and curvature.
   *
   * Curvature needs care. Taking a central difference of the tangent between
   * ADJACENT samples looks natural and is numerically useless: at 0.5 m spacing
   * the tangent barely rotates between neighbours, so the cross product is
   * swamped by floating-point noise in the coordinates. The noise then divides by
   * a small arc length and produces a huge apparent radius, which is how a
   * 20 m hairpin can measure as a 600 m sweeper.
   *
   * The fix is to difference the tangent over a real distance — several metres —
   * so genuine curvature dominates the noise floor, and to smooth afterwards so a
   * single outlier cannot define the track's tightest corner.
   */
  const spanSamples = Math.max(1, Math.round(CURVATURE_SPAN / spacing));

  const tx = new Float64Array(samples);
  const ty = new Float64Array(samples);
  const curvature = new Float64Array(samples);

  for (let i = 0; i < samples; i++) {
    const prev = (i - 1 + samples) % samples;
    const next = (i + 1) % samples;

    const dx = xs[next]! - xs[prev]!;
    const dy = ys[next]! - ys[prev]!;
    const mag = len(dx, dy);
    tx[i] = mag > 0 ? dx / mag : 1;
    ty[i] = mag > 0 ? dy / mag : 0;
  }

  for (let i = 0; i < samples; i++) {
    const behind = (i - spanSamples + samples * 2) % samples;
    const ahead = (i + spanSamples) % samples;

    // Signed turn between the two tangents. The cross product gives the sine of
    // the turn angle without needing an angle, and the dot product tells us how
    // parallel they are, which is what sets the sign convention below.
    const cross = tx[behind]! * ty[ahead]! - ty[behind]! * tx[ahead]!;
    // The arc length actually spanned by this pair of tangents.
    const arc = spanSamples * spacing * 2;
    curvature[i] = cross / arc;
  }

  // Smooth curvature with a short moving average so the reported minimum radius
  // reflects the corner rather than its noisiest sample.
  const smoothed = new Float64Array(samples);
  const smoothWindow = Math.max(1, Math.round(CURVATURE_SMOOTHING / spacing));
  for (let i = 0; i < samples; i++) {
    let sum = 0;
    for (let k = -smoothWindow; k <= smoothWindow; k++) {
      sum += curvature[((i + k) % samples + samples) % samples]!;
    }
    smoothed[i] = sum / (smoothWindow * 2 + 1);
  }

  // Arc length is rebuilt from the emitted samples so that every circuit shares one
  // definition of distance along the track. See `rebuildArcLength`.
  return rebuildArcLength({
    xs,
    ys,
    s,
    tx,
    ty,
    curvature: smoothed,
    length: totalLength,
    spacing,
    halfWidth: spec.halfWidth,
    name,
    key,
  });
};

/**
 * The sample index containing a given distance along the track, wrapping.
 *
 * Uses a truncating division rather than a modulo so a negative or very large
 * distance still lands in range.
 */
/**
 * Distances at which to place corner checkpoints: entry, apex and exit for every corner.
 *
 * WHY CORNERS RATHER THAN EVEN SPACING. A lap is won and lost in the corners, and a checkpoint is a
 * place the reward is measured. Spacing them evenly spends most of them on straights, where the
 * fastest thing to do is also the easiest, and gives the hardest part of the lap the same attention
 * as the easiest.
 *
 * Placing them at the three points that define a corner means the reward is measured where the skill
 * is: how fast the car arrives, how fast it turns, and how early it gets back on the power. Braking
 * and line discipline then emerge because they are what raises those three numbers.
 *
 * `curvatureThreshold` is in inverse metres, so a larger value finds only tighter corners.
 */
export const cornerCheckpoints = (
  track: Track,
  apexesPerCorner = 3,
  curvatureThreshold = 0.004,
): number[] => {
  const found: number[] = [];
  const samples = track.curvature.length;
  if (samples === 0) return found;
  const spacing = track.length / samples;

  let inCorner = false;
  let entry = 0;
  let apex = 0;
  let peak = 0;

  const close = (exit: number): void => {
    /*
     * APEX FIRST, and that ordering is not arbitrary.
     *
     * The apex is where curvature is greatest — the point of a corner rather than its midpoint, which
     * on an asymmetric corner is somewhere else entirely, and it is the point that decides how fast
     * the corner can be taken. So it is always included.
     *
     * The ENTRY is included only when it is strictly inside the lap. The pit straight runs from the
     * start line into the first corner, so the first corner's entry sits AT distance zero — and a
     * checkpoint at distance zero is awarded the instant a run begins, for no driving at all, on every
     * lap. Measured: it fired at t=0.0 s of every run. Offsetting it by a metre would be a fudge;
     * leaving it out is the honest version, because there is nothing to measure there.
     */
    const from = entry * spacing;
    const middle = apex * spacing;
    const to = exit * spacing;
    if (apexesPerCorner >= 2 && from > 1) found.push(from);
    found.push(middle);
    if (apexesPerCorner >= 3 && to > 1) found.push(to);
  };

  for (let i = 0; i < samples; i++) {
    const curvature = Math.abs(track.curvature[i] ?? 0);
    if (curvature > curvatureThreshold) {
      if (!inCorner) {
        inCorner = true;
        entry = i;
        apex = i;
        peak = curvature;
      } else if (curvature > peak) {
        peak = curvature;
        apex = i;
      }
    } else if (inCorner) {
      inCorner = false;
      close(i);
    }
  }
  // A corner still open at the last sample wraps past the start line and must still be recorded.
  if (inCorner) close(samples - 1);

  /*
   * Sorted so the order follows the lap, and de-duplicated so a very short corner does not produce
   * the same point three times.
   *
   * ANYTHING AT THE START LINE IS THEN DROPPED, whoever contributed it. The club circuit genuinely
   * has its first apex at distance zero, so filtering by which point it was — entry or apex — is not
   * enough: a checkpoint there is collected the instant a run begins, for no driving at all, on every
   * lap. Measured, it fired at t=0.0 s. The honest fix is positional.
   */
  found.sort((a, b) => a - b);
  const deduped = found.filter((value, index) => index === 0 || value - found[index - 1]! > 1);
  return deduped.filter((value) => value > 1);
};

/**
 * The sample index containing a given distance along the track.
 *
 * Exported because tools outside the simulation need to look up track properties by distance —
 * curvature ahead of a car, for instance — and reimplementing the arc-length search elsewhere
 * would be a second place for it to be wrong.
 */
export const sampleIndexAt = (track: Track, distance: number): number => {
  const count = track.s.length;
  if (count === 0) return 0;

  const total = track.length;
  let target = distance % total;
  if (target < 0) target += total;

  /*
   * BINARY SEARCH over the track's own arc-length array, NOT `distance / spacing`.
   *
   * The samples are NOT evenly spaced: the walker emits straight sections at a
   * ~0.5 m stride but arcs at the chord length for their angle and radius, which on
   * Spa ranges from 0.5 m to 6.6 m. Dividing by the AVERAGE spacing (0.5559 there)
   * therefore lands progressively further behind — a 10% lag that reached 162 m by
   * the far side of the lap and made a car's reported position nonsense.
   *
   * `track.s` holds exact cumulative arc length, so searching it is exact by
   * construction and costs a dozen comparisons.
   */
  let low = 0;
  let high = count - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (track.s[mid]! <= target) low = mid;
    else high = mid - 1;
  }
  return low;
};

export interface TrackPoint {
  x: number;
  y: number;
  /** Unit tangent at this point. */
  tx: number;
  ty: number;
}

/**
 * World position at a distance along the centreline, interpolated between samples.
 *
 * This is the inverse of the `(s, d)` projection the cars will use, and the two
 * must agree, or a car placed on the centreline would not report being there.
 */
export const pointAtDistance = (track: Track, distance: number): TrackPoint => {
  const count = track.s.length;
  const total = track.length;

  let target = distance % total;
  if (target < 0) target += total;

  // Binary search on exact arc length, NOT `distance / spacing`.
  //
  // The samples are not evenly spaced — the walker emits arcs at a different stride
  // from straights — so dividing by an average spacing lands on the wrong sample and
  // then interpolates within it. On Spa that put a point 5 m along a straight at the
  // position of a sample 10 places earlier, and the error grew with distance.
  const index = sampleIndexAt(track, target);
  const next = (index + 1) % count;
  const span = (next === 0 ? total : track.s[next]!) - track.s[index]!;
  const t = span > 1e-9 ? (target - track.s[index]!) / span : 0;

  return {
    x: track.xs[index]! + (track.xs[next]! - track.xs[index]!) * t,
    y: track.ys[index]! + (track.ys[next]! - track.ys[index]!) * t,
    tx: track.tx[index]! + (track.tx[next]! - track.tx[index]!) * t,
    ty: track.ty[index]! + (track.ty[next]! - track.ty[index]!) * t,
  };
};

/**
 * Nearest centreline sample to a world point, by exhaustive search.
 *
 * GLOBAL nearest, which is right for placing a car freshly on a track and WRONG for
 * tracking one already driving it — see `projectToTrackNear`. Use this only when
 * there is no previous position to go on.
 *
 * O(n) and correct; a spatial grid would make it O(1) and is what the observation
 * raycasts will need. Kept honest here rather than pretended at.
 */
const nearestSample = (track: Track, x: number, y: number): number => {
  let best = 0;
  let bestDistance = Infinity;
  for (let i = 0; i < track.xs.length; i++) {
    const dx = x - track.xs[i]!;
    const dy = y - track.ys[i]!;
    const d = dx * dx + dy * dy;
    if (d < bestDistance) {
      bestDistance = d;
      best = i;
    }
  }
  return best;
};

/**
 * Projects a point onto the track, searching only near a known previous position.
 *
 * THE PROBLEM THIS SOLVES. A track need not self-cross to have an ambiguous
 * projection: a circuit with long straights that fold back close to themselves —
 * which is most real ones, and certainly Spa — has places where the globally
 * nearest centreline sample lies on a DIFFERENT part of the lap. Projecting Spa's
 * midpoint found the nearest sample 157 m away along the track, which would put a
 * car in the wrong place, break its lap distance, and corrupt every lookahead
 * sample derived from it.
 *
 * Searching a bounded window around `previousS` resolves this exactly as it is
 * resolved on a real car: the position is known to be continuous, so where it was
 * last tick is a far better constraint than global proximity. Anything further away
 * than the window is not considered at all.
 *
 * @param previousS distance along the track from the last tick
 * @param windowM how far the car could plausibly have moved, plus margin
 */
export const projectToTrackNear = (
  track: Track,
  x: number,
  y: number,
  previousS: number,
  windowM = 40,
): Projection => {
  const count = t_sCount(track);

  /*
   * SEARCH OUTWARD FROM THE PREVIOUS POSITION, on both sides, and take the nearest
   * sample found — but only samples within the reach.
   *
   * Walking forward only is not enough. The true nearest sample is sometimes BEHIND
   * the sample the previous position sat on, and a forward-only walk cannot reach it:
   * it comes to rest a little ahead every tick, and the error compounds until the
   * reported position jumps half a lap. Measured at 3,488 m on Spa, which is almost
   * exactly half its length.
   *
   * Searching both ways from the exact previous sample, and taking the minimum over
   * the whole reach, keeps the result anchored: it can only ever be `reach` samples
   * from where the car was, so it cannot hop to the far side of a fold.
   */
  const start = sampleIndexAt(track, previousS);
  const reach = Math.max(8, Math.ceil(windowM / Math.max(track.spacing, 1e-3)));

  let best = start;
  let bestDistance = Infinity;
  for (let offset = -reach; offset <= reach; offset++) {
    const i = ((start + offset) % count + count) % count;
    const dx = x - track.xs[i]!;
    const dy = y - track.ys[i]!;
    const distance = dx * dx + dy * dy;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = i;
    }
  }

  /*
   * Refine within the local CHORD, not along the tangent.
   *
   * Extrapolating along the sample's tangent is only valid while the track is
   * straight over the offset concerned. In Spa's 150-degree hairpin the tangent
   * swings round far faster than that, so a point on the corner projected to a
   * lateral offset of -44 m on a track 9.5 m wide. Projecting onto the chord between
   * two adjacent samples and clamping to it cannot do that: the samples are half a
   * metre apart, so the answer is confined to half a metre of track by construction.
   */
  const next = (best + 1) % count;
  const ax = track.xs[best]!;
  const ay = track.ys[best]!;
  const bx = track.xs[next]!;
  const by = track.ys[next]!;
  const ex = bx - ax;
  const ey = by - ay;
  const segment = ex * ex + ey * ey;

  let fraction = 0;
  if (segment > 1e-12) {
    fraction = ((x - ax) * ex + (y - ay) * ey) / segment;
    if (fraction < 0) fraction = 0;
    else if (fraction > 1) fraction = 1;
  }

  const px = ax + ex * fraction;
  const py = ay + ey * fraction;
  const tx = track.tx[best]!;
  const ty = track.ty[best]!;
  const lateral = (x - px) * -ty + (y - py) * tx;
  const span = (next === 0 ? track.length : track.s[next]!) - track.s[best]!;

  return {
    s: track.s[best]! + span * fraction,
    d: lateral,
    tangentX: tx,
    tangentY: ty,
    onTrack: Math.abs(lateral) <= track.halfWidth,
  };
};

const t_sCount = (track: Track): number => track.xs.length;

export interface Projection {
  /** Distance along the track [m]. */
  s: number;
  /** Signed lateral offset from the centreline, positive to the left [m]. */
  d: number;
  /**
   * Unit tangent of the centreline at the projection.
   *
   * This is a direction, not an angle, and deliberately so: every consumer here needs the
   * relative angle between the car and the track, and that is available directly from the
   * two directions without ever forming an angle. An `atan2` per projection would be a
   * banned transcendental on a hot path.
   */
  tangentX: number;
  tangentY: number;
  /** True when the point is within the drivable half-width. */
  onTrack: boolean;
}

/**
 * Projects a world point onto the track, giving its `(s, d)` coordinates.
 *
 * Signed lateral offset is positive to the LEFT of the direction of travel, which
 * matches the body frame convention, so a car's lateral offset and its body-frame
 * lateral velocity have consistent signs.
 */
export const projectToTrack = (track: Track, x: number, y: number): Projection => {
  const index = nearestSample(track, x, y);
  const px = track.xs[index]!;
  const py = track.ys[index]!;
  const tx = track.tx[index]!;
  const ty = track.ty[index]!;

  const dx = x - px;
  const dy = y - py;

  // Positive when the point lies to the left of the tangent, which in this
  // right-handed frame is the cross product with the left normal (-ty, tx).
  const lateral = dx * -ty + dy * tx;
  const along = dx * tx + dy * ty;

  return {
    s: track.s[index]! + along,
    d: lateral,
    tangentX: tx,
    tangentY: ty,
    onTrack: Math.abs(lateral) <= track.halfWidth,
  };
};

/**
 * Approximate radius of the tightest corner on the track [m].
 *
 * Curvature is smoothed before taking the maximum, because a single noisy sample
 * would otherwise report a hairpin tighter than the track actually has, and this
 * value gates whether a generated track is physically drivable at all.
 */
export const minimumCornerRadius = (track: Track): number => {
  const count = track.curvature.length;
  const window = Math.max(1, Math.round(10 / track.spacing));
  let peak = 0;
  for (let i = 0; i < count; i++) {
    let sum = 0;
    for (let k = -window; k <= window; k++) {
      sum += Math.abs(track.curvature[((i + k) % count + count) % count]!);
    }
    const average = sum / (window * 2 + 1);
    if (average > peak) peak = average;
  }
  return peak > 1e-9 ? 1 / peak : Infinity;
};

/**
 * Counts places where the centreline crosses itself.
 *
 * A track that crosses itself is not merely ugly: the car's `(s, d)` projection
 * becomes ambiguous at the crossing, so two different points on the surface claim
 * the same track position and the drivers' progress, lap counting and grid
 * placement all quietly break.
 *
 * This is easy to produce by accident. A hairpin whose two legs are closer
 * together than twice the turn radius folds back through itself, and a rounded
 * rectangle whose corner arcs are not tangent to the adjoining edges cuts straight
 * across the middle of the circuit. Both happened while building this library, and
 * both looked entirely plausible as a list of points.
 *
 * Segments closer than `minGap` samples apart along the loop are skipped, since
 * adjacent segments always share an endpoint and would otherwise count.
 */
export const selfIntersections = (track: Track, minGapMeters = 12): Array<[number, number]> => {
  const count = track.xs.length;
  const step = Math.max(1, Math.round(minGapMeters / track.spacing));
  const samples: number[] = [];
  for (let i = 0; i < count; i += step) samples.push(i);

  const segmentsCross = (
    ax: number, ay: number, bx: number, by: number,
    cx: number, cy: number, dx: number, dy: number,
  ): boolean => {
    const r1 = bx - ax, r2 = by - ay;
    const s1 = dx - cx, s2 = dy - cy;
    const denominator = r1 * s2 - r2 * s1;
    if (denominator > -1e-12 && denominator < 1e-12) return false;
    const u = ((cx - ax) * s2 - (cy - ay) * s1) / denominator;
    const v = ((cx - ax) * r2 - (cy - ay) * r1) / denominator;
    // Strictly interior, so segments meeting end to end are not reported.
    return u > 1e-9 && u < 1 - 1e-9 && v > 1e-9 && v < 1 - 1e-9;
  };

  const found: Array<[number, number]> = [];
  for (let a = 0; a < samples.length; a++) {
    for (let b = a + 1; b < samples.length; b++) {
      const i = samples[a]!;
      const j = samples[b]!;
      const gap = Math.min(Math.abs(i - j), count - Math.abs(i - j));
      if (gap < step * 3) continue;
      const i2 = (i + step) % count;
      const j2 = (j + step) % count;
      if (
        segmentsCross(
          track.xs[i]!, track.ys[i]!, track.xs[i2]!, track.ys[i2]!,
          track.xs[j]!, track.ys[j]!, track.xs[j2]!, track.ys[j2]!,
        )
      ) {
        found.push([track.s[i]!, track.s[j]!]);
      }
    }
  }
  return found;
};

/** Checks a track for the failures that make it undrivable or ambiguous. */
export const validateTrack = (track: Track): string | null => {
  if (track.length < 200) return `track is too short (${track.length.toFixed(0)} m)`;
  const radius = minimumCornerRadius(track);
  if (radius < track.halfWidth * 1.2) {
    return `tightest corner radius ${radius.toFixed(1)} m is under 1.2x half width`;
  }
  const crossings = selfIntersections(track);
  if (crossings.length > 0) {
    const [a, b] = crossings[0]!;
    return `centreline crosses itself (${crossings.length} time(s)), first near ` +
      `s=${a.toFixed(0)} m and s=${b.toFixed(0)} m`;
  }
  for (let i = 0; i < track.xs.length; i++) {
    if (!Number.isFinite(track.xs[i]!) || !Number.isFinite(track.ys[i]!)) {
      return `non-finite centreline sample at index ${i}`;
    }
  }
  return null;
};

