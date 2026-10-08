import test from "node:test";
import assert from "node:assert/strict";
import {
  createDriver,
  drive,
  randomGenes,
  PARAMETER_COUNT,
  HIDDEN_SIZE,
  OUTPUT_SIZE,
  PARAMETER_OFFSETS,
  type Controls,
} from "../src/driver.ts";
import { createObservation } from "../src/sense.ts";
import { tanh, saturateUnit, logUnit } from "../src/activation.ts";
import { createRng } from "../src/rng.ts";

/**
 * A seeded uniform source for the initialiser.
 *
 * `randomGenes` requires a source rather than defaulting to `Math.random`, so that a run
 * is reproducible; this is the adapter from the engine's PRNG to the plain function it
 * asks for.
 */
const seeded = (seed: number): (() => number) => {
  const rng = createRng(seed);
  return () => rng.nextFloat();
};

const controls = (): Controls => ({ throttle: 0, brake: 0, steer: 0 });

test("driver: the parameter count matches the declared topology", () => {
  const inputs = createObservation().values.length;
  assert.equal(
    PARAMETER_COUNT,
    HIDDEN_SIZE * inputs + HIDDEN_SIZE + OUTPUT_SIZE * HIDDEN_SIZE + OUTPUT_SIZE,
    "the flat parameter layout must match the layers it describes",
  );
  assert.equal(PARAMETER_OFFSETS.outputBiases + OUTPUT_SIZE, PARAMETER_COUNT, "the offsets must tile the vector exactly");
  const driver = createDriver(undefined, seeded(1));
  assert.equal(driver.genes.length, PARAMETER_COUNT);
});

test("driver: the same genes always produce the same controls", () => {
  /*
   * The whole basis for saying whether a change helped is that a driver is a pure
   * function of its genes and its inputs. An unseeded initialisation or a stray
   * non-deterministic call would make every measurement meaningless.
   */
  const genes = randomGenes(seeded(42));
  const observation = createObservation();
  for (let i = 0; i < observation.values.length; i++) observation.values[i] = Math.sin(i) * 0.5;

  const a = controls();
  const b = controls();
  drive(createDriver(genes, seeded(1)), observation, a);
  drive(createDriver(genes, seeded(2)), observation, b);

  assert.deepEqual(a, b, "identical genes and inputs must give identical controls");
});

test("driver: the seeded initialisation is reproducible", () => {
  const first = randomGenes(seeded(7));
  const second = randomGenes(seeded(7));
  const third = randomGenes(seeded(8));
  assert.deepEqual(Array.from(first), Array.from(second), "the same seed must agree");
  assert.notDeepEqual(Array.from(first), Array.from(third), "a different seed must differ");
});

test("driver: controls are always inside the ranges the car accepts", () => {
  /*
   * A driver must not be able to ask for negative throttle or a steering angle beyond
   * full lock, however wild its parameter vector. The squashing is part of the network
   * rather than the caller's responsibility, so a search over arbitrary real genes can
   * never produce an invalid command.
   */
  const observation = createObservation();
  const out = controls();
  for (let seed = 1; seed <= 40; seed++) {
    const genes = randomGenes(seeded(seed));
    // Push the genes far outside any trained range to hunt for saturation failures.
    for (let i = 0; i < genes.length; i++) genes[i] = genes[i]! * 5000;
    for (let i = 0; i < observation.values.length; i++) observation.values[i] = (seed % 7) - 3;

    drive(createDriver(genes, seeded(seed)), observation, out);
    assert.ok(out.throttle >= 0 && out.throttle <= 1, `throttle ${out.throttle}`);
    assert.ok(out.brake >= 0 && out.brake <= 1, `brake ${out.brake}`);
    assert.ok(out.steer >= -1 && out.steer <= 1, `steer ${out.steer}`);
    assert.ok(Number.isFinite(out.throttle + out.brake + out.steer), "controls must be finite");
  }
});

test("driver: an untrained population does not all do the same thing", () => {
  /*
   * Initialisation that collapses every unit onto its asymptote would make the whole
   * initial population behave identically, and a search with no variation has nothing to
   * select on. This checks the fan-in scaling is doing its job.
   */
  const observation = createObservation();
  for (let i = 0; i < observation.values.length; i++) observation.values[i] = 0.3;

  const throttles: number[] = [];
  const out = controls();
  for (let seed = 1; seed <= 30; seed++) {
    drive(createDriver(randomGenes(seeded(seed)), seeded(1)), observation, out);
    throttles.push(out.throttle);
  }
  const spread = Math.max(...throttles) - Math.min(...throttles);
  assert.ok(spread > 0.05, `the initial population's throttle demand varied by only ${spread.toFixed(4)}`);
});

test("activation: the baked tanh agrees with the real one where it matters", () => {
  /*
   * The table replaces a banned function, so it has to be accurate enough that the
   * network behaves the same as one that used the real thing. Linear interpolation on
   * 2048 points over [-4, 4] should be good to about 1e-5.
   */
  let worst = 0;
  for (let i = -1000; i <= 1000; i++) {
    const x = (i / 1000) * 6;
    const expected = Math.tanh(x);
    const actual = tanh(x);
    worst = Math.max(worst, Math.abs(actual - expected));
  }
  assert.ok(worst < 1e-4, `the baked tanh differs from the real one by ${worst.toExponential(2)}`);

  /*
   * Exactness at zero is NOT asserted. Zero is a table node only when the step count is
   * even and the range symmetric, which happens to hold, but that is a coincidence of the
   * constants rather than a property worth depending on — and the accuracy check above
   * already covers it. Asserting it would make a future change to the resolution fail for
   * no good reason.
   */
  assert.ok(Math.abs(tanh(0)) < 1e-6, "tanh(0) must be zero to within the table's accuracy");

  assert.ok(tanh(1e6) > 0.999, "large positive input approaches the asymptote");
  assert.ok(tanh(-1e6) < -0.999, "large negative input approaches the negative asymptote");
  assert.equal(tanh(1e6), tanh(6), "beyond the table the function is flat, not discontinuous");
  assert.equal(tanh(-1e6), tanh(-6), "and flat on the negative side too");
});

test("activation: saturateUnit is monotonic, smooth and bounded", () => {
  /*
   * ZERO MUST MEAN FULLY RELEASED. An earlier version centred the curve at zero, so an
   * untrained driver — whose outputs are all zero — demanded half throttle and half brake at
   * once. The car then sat still, and because it never moved the search had no gradient:
   * measured, eighty generations produced no progress whatsoever.
   */
  assert.equal(saturateUnit(0), 0, "zero demand must mean no pedal, not half a pedal");
  assert.ok(saturateUnit(-1) < 0.2, "a negative output must mean essentially no pedal");

  // Non-decreasing everywhere, and strictly increasing once the pedal is being pressed.
  let previous = -Infinity;
  for (let i = -500; i <= 500; i++) {
    const value = saturateUnit(i / 50);
    assert.ok(value >= previous - 1e-12, `saturateUnit must not decrease: ${value} after ${previous}`);
    assert.ok(value >= 0 && value <= 1, `saturateUnit left [0, 1]: ${value}`);
    previous = value;
  }
  // The upper bound is an asymptote, so a search always has a gradient to follow. The lower
  // bound IS a clamp at zero by design: a released pedal is released.
  assert.ok(saturateUnit(1e6) < 1, "the upper bound is an asymptote, not a clamp");
  assert.equal(saturateUnit(-1e6), 0, "the lower bound is exactly a released pedal");
});

test("driver: the parameter layout the network reads is the layout it declares", () => {
  /*
   * THE BUG THIS EXISTS FOR, and it is the reason a "does the throttle work" test matters.
   * `drive` originally read each unit's bias immediately after that unit's weights — the
   * natural way to write the loop — while `PARAMETER_OFFSETS` and the initialiser lay out all
   * weights first and all biases after. So every bias written by the initialiser was ignored
   * and every weight was read from the wrong place.
   *
   * It survived because a uniformly-zero gene vector produces neutral controls under either
   * ordering, so nothing looked wrong until a test set a specific bias and asked whether the
   * network responded.
   *
   * This pins the contract directly: set one hidden bias, and require the corresponding unit
   * to be driven. Nothing else in the vector is touched, so the only way the unit can move is
   * if its bias is read from the declared offset.
   */
  const observation = createObservation();
  const out = controls();
  const genes = new Float64Array(PARAMETER_COUNT);

  const unit = 5;
  genes[PARAMETER_OFFSETS.hiddenBiases + unit] = 4;
  /*
   * The weight goes to the THROTTLE output, the first channel. An earlier version drove the
   * brake channel, which stopped working when throttle was given priority over brake — the
   * brake is now scaled by `1 - throttle`, so a driver pressing the throttle masks its own
   * braking and the test was measuring that instead of the layout.
   */
  genes[PARAMETER_OFFSETS.outputWeights + unit] = 3;

  drive(createDriver(genes, seeded(1)), observation, out);
  const driver = createDriver(genes, seeded(1));
  drive(driver, observation, out);

  assert.ok(
    driver.hidden[unit]! > 0.99,
    `hidden unit ${unit} should be driven by its bias: got ${driver.hidden[unit]}`,
  );
  // Every other unit has no bias, so none of them should be driven.
  for (let other = 0; other < HIDDEN_SIZE; other++) {
    if (other === unit) continue;
    assert.ok(
      Math.abs(driver.hidden[other]!) < 1e-9,
      `hidden unit ${other} was driven without a bias: ${driver.hidden[other]}`,
    );
  }
  assert.ok(out.throttle > 0.9, `the driven unit should push the throttle output up: ${out.throttle}`);
});

test("activation: the baked logarithm agrees with the real one", () => {
  /*
   * Baked for the same reason as tanh, and used to keep the trainer's Gaussian sampler inside
   * the determinism contract. Its accuracy is worst near the bottom of its range, where the
   * function curves hardest, so the check is spread across the range the sampler actually
   * draws from rather than concentrated where the function is easy.
   */
  let worst = 0;
  for (let i = 1; i <= 2000; i++) {
    const x = Math.exp(-13 + (13 * i) / 2000);
    worst = Math.max(worst, Math.abs(logUnit(x) - Math.log(x)));
  }
  assert.ok(worst < 1e-3, `the baked logarithm differs from the real one by ${worst.toExponential(2)}`);
  assert.equal(logUnit(1), 0, "log(1) is pinned to exactly zero, being the last table node");
  assert.ok(logUnit(0) === logUnit(1e-12), "below the range the value is held, not discontinuous");
  assert.ok(logUnit(2) === logUnit(1), "above the range the value is held too");
  assert.ok(logUnit(0.5) < 0 && logUnit(0.5) > -1, "log(0.5) is in the right band");
  assert.ok(
    Math.abs(logUnit(0.5) - Math.log(0.5)) < 1e-4,
    `log(0.5) off by ${Math.abs(logUnit(0.5) - Math.log(0.5)).toExponential(2)}`,
  );
});
