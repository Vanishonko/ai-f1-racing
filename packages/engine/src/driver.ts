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
}

export const createDriver = (genes?: Float64Array, random?: () => number): Driver => ({
  genes: genes ?? randomGenes(random ?? (() => { throw new Error("createDriver needs genes or a seeded random source"); })),
  hidden: new Float64Array(HIDDEN_SIZE),
  outputs: new Float64Array(OUTPUT_SIZE),
});

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

  let at = 0;
  for (let unit = 0; unit < HIDDEN_SIZE; unit++) {
    let sum = 0;
    for (let input = 0; input < OBSERVATION_SIZE; input++) {
      sum += genes[at++]! * values[input]!;
    }
    sum += genes[at++]!;
    hidden[unit] = tanh(sum);
  }

  const outputs = driver.outputs;
  for (let output = 0; output < OUTPUT_SIZE; output++) {
    let sum = 0;
    for (let unit = 0; unit < HIDDEN_SIZE; unit++) {
      sum += genes[at++]! * hidden[unit]!;
    }
    sum += genes[at++]!;
    outputs[output] = sum;
  }

  // Throttle and brake are one-sided; steering is symmetric.
  out.throttle = saturateUnit(outputs[0]!);
  out.brake = saturateUnit(outputs[1]!);
  out.steer = clampUnit(outputs[2]!);
};
