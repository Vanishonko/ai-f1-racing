/**
 * The driver: a fixed-topology neural network mapping an observation to controls.
 *
 * WHY A FIXED TOPOLOGY RATHER THAN NEAT. The original plan was NEAT, because that is
 * what makes for a good video. It is the wrong tool here, for one decisive reason: the
 * whole point of this project is that a driver trained on one circuit should be able to
 * be put on ANOTHER. A neuroevolution method that grows its own topology is free to
 * invent whatever wiring solves the circuit in front of it, and there is no reason for
 * the result to transfer — the structure itself is fitted to one track. A fixed topology
 * sharing an input contract across every circuit forces the network to learn something
 * about driving rather than about Spa.
 *
 * It is also much faster to evaluate, which matters when a fitness function is a
 * simulated lap.
 *
 * TOPOLOGY. One hidden layer, `tanh` activation, linear output. Deliberately small:
 * observations in, a handful of controls out, and nothing hidden in between that the
 * trainer would have to search through. A bigger network would overfit one circuit
 * faster, not drive better.
 *
 * PARAMETERS ARE ONE FLAT ARRAY. Evolution strategies want a vector to perturb and
 * average; a tree of objects would need flattening on every mutation and would make
 * checkpoints awkward. The layout is documented below so the array is inspectable.
 */

import { OBSERVATION_SIZE, type Observation } from "./sense.ts";
import { clampUnit, saturateUnit, tanh } from "./activation.ts";

/** Hidden units. Small on purpose — see the module note. */
export const HIDDEN_SIZE = 16;

/** Control outputs: throttle, brake, steer. */
export const OUTPUT_SIZE = 3;

/**
 * Total parameters: weights and biases for the hidden layer, then for the output layer.
 *
 *   hidden weights  HIDDEN_SIZE x OBSERVATION_SIZE
 *   hidden biases   HIDDEN_SIZE
 *   output weights  OUTPUT_SIZE x HIDDEN_SIZE
 *   output biases   OUTPUT_SIZE
 */
export const PARAMETER_COUNT =
  HIDDEN_SIZE * OBSERVATION_SIZE + HIDDEN_SIZE + OUTPUT_SIZE * HIDDEN_SIZE + OUTPUT_SIZE;

/**
 * Where each layer's parameters begin in the flat vector.
 *
 * Exported so nothing has to reconstruct the layout from the sizes. A test that got this
 * arithmetic wrong would be silently testing the wrong weights, and one did: it computed
 * the offset from a constant it had failed to import, wrote to index `NaN`, and then
 * reported that a full-throttle driver could not move the car.
 */
export const PARAMETER_OFFSETS = {
  hiddenWeights: 0,
  hiddenBiases: HIDDEN_SIZE * OBSERVATION_SIZE,
  outputWeights: HIDDEN_SIZE * OBSERVATION_SIZE + HIDDEN_SIZE,
  outputBiases: HIDDEN_SIZE * OBSERVATION_SIZE + HIDDEN_SIZE + OUTPUT_SIZE * HIDDEN_SIZE,
} as const;

/** A driver's controls for one tick, all in the units `stepCar` expects. */
export interface Controls {
  throttle: number;
  brake: number;
  steer: number;
}

/**
 * Weights are initialised in this range.
 *
 * Scaled by the fan-in of each layer so that pre-activations start near unit variance.
 * A flat range, which is the obvious choice, makes a layer with sixty inputs saturate
 * every unit immediately and the initial population is then uniformly useless — which
 * makes the first generations of a run look like the method failing when it is the
 * initialisation.
 */
const initScale = (fanIn: number): number => 1 / Math.sqrt(fanIn);

export interface Driver {
  /** Flat parameter vector, mutated in place by the trainer. */
  genes: Float64Array;
  /** Scratch buffers, so a step allocates nothing. */
  hidden: Float64Array;
  outputs: Float64Array;
  /** Where `drive` writes the driver's intent, before the actuator limit. */
  intent: Controls;
  /** What the car actually receives, after the actuator limit. */
  applied: Controls;
  /**
   * Steering rate, in units of full lock per second.
   *
   * Carried because the steering is a second-order system: the rate is half its state. Anything that
   * resets a car must clear this too, or the wheel carries on turning from a motion the car no longer
   * has.
   */
  steerRate: number;
}

/**
 * The steering system, as a second-order response rather than a speed limit.
 *
 * A RATE LIMIT IS NOT ENOUGH, and believing it was cost real time. With steering capped at a speed,
 * the search simply SATURATES the cap: measured, the commanded steering changed by 0.025 per tick
 * against a limit of 0.0267 — pinned to the maximum, continuously — with 692 direction reversals in
 * ninety seconds and a peak body slip angle of EIGHTY-EIGHT DEGREES. The car was not being driven, it
 * was being shaken.
 *
 * The missing physics is that a steering system has INERTIA and DAMPING, not merely a maximum speed.
 * A hand on a wheel cannot reverse a moving mass instantly, however hard it tries, and that is
 * exactly the constraint that stops a controller twitching. Modelling it as a rate limit allowed
 * arbitrarily violent reversals as long as each one was quick enough.
 *
 * So the steering angle now follows the command through a damped second-order system, at a frequency
 * a person can drive a wheel at and a damping ratio near critical so it settles without ringing. The
 * practical effect is that a reversal takes time proportionate to how far it is reversing, which is
 * what a real wheel does.
 */
const STEER_FREQUENCY = 9.0;
const STEER_DAMPING = 0.9;

/**
 * How fast the pedals move, as a fraction of full travel per second.
 *
 * Pedals genuinely are close to rate-limited: a foot travels a fixed distance in a fixed time and has
 * little inertia to speak of. Measured, the throttle now changes by about 0.06 per tick against a
 * limit of 0.10, so unlike the steering it is not pinned to the cap.
 */
const PEDAL_RATE_LIMIT = 6.0;

/**
 * Moves an applied control towards its commanded value at a bounded rate.
 *
 * A rate limit rather than a low-pass filter, because that is what the physical limit actually is:
 * a hand can move at most so fast, and it can hold any position. A filter would smooth the noise
 * but also lag genuinely quick corrections, which is the wrong trade for a racing driver.
 */
const approach = (current: number, target: number, maxDelta: number): number => {
  const delta = target - current;
  if (delta > maxDelta) return current + maxDelta;
  if (delta < -maxDelta) return current - maxDelta;
  return target;
};

/**
 * Rate-limits the controls to what a driver could physically ask for.
 *
 * @param dt timestep [s]
 */
export const smoothControls = (driver: Driver, dt: number): void => {
  const applied = driver.applied;
  const intent = driver.intent;

  /*
   * Steering: a damped spring towards the commanded angle.
   *
   * Integrated semi-implicitly, which is stable at this timestep and needs no matrix exponential.
   * The state carried between steps is the steering RATE, so an interruption — a reset, a rewind —
   * must clear it, or the wheel keeps turning after the car has been put back on the line.
   */
  const acceleration =
    STEER_FREQUENCY * STEER_FREQUENCY * (intent.steer - applied.steer) -
    2 * STEER_DAMPING * STEER_FREQUENCY * driver.steerRate;
  driver.steerRate += acceleration * dt;
  applied.steer += driver.steerRate * dt;
  // A hard stop at full lock, because the wheel does not keep turning past it.
  if (applied.steer > 1) {
    applied.steer = 1;
    if (driver.steerRate > 0) driver.steerRate = 0;
  } else if (applied.steer < -1) {
    applied.steer = -1;
    if (driver.steerRate < 0) driver.steerRate = 0;
  }

  applied.throttle = approach(applied.throttle, intent.throttle, PEDAL_RATE_LIMIT * dt);
  applied.brake = approach(applied.brake, intent.brake, PEDAL_RATE_LIMIT * dt);
};

export const createDriver = (genes?: Float64Array, random?: () => number): Driver => {
  if (!genes && !random) {
    throw new Error(
      "createDriver needs either genes or a seeded random source; an unseeded " +
        "initialisation would make a training run impossible to reproduce",
    );
  }
  return {
    genes: genes ?? randomGenes(random!),
    hidden: new Float64Array(HIDDEN_SIZE),
    outputs: new Float64Array(OUTPUT_SIZE),
    intent: { throttle: 0, brake: 0, steer: 0 },
    applied: { throttle: 0, brake: 0, steer: 0 },
    steerRate: 0,
  };
};

/**
 * A fresh random driver.
 *
 * The random source is REQUIRED rather than defaulted to `Math.random`. That is not
 * fussiness: an unseeded initialisation would make a training run impossible to
 * reproduce, which is the whole basis for being able to say whether a change helped.
 * Requiring it makes that a compile error rather than a silent difference between runs.
 */
export const randomGenes = (random: () => number): Float64Array => {
  const genes = new Float64Array(PARAMETER_COUNT);
  let at = 0;
  const hiddenScale = initScale(OBSERVATION_SIZE);
  for (let i = 0; i < HIDDEN_SIZE * OBSERVATION_SIZE; i++) {
    genes[at++] = (random() * 2 - 1) * hiddenScale;
  }
  for (let i = 0; i < HIDDEN_SIZE; i++) genes[at++] = 0;
  const outputScale = initScale(HIDDEN_SIZE);
  for (let i = 0; i < OUTPUT_SIZE * HIDDEN_SIZE; i++) {
    genes[at++] = (random() * 2 - 1) * outputScale;
  }
  for (let i = 0; i < OUTPUT_SIZE; i++) genes[at++] = 0;
  return genes;
};

/**
 * Runs the network and writes the resulting controls.
 *
 * `tanh` is used rather than a rectifier because its output is bounded and centred, so a
 * small change in a weight cannot produce a large change in behaviour. That smoothness
 * is what makes a mutation-based search work at all.
 *
 * The controls are squashed into their valid ranges here rather than left to the caller,
 * so a driver cannot ask for more throttle than exists and a wild parameter vector
 * cannot produce a control the car would have to reject.
 */
export const drive = (driver: Driver, observation: Observation, out: Controls): void => {
  const genes = driver.genes;
  const hidden = driver.hidden;
  const values = observation.values;

  /*
   * The read order MUST match `PARAMETER_OFFSETS` and `randomGenes`: all weights for a
   * layer, then all its biases.
   *
   * An earlier version read each unit's bias immediately after that unit's weights, which
   * is the natural way to write the loop and is wrong — it walks the vector in a different
   * order from the one the layout declares. The biases then landed on weight positions, so
   * every bias the initialiser wrote was ignored and every weight it wrote was read as
   * something else. The network still ran and produced plausible-looking controls, which is
   * exactly why it survived: a uniformly-zero gene vector gives neutral controls either way,
   * so only a test that sets a specific bias could see it.
   */
  const hiddenBiasAt = PARAMETER_OFFSETS.hiddenBiases;
  const outputWeightAt = PARAMETER_OFFSETS.outputWeights;
  const outputBiasAt = PARAMETER_OFFSETS.outputBiases;

  for (let unit = 0; unit < HIDDEN_SIZE; unit++) {
    let sum = 0;
    const weightAt = unit * OBSERVATION_SIZE;
    for (let input = 0; input < OBSERVATION_SIZE; input++) {
      sum += genes[weightAt + input]! * values[input]!;
    }
    sum += genes[hiddenBiasAt + unit]!;
    hidden[unit] = tanh(sum);
  }

  const outputs = driver.outputs;
  for (let output = 0; output < OUTPUT_SIZE; output++) {
    let sum = 0;
    const weightAt = outputWeightAt + output * HIDDEN_SIZE;
    for (let unit = 0; unit < HIDDEN_SIZE; unit++) {
      sum += genes[weightAt + unit]! * hidden[unit]!;
    }
    sum += genes[outputBiasAt + output]!;
    outputs[output] = sum;
  }

  /*
   * Throttle and brake are one-sided; steering is symmetric.
   *
   * THROTTLE TAKES PRIORITY WHEN BOTH ARE DEMANDED. Two independent outputs can ask for
   * both pedals at once, and because the brakes are far stronger than the engine the car
   * then simply does not move: measured, a driver demanding 54 per cent throttle and 21 per
   * cent brake sat stationary for twenty-five seconds. That is a cliff in the fitness
   * landscape with no gradient out of it — every perturbation in that region scores zero,
   * so the search cannot discover that lifting off is what makes the car go.
   *
   * Scaling the brake down by the remaining throttle is also what a real driver does: the
   * pedals are operated by one foot each, and nobody holds both. It leaves the interesting
   * behaviour intact — braking is still a separate, fully available channel — while removing
   * a purely artificial trap.
   */
  const throttle = saturateUnit(outputs[0]!);
  const brake = saturateUnit(outputs[1]!);
  out.throttle = throttle;
  out.brake = brake * (1 - throttle);
  out.steer = clampUnit(outputs[2]!);
};

/**
 * Runs the network and writes the controls the car should actually receive.
 *
 * `drive` produces the driver's INTENT; this applies the physical rate limit on top, so the car
 * sees what a person could have asked for rather than what the network happened to output this
 * tick. Everything that drives a car should go through this rather than through `drive`.
 */
export const driveSmoothed = (driver: Driver, observation: Observation, dt: number): Controls => {
  // `drive` writes the INTENT; `smoothControls` moves the APPLIED values towards it. They must be
  // separate objects — an earlier version passed `applied` to both, so the raw network output was
  // written straight into the value being smoothed and the limit did nothing.
  drive(driver, observation, driver.intent);
  smoothControls(driver, dt);
  return driver.applied;
};
