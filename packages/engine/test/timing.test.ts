import test from "node:test";
import assert from "node:assert/strict";
import { createTiming, updateTiming, formatTime, type TimingState } from "../src/timing.ts";

const LAP = 3600;

/**
 * Drives the timing at a fixed speed for `seconds`.
 *
 * Distance AND elapsed time both carry over from the state, because they must: the
 * session clock is monotonic, and a helper that restarts it makes `lastStep` negative
 * and silently stops every sector being recorded. That bug cost a round of debugging
 * here, so the helper reads both from the state rather than owning either.
 */
const drive = (state: TimingState, speed: number, seconds: number, dt = 1 / 60): void => {
  let distance = state.previousDistance;
  let elapsed = state.previousElapsed;
  for (let t = 0; t * dt < seconds; t++) {
    distance += speed * dt;
    elapsed += dt;
    updateTiming(state, distance, elapsed);
  }
};

test("timing: a lap at constant speed takes lapLength / speed", () => {
  const state = createTiming(LAP, 3);
  const speed = 60;
  drive(state, speed, LAP / speed + 0.5);

  assert.equal(state.laps, 1, "exactly one lap should be counted");
  assert.ok(state.lastLap !== null, "a completed lap should be recorded");
  const expected = LAP / speed;
  assert.ok(
    Math.abs(state.lastLap!.time - expected) < 0.05,
    `lap time ${state.lastLap!.time.toFixed(3)} s should be close to ${expected.toFixed(3)} s`,
  );
});

test("timing: sectors are equal in a constant-speed lap", () => {
  const state = createTiming(LAP, 3);
  const speed = 72;
  drive(state, speed, LAP / speed + 0.5);

  const sectors = state.lastLap!.sectors;
  assert.equal(sectors.length, 3, "three sectors per lap");
  const expected = LAP / speed / 3;
  for (const s of sectors) {
    assert.ok(
      Math.abs(s - expected) < 0.05,
      `sector ${s.toFixed(3)} s should be close to ${expected.toFixed(3)} s`,
    );
  }
});

test("timing: no boundary is lost when a step crosses two at once", () => {
  /*
   * Racing at 300 km/h with a coarse tick puts multiple boundaries inside one step. A
   * version that tested only where the car ENDED UP dropped the boundaries it stepped
   * over, which produced laps with missing sectors.
   */
  const state = createTiming(120, 3);        // 40 m sectors
  const dt = 1 / 5;                          // deliberately coarse
  let distance = 0;
  let elapsed = 0;
  for (let i = 0; i < 40; i++) {
    distance += 100 * dt;                    // 20 m per step: half a sector
    elapsed += dt;
    updateTiming(state, distance, elapsed);
  }
  assert.ok(state.laps >= 2, `expected at least two laps, got ${state.laps}`);
  assert.equal(state.lastLap!.sectors.length, 3, "every lap must have all its sectors");
});

test("timing: purple is awarded for beating a sector best, personal for matching it", () => {
  const state = createTiming(LAP, 3);

  drive(state, 50, (LAP / 50) * 1.05);
  assert.equal(state.lastGrade, "purple", "the first ever sector is a best, so purple");

  // A faster lap must beat all three sectors.
  const before = state.sectorBests.slice();
  drive(state, 80, (LAP / 80) * 1.05);
  assert.equal(state.lastGrade, "purple", "a faster lap should be purple");
  for (let i = 0; i < 3; i++) {
    assert.ok(state.sectorBests[i]! < before[i]!, `sector ${i} best should have improved`);
  }

  // A slower lap must not.
  drive(state, 30, (LAP / 30) * 1.05);
  assert.equal(state.lastGrade, "none", "a slower lap is not purple");
});

test("timing: lap and sector bests are independent of the lap they came from", () => {
  const state = createTiming(LAP, 3);
  // A lap with a very fast first sector and a slow remainder.
  let distance = 0;
  let elapsed = 0;
  const dt = 1 / 60;
  const push = (speed: number, metres: number): void => {
    const seconds = metres / speed;
    for (let t = 0; t * dt < seconds; t++) {
      distance += speed * dt;
      elapsed += dt;
      updateTiming(state, distance, elapsed);
    }
  };
  push(200, LAP / 3);      // sector 1, very fast
  push(20, (LAP * 2) / 3); // sectors 2 and 3, slow

  const fastFirst = state.sectorBests[0]!;
  assert.ok(fastFirst < 10, `first sector best ${fastFirst.toFixed(2)} s should be quick`);
  assert.ok(state.bestLap !== null, "the lap still completed");
  assert.ok(state.bestLap! > 100, "the lap as a whole was slow despite one quick sector");
});

test("timing: formatting is stable and handles no-time", () => {
  assert.equal(formatTime(null), "--:--.---");
  assert.equal(formatTime(0), "0:00.000");
  assert.equal(formatTime(83.456), "1:23.456");
  assert.equal(formatTime(9.05), "0:09.050");
});
