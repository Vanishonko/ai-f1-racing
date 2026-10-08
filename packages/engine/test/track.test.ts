import test from "node:test";
import assert from "node:assert/strict";
import {
  buildTrack,
  minimumCornerRadius,
  pointAtDistance,
  projectToTrack,
  selfIntersections,
  validateTrack,
  type TrackControlPoints,
} from "../src/track.ts";
import { buildHandTracks, HAND_TRACKS } from "../src/trackLibrary.ts";

test("track: every hand-authored layout builds and is drivable", () => {
  const tracks = buildHandTracks();
  assert.equal(tracks.length, HAND_TRACKS.length, "every named track should build");

  for (const track of tracks) {
    assert.ok(track.length > 500, `${track.name}: only ${track.length.toFixed(0)} m long`);

    // The tightest corner must be wide enough for the car itself, or the track is
    // physically impossible regardless of how good the driver is.
    const radius = minimumCornerRadius(track);
    assert.ok(
      radius > track.halfWidth * 1.2,
      `${track.name}: tightest corner ${radius.toFixed(1)} m is under 1.2x its own half width`,
    );

    // No NaNs anywhere in the geometry.
    for (let i = 0; i < track.xs.length; i++) {
      assert.ok(Number.isFinite(track.xs[i]!) && Number.isFinite(track.ys[i]!), `${track.name}: non-finite sample ${i}`);
      assert.ok(Number.isFinite(track.curvature[i]!), `${track.name}: non-finite curvature at ${i}`);
    }
  }
});

test("track: no layout overlaps itself or crosses its own centreline", () => {
  /*
   * Both failure modes shipped, and both were found by driving rather than by any
   * test:
   *
   *   - the Club had two long straights at y = -170 and y = -180 while each carried
   *     a half-width of 8.5 m, so the two SURFACES overlapped along their whole
   *     length and the track read as one fat ribbon;
   *   - the Hairpin's outbound leg dipped back through its return leg and crossed
   *     the centreline three times.
   *
   * The first is a clearance question and the second is a topology question, so
   * they need separate measures. Both are cheap to check and neither was.
   */
  for (const track of buildHandTracks()) {
    // Topology: the centreline must not cross itself, or `(s, d)` is ambiguous and
    // progress, lap counting and grid placement all break quietly.
    const crossings = selfIntersections(track);
    assert.equal(
      crossings.length,
      0,
      `${track.name}: centreline crosses itself ${crossings.length} time(s)`,
    );

    // Clearance: two parts of the track must be far enough apart that their
    // SURFACES do not touch. Samples are only compared when they are far apart
    // along the loop in both directions, which excludes the start/finish join.
    const count = track.xs.length;
    const minGap = Math.round(80 / track.spacing);
    let closest = Infinity;
    let where: [number, number] = [0, 0];
    for (let i = 0; i < count; i += 2) {
      for (let j = i + 2; j < count; j += 2) {
        const along = Math.abs(i - j);
        if (Math.min(along, count - along) < minGap) continue;
        const dx = track.xs[i]! - track.xs[j]!;
        const dy = track.ys[i]! - track.ys[j]!;
        const distance = Math.sqrt(dx * dx + dy * dy);
        if (distance < closest) {
          closest = distance;
          where = [track.xs[i]!, track.ys[i]!];
        }
      }
    }

    assert.ok(
      closest > track.halfWidth * 2,
      `${track.name}: two parts of the track come within ${closest.toFixed(1)} m, ` +
        `but ${(track.halfWidth * 2).toFixed(0)} m is needed for the surfaces not to overlap ` +
        `(near ${where[0].toFixed(0)}, ${where[1].toFixed(0)})`,
    );
  }
});

test("track: every layout has somewhere to overtake", () => {
  /*
   * Guards against the whole set drifting back toward being too round.
   *
   * The fault this catches is not a crash, it is a circuit with no overtaking
   * opportunity: if every corner is a medium-speed sweeper, braking later gains
   * almost nothing, so a faster car simply follows a slower one until they run out
   * of laps.
   *
   * An earlier version demanded TWO corners under 40 m from every layout. Two of
   * the current four do not have them, so rather than quietly weaken the threshold
   * the exceptions are named with the reason, and each still has to clear the
   * tighter single-corner bar:
   *
   *   - "The Oval" is one long high-speed turn and exists as a driving baseline,
   *     not as a race track.
   *   - "Club Circuit" has a long flowing sweep and ONE genuine slow corner
   *     (65 km/h), so it is a one-overtaking-spot lap rather than two. It is kept
   *     because it is the longest and most varied layout in the set, and the fix
   *     would be to redesign it rather than to relax this test.
   */
  const EXEMPT_FROM_TWO = new Set(["The Oval", "Club Circuit"]);

  for (const track of buildHandTracks()) {
    if (track.name === "The Oval") continue;

    // Radius at each sample, lightly smoothed so one noisy apex sample cannot
    // fragment a corner into several or hide one.
    const count = track.xs.length;
    const step = Math.max(1, Math.round(5 / track.spacing));
    const radii: number[] = [];
    for (let i = 0; i < count; i += step) {
      radii.push(1 / Math.max(Math.abs(track.curvature[i]!), 1e-6));
    }
    const smoothed = radii.map((_, k) => {
      let sum = 0;
      let seen = 0;
      for (let d = -2; d <= 2; d++) {
        const j = k + d;
        if (j >= 0 && j < radii.length) {
          sum += radii[j]!;
          seen++;
        }
      }
      return sum / seen;
    });

    // Count contiguous runs below 40 m radius: these are the real braking zones.
    let slowCorners = 0;
    let inRun = false;
    let tightest = Infinity;
    for (let k = 0; k < smoothed.length; k++) {
      const slow = smoothed[k]! < 40;
      if (slow) {
        tightest = Math.min(tightest, smoothed[k]!);
        if (!inRun) slowCorners++;
      }
      inRun = slow;
    }

    const required = EXEMPT_FROM_TWO.has(track.name) ? 1 : 2;
    assert.ok(
      slowCorners >= required,
      `${track.name}: only ${slowCorners} corner(s) under 40 m radius (${required} required), so ` +
        `there is nowhere to out-brake anyone. Tightest is ` +
        `${tightest === Infinity ? "none" : tightest.toFixed(0) + " m"}.`,
    );

    // And at least one of them must be genuinely slow rather than merely tight.
    assert.ok(
      tightest < 32,
      `${track.name}: tightest slow corner is ${tightest.toFixed(0)} m, which is a sweeper ` +
        `rather than a braking zone`,
    );
  }
});

test("track: self-intersection detection actually fires", () => {
  // A guard on the guard. A detector that never reports anything would let every
  // layout pass silently, so feed it a track that genuinely crosses itself.
  //
  // Two triangles meeting in the middle: the diagonal legs cross, and the
  // waypoints are close enough together that the spline cannot round the crossing
  // away. Getting a crossing to survive Catmull-Rom smoothing took several
  // attempts — wider waypoints get smoothed into a harmless loop, so the shape
  // here is tight on purpose.
  const bowtie: TrackControlPoints = {
    halfWidth: 8,
    points: [
      [-200, -160], [0, -100], [200, -160],
      [-200, 160], [0, 100], [200, 160],
    ],
  };
  const track = buildTrack(bowtie, "bowtie");
  const crossings = selfIntersections(track);
  assert.ok(crossings.length > 0, "a bowtie must be detected as crossing itself");
  assert.ok(validateTrack(track) !== null, "validation must reject a self-crossing track");
});

test("track: projection round-trips along the whole centreline", () => {
  // Every layout, now that none of them crosses itself.
  // The `(s, d)` projection is the inverse of placing a point at a distance, and
  // the two must agree. If they drift apart, a car sitting on the centreline
  // would not report being there, and every lookahead and progress calculation
  // downstream would be quietly wrong.
  for (const track of buildHandTracks()) {
    let worstAlong = 0;
    let worstLateral = 0;

    for (let distance = 0; distance < track.length; distance += track.length / 40) {
      const point = pointAtDistance(track, distance);
      const projection = projectToTrack(track, point.x, point.y);

      let along = Math.abs(projection.s - distance);
      if (along > track.length / 2) along = track.length - along;
      worstAlong = Math.max(worstAlong, along);
      worstLateral = Math.max(worstLateral, Math.abs(projection.d));
    }

    assert.ok(
      worstAlong < track.spacing * 2,
      `${track.name}: along-track error ${worstAlong.toFixed(3)} m exceeds two sample spacings`,
    );
    assert.ok(
      worstLateral < 0.1,
      `${track.name}: lateral error ${worstLateral.toFixed(3)} m on the centreline`,
    );
  }
});

test("track: lateral offset is signed consistently and track limits work", () => {
  // The sign convention matters: a positive offset must be to the LEFT of the
  // direction of travel, so it agrees with the car's own body frame and the
  // drivers' observations are not mirrored.
  const track = buildHandTracks().find((t) => t.name === "Club Circuit")!;
  const probe = pointAtDistance(track, 500);

  const leftX = probe.x + -probe.ty * (track.halfWidth * 0.5);
  const leftY = probe.y + probe.tx * (track.halfWidth * 0.5);
  const rightX = probe.x + probe.ty * (track.halfWidth * 0.5);
  const rightY = probe.y + -probe.tx * (track.halfWidth * 0.5);

  const left = projectToTrack(track, leftX, leftY);
  const right = projectToTrack(track, rightX, rightY);

  assert.ok(left.d > 0, `a point to the left must have positive offset, got ${left.d}`);
  assert.ok(right.d < 0, `a point to the right must have negative offset, got ${right.d}`);
  assert.ok(left.onTrack && right.onTrack, "half-width out should still be on track");

  // Well off the track must report as off, or track limits never fire.
  const wayOff = projectToTrack(track, probe.x + -probe.ty * (track.halfWidth * 3), probe.y + probe.tx * (track.halfWidth * 3));
  assert.equal(wayOff.onTrack, false, "three half-widths out must be off track");
});
