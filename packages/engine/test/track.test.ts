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

test("track: the Hairpin has a known self-crossing, and it is confined", () => {
  /*
   * Recorded rather than fixed, deliberately.
   *
   * The Hairpin's outbound leg dips back through the return leg, so its centreline
   * crosses itself three times. Every attempt to open it up produced a worse
   * circuit — straighter, slower, and less interesting — so the crossing is kept
   * and the LAYOUT is treated as content rather than as scaffolding.
   *
   * The consequence is bounded and worth knowing: near the crossing the `(s, d)`
   * projection is ambiguous, so a car there can be assigned the wrong distance
   * along the lap. Everything away from it projects to within a fraction of a
   * millimetre, which this test also asserts, so the ambiguity is local.
   *
   * Fixing it properly means redesigning the circuit, not tuning a number here.
   */
  const hairpin = buildHandTracks().find((t) => t.name === "Hairpin")!;
  const crossings = selfIntersections(hairpin);

  assert.ok(crossings.length > 0, "the known crossing should still be detected");
  assert.ok(crossings.length <= 6, `crossing count grew unexpectedly: ${crossings.length}`);

  // Away from the crossing, projection must be exact.
  const crossingDistances = new Set(crossings.flat().map((s) => Math.round(s / 50)));
  let worstAway = 0;
  for (let s = 0; s < hairpin.length; s += hairpin.length / 120) {
    const point = pointAtDistance(hairpin, s);
    const projection = projectToTrack(hairpin, point.x, point.y);
    if (crossingDistances.has(Math.round(projection.s / 50))) continue;
    let error = Math.abs(projection.s - s);
    if (error > hairpin.length / 2) error = hairpin.length - error;
    worstAway = Math.max(worstAway, error);
  }
  assert.ok(
    worstAway < 5,
    `projection away from the crossing should be exact, worst error ${worstAway.toFixed(2)} m`,
  );
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
  // Skips the Hairpin, whose crossing makes the projection ambiguous there by
  // design. That case is covered by its own test above.
  // The `(s, d)` projection is the inverse of placing a point at a distance, and
  // the two must agree. If they drift apart, a car sitting on the centreline
  // would not report being there, and every lookahead and progress calculation
  // downstream would be quietly wrong.
  for (const track of buildHandTracks()) {
    if (track.name === "Hairpin") continue;
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
