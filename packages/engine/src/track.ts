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

import { clamp, len } from "./math2d.ts";

export interface TrackControlPoints {
  /** Closed loop of waypoints, in world metres. Not repeated at the end. */
  points: ReadonlyArray<readonly [number, number]>;
  /** Half-width of the drivable surface [m]. */
  halfWidth: number;
}

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

  return {
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
  };
};

/**
 * The sample index containing a given distance along the track, wrapping.
 *
 * Uses a truncating division rather than a modulo so a negative or very large
 * distance still lands in range.
 */
export const sampleIndexAt = (track: Track, distance: number): number => {
  const raw = Math.floor(distance / track.spacing);
  const count = track.s.length;
  const wrapped = raw % count;
  return wrapped < 0 ? wrapped + count : wrapped;
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
  const spacing = track.spacing;
  const raw = distance / spacing;
  const index = Math.floor(raw);
  const wrapped = ((index % count) + count) % count;
  const next = (wrapped + 1) % count;
  const t = raw - Math.floor(raw);

  return {
    x: track.xs[wrapped]! + (track.xs[next]! - track.xs[wrapped]!) * t,
    y: track.ys[wrapped]! + (track.ys[next]! - track.ys[wrapped]!) * t,
    tx: track.tx[wrapped]! + (track.tx[next]! - track.tx[wrapped]!) * t,
    ty: track.ty[wrapped]! + (track.ty[next]! - track.ty[wrapped]!) * t,
  };
};

/**
 * Nearest centreline sample to a world point, by exhaustive search.
 *
 * Placeholder: correct but O(n). The real implementation walks a spatial grid
 * built at track load, which is O(1) and is what the observation raycasts will
 * need. Kept honest here rather than pretended at.
 */
export const nearestSample = (track: Track, x: number, y: number): number => {
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

export interface Projection {
  /** Distance along the track [m]. */
  s: number;
  /** Signed lateral offset from the centreline, positive to the left [m]. */
  d: number;
  /** Heading of the centreline at the projection, for computing relative angle. */
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

/** Half-width, exposed for callers that only have the spec. */
export const halfWidthOf = (spec: TrackControlPoints): number => clamp(spec.halfWidth, 3, 20);
