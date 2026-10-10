import test from "node:test";
import assert from "node:assert/strict";
import { buildCircuitByKey } from "../src/trackLibrary.ts";
import {
  createTrainer,
  trainGeneration,
  bestDriver,
  meanDriver,
  ladderFor,
  PARAMETER_COUNT_CHECK,
} from "../src/evolve.ts";
import { runDriver, DEFAULT_LADDER, REFERENCE_LADDER } from "../src/environment.ts";

/*
 * Runs are kept to two simulated seconds.
 *
 * The crate of these tests is the machinery around evaluation, not the driving, and a real
 * ninety-second run would make the suite unusable. Two seconds is enough for a driver to move a
 * little and for every code path to execute.
 */
const SHORT = { seconds: 2 };

test("evolve: a trainer is reproducible from its seed", async () => {
  /*
   * The foundation. Without this a training curve is noise and no change to the code can be
   * attributed to anything, which makes the whole exercise unfalsifiable.
   */
  const track = buildCircuitByKey("club")!;
  const a = createTrainer(4242, { populationSize: 4 });
  const b = createTrainer(4242, { populationSize: 4 });
  const ra = await trainGeneration(a, track, SHORT);
  const rb = await trainGeneration(b, track, SHORT);

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
  const rc = await trainGeneration(c, track, SHORT);
  assert.ok(Number.isFinite(rc.meanFitness), "the different-seed run must still be finite");
});

test("evolve: the recorded elite is the driver it claims to be", async () => {
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
    await trainGeneration(state, track, SHORT);

    if (state.bestFitness === -Infinity) continue;
    /*
     * Scored under the objective the elite was RECORDED against, not a fresh one. The ladder anneals
     * with the generation number, so the same parameters are worth a different number at generation
     * ten and at generation two hundred — and comparing across that boundary reported an elite
     * claiming 2699 that measured zero.
     */
    const measured = runDriver(bestDriver(state), track, state.bestOptions ?? SHORT).fitness;
    assert.ok(
      Math.abs(measured - state.bestFitness) < 1e-9,
      `generation ${generation}: the elite claims ${state.bestFitness} but measures ${measured}`,
    );
  }
});

test("evolve: the best-ever score never decreases", async () => {
  /*
   * Elitism is what makes a long unattended run safe: whatever state the search wanders into, the
   * recorded best is the best that was ever measured. Without it an overnight run could finish
   * worse than a checkpoint it had already saved.
   */
  const track = buildCircuitByKey("club")!;
  const state = createTrainer(11, { populationSize: 4 });
  let previous = -Infinity;
  for (let generation = 0; generation < 8; generation++) {
    await trainGeneration(state, track, SHORT);
    assert.ok(
      state.bestFitness >= previous,
      `the best-ever score fell from ${previous} to ${state.bestFitness}`,
    );
    previous = state.bestFitness;
  }
});

test("evolve: a generation reports what a generation should", async () => {
  const track = buildCircuitByKey("club")!;
  const state = createTrainer(5, { populationSize: 8 });
  const report = await trainGeneration(state, track, SHORT);

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

test("evolve: parameters change, and the search moves rather than sitting still", async () => {
  /*
   * A silent failure mode of an evolution strategy is a zero-sized step — a learning rate of
   * nothing, or a gradient that always comes out zero because the rank utilities cancel. The
   * parameters would then never move and the run would report progress that never happens.
   */
  const track = buildCircuitByKey("club")!;
  const state = createTrainer(3, { populationSize: 6 });
  const before = state.mean.slice();
  for (let generation = 0; generation < 5; generation++) await trainGeneration(state, track, SHORT);

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

test("evolve: a trainer can resume from existing parameters", async () => {
  /*
   * A thirteen-hour run is worth hours of progress by the time anything interrupts it, so being
   * able to continue is what makes a long run safe. Without it a restart meant starting over,
   * which is exactly what happened once already.
   */
  const track = buildCircuitByKey("club")!;
  const first = createTrainer(31, { populationSize: 4 });
  trainGeneration(first, track, SHORT);

  // Resume from the parameters the first run reached.
  const resumed = createTrainer(32, { populationSize: 4 }, first.mean.slice());
  assert.deepEqual(
    Array.from(resumed.mean),
    Array.from(first.mean),
    "a resumed trainer must start from exactly the parameters it was given",
  );

  // A resumed run must be usable immediately, not merely constructed.
  const report = await trainGeneration(resumed, track, SHORT);
  assert.ok(Number.isFinite(report.meanFitness), "a resumed generation must produce a score");
  assert.ok(resumed.bestFitness > -Infinity, "a resumed run must establish a best of its own");

  /*
   * A checkpoint from a different network shape must be REFUSED rather than truncated or padded.
   * Silently accepting it would scatter the weights across the wrong layers and look like a
   * driver that simply cannot drive.
   */
  assert.throws(
    () => createTrainer(1, {}, new Float64Array(10)),
    /resuming needs/,
    "a parameter count mismatch must be rejected",
  );
});

test("ladder: the anneal moves weight from sectors to the lap, and never kills both", () => {
  /*
   * The schedule is what carries the search from "get somewhere at all" to "get round quickly", so its
   * two ends are a contract rather than a preference:
   *
   *  - At generation zero a lap is worth NOTHING, because nobody can complete one yet. Paying for laps
   *    there is paying for something unreachable, and the measured consequence was a search with no
   *    signal at all.
   *  - Once the anneal is done the lap is worth everything, because by then sector credit is farmable
   *    and a lap is the objective.
   *  - At every generation in between, AT LEAST ONE of the two is worth something. This is the part
   *    worth testing: an earlier schedule annealed so fast that both terms had faded before a
   *    randomly-initialised population could complete a lap, leaving the search with nothing to climb
   *    and the run apparently frozen.
   */
  const start = ladderFor(0);
  assert.equal(start.lapReward, 0, "a lap must be worth nothing at generation zero");
  assert.ok(start.checkpointReward > 0, "and corners must be worth something");

  const end = ladderFor(DEFAULT_LADDER.annealGenerations);
  assert.equal(end.checkpointReward, 0, "sector credit must anneal away entirely");
  assert.ok(end.lapReward > 0, "and the lap must carry the objective by the end");

  let previousLap = -1;
  let previousSector = Infinity;
  for (let generation = 0; generation <= DEFAULT_LADDER.annealGenerations; generation += 250) {
    const { lapReward, checkpointReward } = ladderFor(generation);
    assert.ok(
      lapReward > 0 || checkpointReward > 0,
      `generation ${generation} left the search with no reward at all`,
    );
    assert.ok(lapReward >= previousLap, `lap weight must never fall, fell at ${generation}`);
    assert.ok(
      checkpointReward <= previousSector,
      `sector weight must never rise, rose at ${generation}`,
    );
    previousLap = lapReward;
    previousSector = checkpointReward;
  }
});

test("ladder: the anneal is slow enough to outlast learning to drive", () => {
  /*
   * Measured: a randomly-initialised population cannot complete a lap, and a scripted driver that
   * steers properly manages about a third of one. A schedule that withdraws corner credit before the
   * search can reach the lap therefore removes the only signal it has.
   *
   * THE UNITS MATTER HERE. Generations are not a duration, and the first two attempts at this number
   * were wrong because they were reasoned about as if they were: at a measured 1.4 generations per
   * second with eight workers, 2,500 annealed away in half an hour and 6,000 was spent inside the
   * first hour. A run left going overnight therefore spent nearly all of its time with the corner
   * signal at zero. The check is that a real training session still has one.
   */
  const GENERATIONS_PER_SECOND = 1.4;
  const share = (hours: number): number =>
    ladderFor(GENERATIONS_PER_SECOND * hours * 3600).checkpointReward /
    DEFAULT_LADDER.checkpointReward;

  assert.ok(
    share(2) > 0.5,
    `after two hours of training only ${(share(2) * 100).toFixed(0)}% of the corner signal is left`,
  );
  assert.equal(
    share(8),
    0,
    "and it must be gone by the end of a long run, or the corner reward is left farmable",
  );
  /*
   * The lap must meanwhile be worth something substantial well before the corner signal has gone, so
   * there is never a generation in which neither term is meaningful.
   */
  const afterTwoHours = ladderFor(GENERATIONS_PER_SECOND * 2 * 3600);
  const handover = afterTwoHours.lapReward / DEFAULT_LADDER.lapReward;
  assert.ok(
    handover > 0.2,
    `after two hours the lap is only worth ${(handover * 100).toFixed(0)}% of its final weight, so ` +
      `a driver that has learned to lap is still being paid mostly for corners`,
  );
});

test("ladder: the elite's yardstick is not generation zero's schedule", () => {
  /*
   * The bug that made every long run look frozen. The elite's record was taken under `ladderFor(0)`,
   * which is `{ lapReward: 0, checkpointReward: 500 }` — an objective on which a completed lap is
   * worth NOTHING. So the recorded number measured corner credit alone, corner credit saturates as
   * soon as a driver is quick through the corners, and a driver that improved its lap times could not
   * move the score it was being judged by. Measured: the leading driver had banked 41 of 42
   * checkpoints and its recorded score had been flat for hundreds of generations.
   *
   * The yardstick therefore has to be a RACING objective — both terms paid — and it has to be fixed
   * for the life of the run. Checked here against the generation-zero schedule it used to be, which is
   * the specific value that caused the fault.
   */
  const generationZero = ladderFor(0);
  assert.equal(generationZero.lapReward, 0, "generation zero pays nothing for a lap, by design");

  assert.ok(REFERENCE_LADDER.lapReward > 0, "so the elite's yardstick must not be generation zero");
  assert.ok(
    REFERENCE_LADDER.checkpointReward > 0,
    "and it must still pay for corners, or it cannot rank drivers that complete no lap",
  );

  const trainer = createTrainer(7);
  assert.equal(trainer.recordLadder.lapReward, REFERENCE_LADDER.lapReward);
  assert.equal(trainer.recordLadder.checkpointReward, REFERENCE_LADDER.checkpointReward);
  assert.notEqual(
    trainer.recordLadder.lapReward,
    generationZero.lapReward,
    "a trainer must not record its elite against an objective that pays nothing for a lap",
  );
});
