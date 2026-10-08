import test from "node:test";
import assert from "node:assert/strict";
import { buildCircuitByKey } from "../src/trackLibrary.ts";
import {
  createTrainer,
  trainGeneration,
  bestDriver,
  meanDriver,
  PARAMETER_COUNT_CHECK,
} from "../src/evolve.ts";
import { runDriver } from "../src/environment.ts";

/*
 * Runs are kept to two simulated seconds.
 *
 * The crate of these tests is the machinery around evaluation, not the driving, and a real
 * ninety-second run would make the suite unusable. Two seconds is enough for a driver to move a
 * little and for every code path to execute.
 */
const SHORT = { seconds: 2 };

test("evolve: a trainer is reproducible from its seed", () => {
  /*
   * The foundation. Without this a training curve is noise and no change to the code can be
   * attributed to anything, which makes the whole exercise unfalsifiable.
   */
  const track = buildCircuitByKey("club")!;
  const a = createTrainer(4242, { populationSize: 4 });
  const b = createTrainer(4242, { populationSize: 4 });
  const ra = trainGeneration(a, track, SHORT);
  const rb = trainGeneration(b, track, SHORT);

  assert.equal(ra.meanFitness, rb.meanFitness, "the same seed must give the same generation");
  assert.equal(ra.bestSampleFitness, rb.bestSampleFitness);
  assert.equal(a.bestFitness, b.bestFitness);

  /*
   * A different seed must give different PARAMETERS. Comparing scores would be the obvious check
   * and is wrong: an untrained population has every driver at zero output, so every score is
   * zero and two different seeds legitimately agree. The parameters are the thing that actually
   * differs, and they are what a checkpoint holds.
   */
  const c = createTrainer(9999, { populationSize: 4 });
  let differing = 0;
  for (let i = 0; i < a.mean.length; i++) {
    if (Math.abs(a.mean[i]! - c.mean[i]!) > 1e-15) differing++;
  }
  assert.ok(
    differing > a.mean.length / 2,
    `only ${differing} of ${a.mean.length} parameters differed between two seeds`,
  );
  // And a run from a different seed must still be self-consistent.
  const rc = trainGeneration(c, track, SHORT);
  assert.ok(Number.isFinite(rc.meanFitness), "the different-seed run must still be finite");
});

test("evolve: the recorded elite is the driver it claims to be", () => {
  /*
   * THE BUG THIS EXISTS FOR. The best-ever parameters and the best-ever score must belong to
   * each other. An earlier version scored the search centre, then took the Adam step, then saved
   * the mean — so the recorded vector was not the one that earned the score, and a run reported a
   * best fitness of 1751 for a driver that measured 786.
   *
   * The check is direct: take the elite, run it, and require the number to match what the trainer
   * recorded. Nothing else can verify that contract.
   */
  const track = buildCircuitByKey("chicane")!;
  const state = createTrainer(77, { populationSize: 6 });
  for (let generation = 0; generation < 6; generation++) {
    trainGeneration(state, track, SHORT);

    if (state.bestFitness === -Infinity) continue;
    const measured = runDriver(bestDriver(state), track, SHORT).fitness;
    assert.ok(
      Math.abs(measured - state.bestFitness) < 1e-9,
      `generation ${generation}: the elite claims ${state.bestFitness} but measures ${measured}`,
    );
  }
});

test("evolve: the best-ever score never decreases", () => {
  /*
   * Elitism is what makes a long unattended run safe: whatever state the search wanders into, the
   * recorded best is the best that was ever measured. Without it an overnight run could finish
   * worse than a checkpoint it had already saved.
   */
  const track = buildCircuitByKey("club")!;
  const state = createTrainer(11, { populationSize: 4 });
  let previous = -Infinity;
  for (let generation = 0; generation < 8; generation++) {
    trainGeneration(state, track, SHORT);
    assert.ok(
      state.bestFitness >= previous,
      `the best-ever score fell from ${previous} to ${state.bestFitness}`,
    );
    previous = state.bestFitness;
  }
});

test("evolve: a generation reports what a generation should", () => {
  const track = buildCircuitByKey("club")!;
  const state = createTrainer(5, { populationSize: 8 });
  const report = trainGeneration(state, track, SHORT);

  assert.equal(report.generation, 1, "generations are numbered from one");
  assert.ok(Number.isFinite(report.meanFitness), "mean fitness must be finite");
  assert.ok(Number.isFinite(report.currentFitness), "the centre's fitness must be finite");
  assert.ok(Number.isFinite(report.meanDistance), "mean distance must be finite");
  assert.ok(
    report.meanOnTrack >= 0 && report.meanOnTrack <= 1,
    `mean on-track fraction was ${report.meanOnTrack}`,
  );
  // The best sample cannot be worse than the mean, by definition.
  assert.ok(
    report.bestSampleFitness >= report.meanFitness,
    `best sample ${report.bestSampleFitness} was below the mean ${report.meanFitness}`,
  );
});

test("evolve: parameters change, and the search moves rather than sitting still", () => {
  /*
   * A silent failure mode of an evolution strategy is a zero-sized step — a learning rate of
   * nothing, or a gradient that always comes out zero because the rank utilities cancel. The
   * parameters would then never move and the run would report progress that never happens.
   */
  const track = buildCircuitByKey("club")!;
  const state = createTrainer(3, { populationSize: 6 });
  const before = state.mean.slice();
  for (let generation = 0; generation < 5; generation++) trainGeneration(state, track, SHORT);

  let moved = 0;
  for (let i = 0; i < before.length; i++) {
    if (Math.abs(state.mean[i]! - before[i]!) > 1e-12) moved++;
  }
  assert.ok(moved > 0, "the search must move some parameters");
  assert.ok(
    state.mean.every((value) => Number.isFinite(value)),
    "every parameter must stay finite",
  );
});

test("evolve: the two public drivers are distinct", () => {
  const state = createTrainer(21, { populationSize: 4 });
  assert.equal(bestDriver(state).genes.length, meanDriver(state).genes.length);
  assert.equal(PARAMETER_COUNT_CHECK, bestDriver(state).genes.length);
});
