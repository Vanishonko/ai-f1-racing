import test from "node:test";
import assert from "node:assert/strict";
import { buildCircuitByKey } from "../src/trackLibrary.ts";
import { SectorTracker } from "../src/sectors.ts";
import { cornerCheckpoints } from "../src/track.ts";

const circuit = (key: string) => {
  const track = buildCircuitByKey(key);
  assert.ok(track, `circuit ${key} must exist`);
  return track;
};

/**
 * Drives the tracker round the circuit at a fixed speed and reports what it saw.
 *
 * The odometer is advanced monotonically, exactly as the car's is — it does NOT reset at the line —
 * because that is the property the target arithmetic has to survive. A simulation that reset it would
 * pass against broken code, which is how the original fault survived a test suite.
 */
const lapAt = (
  key: string,
  laps: number,
  speed = 40,
): { passed: number; perLap: number[]; tracker: SectorTracker } => {
  const track = circuit(key);
  const tracker = new SectorTracker(track, { cornerCheckpoints: true });
  const count = tracker.count;
  const perLap: number[] = [];
  let previous = tracker.checkpointsPassed;
  let distance = 0;

  for (let lap = 0; lap < laps; lap++) {
    for (let step = 0; step < 400; step++) {
      distance += track.length / 400;
      tracker.update(distance, speed, true);
    }
    // Crossing the line. The odometer keeps climbing; it is never rewound.
    distance = (lap + 1) * track.length;
    tracker.update(distance, speed, true);
    tracker.completeLap();
    perLap.push(tracker.checkpointsPassed - previous);
    previous = tracker.checkpointsPassed;
  }
  assert.equal(count, cornerCheckpoints(track).length);
  return { passed: tracker.checkpointsPassed, perLap, tracker };
};

test("sectors: every checkpoint is passed exactly once per lap", () => {
  /*
   * The regression that mattered. The target was compared against the bare checkpoint position while
   * the car's odometer increases across laps, so from the second lap on every checkpoint read as
   * already passed and the counter ran away — measured at 5,443 passes over two laps of a circuit
   * that has forty-two. Nothing downstream could work, because the whole lap's measurement was being
   * taken inside a few metres just past the start line.
   *
   * A lap must record exactly the circuit's checkpoint count. Not "about" — exactly, because both
   * directions of error are bugs: fewer means checkpoints were skipped, more means the target was
   * satisfied without the car going anywhere.
   */
  for (const key of ["club", "chicane", "baku", "spa"]) {
    const expected = cornerCheckpoints(circuit(key)).length;
    const { perLap } = lapAt(key, 4);
    for (let lap = 0; lap < perLap.length; lap++) {
      assert.equal(
        perLap[lap],
        expected,
        `${key} lap ${lap + 1} recorded ${perLap[lap]} passes, expected ${expected}`,
      );
    }
  }
});

test("sectors: a parked car passes nothing", () => {
  /*
   * The other side of the same coin. A target that carries its lap is only correct if it still
   * refuses to advance for a car that has not moved — otherwise the fix could be satisfied by making
   * the comparison trivially true.
   */
  const track = circuit("club");
  const tracker = new SectorTracker(track, { cornerCheckpoints: true });
  for (let step = 0; step < 600; step++) tracker.update(0, 0, true);
  assert.equal(tracker.checkpointsPassed, 0);
  assert.equal(tracker.credit, 0, "a car that never moves earns no sector credit");
});

test("sectors: reversing back over a line does not pay twice", () => {
  /*
   * Checkpoints are directional: once one has been paid, the target moves on and cannot be satisfied
   * again by driving back over it. Without that, the reward is farmable by shunting to and fro across
   * an apex, which is the same failure as the driver that learned to sit on the start line.
   */
  const track = circuit("club");
  const tracker = new SectorTracker(track, { cornerCheckpoints: true });
  const first = tracker.positions[0]!;

  tracker.update(first + 1, 40, true);
  assert.equal(tracker.checkpointsPassed, 1);

  // Shunt backwards and forwards across the line just crossed, many times.
  for (let i = 0; i < 50; i++) {
    tracker.update(first + 1 - i * 0.5, 40, true);
    tracker.update(first + 1 + i * 0.5, 40, true);
  }
  assert.equal(
    tracker.checkpointsPassed,
    1,
    "a checkpoint already paid must not be paid again by re-crossing it",
  );

  // And the next one is still ahead, so the target has not been dragged backwards either.
  tracker.update(first + 2, 40, true);
  assert.equal(tracker.checkpointsPassed, 1, "the next checkpoint is still ahead of the car");
  tracker.update(tracker.positions[1]! + 0.1, 40, true);
  assert.equal(tracker.checkpointsPassed, 2, "and it pays when genuinely reached");
});

test("sectors: credit is earned per lap, not once for the whole run", () => {
  /*
   * The second fault. Credit used to be a high-water mark over the entire run, so the first lap that
   * got a corner right set a record nothing could beat and the term went silent on the straight after
   * lap one — measured, the leading driver had banked 41 of 42 checkpoints at 108 per cent of their
   * grip limit, leaving the reward with nothing to say about corners.
   *
   * A slow lap must therefore LOWER the reported credit even when an earlier fast lap was better.
   */
  const track = circuit("club");
  const tracker = new SectorTracker(track, { cornerCheckpoints: true });
  const step = track.length / 400;

  const runLap = (speed: number, lap: number): void => {
    for (let i = 0; i < 400; i++) tracker.update(lap * track.length + i * step, speed, true);
    tracker.update((lap + 1) * track.length, speed, true);
    tracker.completeLap();
  };

  runLap(60, 0);
  const fast = tracker.credit;
  assert.ok(fast > 0, `a lap at 60 m/s must earn credit, got ${fast}`);

  runLap(8, 1);
  assert.ok(
    tracker.credit < fast,
    `a slow lap must reduce the run's credit: was ${fast.toFixed(3)}, now ${tracker.credit.toFixed(3)}`,
  );
  assert.ok(
    tracker.meanLapCredit < fast,
    "and the per-lap mean must show the drop too",
  );
});

test("sectors: a cut checkpoint is forfeit, and only that one", () => {
  /*
   * Off the circuit at the crossing forfeits that sector — that is what stops the reward being farmed
   * by cutting the apex, since the shortest path through a corner clips the inside.
   *
   * It must forfeit ONLY that sector. The earlier guard skipped the entire credit loop when any
   * checkpoint had been missed, so one wheel on the grass at one corner zeroed the lap. Measured on
   * the project's leading driver: a single cut at checkpoint 18 took its credit from 41 of 42 to
   * exactly ZERO, which is how a driver that was clearly quick reported earning nothing.
   */
  const track = circuit("club");
  const tracker = new SectorTracker(track, { cornerCheckpoints: true });
  const step = track.length / 400;

  for (let i = 0; i < 400; i++) {
    const distance = i * step;
    // Off the circuit across one stretch in the middle of the lap, in the corners or not.
    const off = distance > track.length * 0.4 && distance < track.length * 0.45;
    tracker.update(distance, 40, !off);
  }
  const partial = tracker.credit;
  assert.ok(partial > 0, `cutting one stretch must not zero the lap, got ${partial}`);
  assert.ok(partial < 1, "but it must cost something");
});

test("sectors: a partial final lap still counts for what was driven", () => {
  /*
   * A run cut off mid-lap would otherwise be scored as though the corners it did drive never
   * happened, which makes a driver's score depend on where the clock stopped — the same failure the
   * evaluation length already caused once.
   */
  const track = circuit("club");
  const tracker = new SectorTracker(track, { cornerCheckpoints: true });
  const half = Math.floor(tracker.count / 2);
  let distance = 0;
  for (let i = 0; i < half; i++) {
    distance = tracker.positions[i]! + 0.1;
    tracker.update(distance, 40, true);
  }
  assert.equal(tracker.checkpointsPassed, half);
  assert.ok(tracker.credit > 0, "half a lap of good corners must be worth something");
  assert.ok(tracker.credit <= 1, "and the credit is a mean, so it can never exceed 1");
});

test("sectors: credit is comparable between lap counts", () => {
  /*
   * Sector credit is a MEAN, so the same driving must score the same however long the run is. A sum
   * would pay a four-lap run four times as much for identical quality, which is an artefact of the
   * clock rather than a fact about the driver, and it would make the reward depend on the evaluation
   * length the way the old lap cliff did.
   */
  const short = lapAt("club", 1).tracker.credit;
  const long = lapAt("club", 4).tracker.credit;
  assert.ok(
    Math.abs(short - long) < 1e-9,
    `one lap scored ${short.toFixed(6)} and four scored ${long.toFixed(6)} for the same driving`,
  );
});
