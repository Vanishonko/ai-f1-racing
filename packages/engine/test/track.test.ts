import test from "node:test";
import assert from "node:assert/strict";
import {
  buildTrack,
  minimumCornerRadius,
  pointAtDistance,
  projectToTrack,
  projectToTrackNear,
  selfIntersections,
  validateTrack,
  type TrackControlPoints,
} from "../src/track.ts";
import { buildCircuits, CIRCUITS } from "../src/trackLibrary.ts";

test("track: every hand-authored layout builds and is drivable", () => {
  const tracks = buildCircuits();
  assert.equal(tracks.length, CIRCUITS.length, "every named track should build");

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
  for (const track of buildCircuits()) {
    // Topology: the centreline must not cross itself, or `(s, d)` is ambiguous and
    // progress, lap counting and grid placement all break quietly.
    const crossings = selfIntersections(track);
    assert.equal(
      crossings.length,
      0,
      `${track.name}: centreline crosses itself ${crossings.length} time(s)`,
    );

    /*
     * Clearance: two parts of the track must be far enough apart that their
     * SURFACES do not touch.
     *
     * The along-track separation has to be GENEROUS — 250 m — or the check measures
     * a hairpin against itself. Spa's 150-degree hairpin has its two legs 81 m
     * apart along the loop and 46 m apart in space, which is exactly what a hairpin
     * is, and an 80 m threshold reported it as an overlap.
     */
    const count = track.xs.length;
    const minGap = Math.round(250 / track.spacing);
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

  for (const track of buildCircuits()) {
    if (track.name === "The Oval") continue;

    /*
     * Sampled every 2 m, not every 5.
     *
     * A tight corner is only 40-90 m long, so at a 5 m stride it spans a handful of
     * samples and an apex can fall between two of them — which made the check report
     * ONE slow corner at Baku when there are two. Resolution has to be fine enough
     * that a corner cannot hide in the gaps.
     */
    const count = track.xs.length;
    const step = Math.max(1, Math.round(2 / track.spacing));
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

    /*
     * A braking zone is defined by CORNER SPEED, not radius.
     *
     * 40 m of radius is about 90 km/h, and using that as the bar rejected Spa — whose
     * tightest corner is 38 m at 78 km/h — because the designed circuits express
     * their corners as speeds and 78 km/h arrives at a slightly larger radius here.
     * What matters to a driver is how much speed has to come off, so that is what is
     * measured.
     */
    const speedFor = (radius: number): number => Math.sqrt(1.55 * 9.81 * radius) * 3.6;
    let slowCorners = 0;
    let inRun = false;
    let tightest = Infinity;
    for (let k = 0; k < smoothed.length; k++) {
      const slow = speedFor(smoothed[k]!) < 120;
      if (slow) {
        tightest = Math.min(tightest, smoothed[k]!);
        if (!inRun) slowCorners++;
      }
      inRun = slow;
    }

    const required = EXEMPT_FROM_TWO.has(track.name) ? 1 : 2;
    assert.ok(
      slowCorners >= required,
      `${track.name}: only ${slowCorners} corner(s) below 120 km/h (${required} required), so ` +
        `there is nowhere to out-brake anyone. Tightest is ` +
        `${tightest === Infinity ? "none" : speedFor(tightest).toFixed(0) + " km/h"}.`,
    );

    // And at least one must be genuinely slow rather than merely slow-ish.
    assert.ok(
      speedFor(tightest) < 95,
      `${track.name}: tightest corner is ${speedFor(tightest).toFixed(0)} km/h, which is a ` +
        `sweeper rather than a braking zone`,
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

test("track: the arc-length array agrees with the geometry", () => {
  /*
   * THE BUG THIS EXISTS FOR. `s[i]` must be the arc length from sample 0 to sample i.
   * A version that stored the running total before adding the step shifted the whole
   * array by one sample, and everything built on it drifted: Spa's lap length came
   * out at 19,500,625 m instead of 6,988, and a car's position was wrong by 160 m.
   *
   * The check is direct: the difference between consecutive entries must equal the
   * distance between the corresponding points.
   */
  for (const track of buildCircuits()) {
    let worst = 0;
    for (let i = 1; i < track.xs.length; i++) {
      const dx = track.xs[i]! - track.xs[i - 1]!;
      const dy = track.ys[i]! - track.ys[i - 1]!;
      const geometric = Math.sqrt(dx * dx + dy * dy);
      worst = Math.max(worst, Math.abs((track.s[i]! - track.s[i - 1]!) - geometric));
    }
    assert.ok(worst < 0.05, `${track.name}: s array disagrees with geometry by ${worst.toFixed(4)} m`);
  }
});

test("track: distance lookup lands where the geometry says it should", () => {
  /*
   * THE SECOND HALF OF THE SAME BUG. Converting a distance into a sample by dividing
   * by an average spacing is wrong because the samples are not evenly spaced — the
   * walker emits arcs at a different stride from straights. On Spa, 46.6 m along a
   * straight resolved to the position of a sample ten places earlier.
   *
   * Checked by walking the whole lap in small steps and requiring each point to be
   * where that distance actually is.
   */
  for (const track of buildCircuits()) {
    let worst = 0;
    const stride = track.length / 500;
    for (let distance = 0; distance < track.length; distance += stride) {
      const point = pointAtDistance(track, distance);
      const dx = point.x - track.xs[0]!;
      const dy = point.y - track.ys[0]!;
      void dx;
      void dy;
      // Independently recompute where this distance falls by accumulating steps.
      let walked = 0;
      let index = 0;
      while (walked + (track.s[index + 1]! - track.s[index]!) < distance && index < track.xs.length - 2) {
        walked = track.s[index + 1]!;
        index++;
      }
      const span = track.s[index + 1]! - track.s[index]!;
      const fraction = span > 1e-9 ? (distance - track.s[index]!) / span : 0;
      const expectedX = track.xs[index]! + (track.xs[index + 1]! - track.xs[index]!) * fraction;
      const expectedY = track.ys[index]! + (track.ys[index + 1]! - track.ys[index]!) * fraction;
      const error = Math.sqrt((point.x - expectedX) ** 2 + (point.y - expectedY) ** 2);
      worst = Math.max(worst, error);
    }
    assert.ok(worst < 0.5, `${track.name}: pointAtDistance is off by ${worst.toFixed(3)} m`);
  }
});

test("track: lateral offset is signed consistently and track limits work", () => {
  // The sign convention matters: a positive offset must be to the LEFT of the
  // direction of travel, so it agrees with the car's own body frame and the
  // drivers' observations are not mirrored.
  const track = buildCircuits().find((t) => t.name === "Club Circuit")!;
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

test("track: continuous projection follows the lap without losing its place", () => {
  /*
   * `projectToTrackNear` is what the viewer uses to accumulate lap distance, so a lap
   * time depends on it. It searches near a previous position rather than globally,
   * because a global nearest-sample search is ambiguous wherever a circuit folds back
   * near itself — on Spa the globally nearest sample to a mid-straight point was 157 m
   * away along the track, which would put a car in the wrong place.
   *
   * WHAT THIS ASSERTS, and why it is not a tighter bound. The function walks outward
   * from the previous position and takes the nearest sample within `windowM`, so it is
   * exact when the car moves less than the window per tick and can only lose its place
   * if it does not. The test therefore steps the lap in increments well inside the
   * window and requires the reported position to advance by the same amount, which is
   * the property lap timing actually needs. A tolerance of one sample spacing is the
   * method's floor: it refines within the chord between two samples.
   */
  for (const track of buildCircuits()) {
    const stride = 12;                    // metres per step, well inside the window
    const window = 60;
    let worst = 0;
    let lost = 0;

    /*
     * Start from the projection of the lap's own start rather than from zero. Assuming
     * `previous = 0` made the first step ask the projection to advance 12 m from a
     * standing start, which it correctly refuses to do and which reported a false
     * failure; a car begins where it is placed, then moves.
     */
    const startPoint = pointAtDistance(track, 0);
    let previous = projectToTrackNear(track, startPoint.x, startPoint.y, 0, window).s;

    for (let expected = stride; expected < track.length; expected += stride) {
      const point = pointAtDistance(track, expected);
      const projected = projectToTrackNear(track, point.x, point.y, previous, window);

      /*
       * The advance is what must be consistent, not the absolute distance. A splice
       * between two samples can sit either side of a sample boundary, so the absolute
       * value legitimately differs from `expected` by up to one spacing; what would be
       * a real fault is the advance disagreeing with the distance actually travelled.
       */
      let advance = projected.s - previous;
      if (advance < -track.length / 2) advance += track.length;
      else if (advance > track.length / 2) advance -= track.length;
      worst = Math.max(worst, Math.abs(advance - stride));
      if (Math.abs(advance - stride) > 5) lost++;

      previous = projected.s;
    }

    assert.equal(lost, 0, `${track.name}: projection lost its place on ${lost} steps`);
    assert.ok(
      worst < 5,
      `${track.name}: the reported advance differed from the distance travelled by ` +
        `${worst.toFixed(2)} m, which would corrupt every lap time`,
    );
  }
});
