/**
 * The environment: running a driver through a circuit and scoring it.
 *
 * This is the bridge between the car and the evolution strategy, and it is where the
 * project's central question is decided — "is this driver good?" — so the fitness function
 * is documented in more detail than the code strictly needs.
 *
 * WHAT MAKES A GOOD RACE DRIVER, and what is therefore rewarded:
 *
 *  - DISTANCE COVERED, as the backbone. Everything else is a modifier on it, so a driver
 *    cannot score well by being safe and slow.
 *  - STAYING ON THE CIRCUIT. Off-track time is penalised, and penalised in PROPORTION to
 *    how far off, because a wheel over the line is a small mistake and a car in the
 *    barriers is a large one. A cliff-edge penalty at the track limit would make the
 *    search unable to tell the difference.
 *  - SLIP MANAGEMENT. Time spent with the tires saturated is penalised, which is what
 *    teaches a driver not to slide the car everywhere. This is the same quantity the tire
 *    model was built to expose, and it is why locking the fronts is punished.
 *  - PROGRESS RATHER THAN SPEED. A car facing the wrong way covers no distance however
 *    fast its wheels turn, so distance-along-the-track is used rather than speed. That
 *    falls out of projecting the car rather than integrating its velocity, which also
 *    means a driver cannot farm fitness by spinning on the spot.
 *
 * THE EVALUATION IS DETERMINISTIC. A fixed timestep, a fixed starting state, a fixed grip
 * variation with track position and a seeded grip noise, so the same genes always score
 * the same. Without that, a training curve is noise and no change can be attributed to
 * anything.
 *
 * THE CAR ALWAYS STARTS FROM REST on the centreline. That is a harder starting condition
 * than a flying lap, and it means a driver must also learn to launch, which is a real part
 * of racing and the first thing the throttle/clutch work made possible.
 */

import {
  CLEAN_AIR,
  createCarState,
  DEFAULT_CAR_PARAMS,
  stepCar,
  type CarParams,
  type CarState,
  type StepContext,
} from "./car.ts";
import { drive, type Controls, type Driver } from "./driver.ts";
import { createObservation, observe, type Observation } from "./sense.ts";
import { gripNoiseAt } from "./rng.ts";
import { pointAtDistance, type Track } from "./track.ts";

/** Physics timestep. Fixed, because the whole evaluation depends on it. */
export const DT = 1 / 60;

/**
 * How long a driver is given for one evaluation [s].
 *
 * Long enough for several laps of the shortest circuit, so a driver that is quick but
 * fragile cannot outscore one that is consistent. The cost is that every candidate in
 * every generation pays this, which is the dominant expense of a training run.
 */
export const DEFAULT_RUN_SECONDS = 90;

/**
 * Where a car starts, cached per circuit.
 *
 * The heading is an angle and the track gives a direction, so the conversion needs an
 * inverse trigonometric function — which the determinism contract bans. Rather than
 * contort the code to avoid one, or add an exemption for a module that is not a baking
 * file, the conversion is done ONCE per circuit and the answer kept. The contract cares
 * about trig on the per-tick path; a value computed once per circuit cannot drift between
 * engines any more than a baked table can.
 */
interface StartState {
  x: number;
  y: number;
  heading: number;
}

const START_CACHE = new WeakMap<Track, StartState>();

const startStateFor = (track: Track): StartState => {
  const cached = START_CACHE.get(track);
  if (cached) return cached;

  const point = pointAtDistance(track, 0);
  const state: StartState = {
    x: point.x,
    y: point.y,
    heading: Math.atan2(point.ty, point.tx),
  };
  START_CACHE.set(track, state);
  return state;
};

export interface RunOptions {
  /** Seconds of simulated driving. */
  seconds?: number;
  /** Per-car physics, so a trained driver can be evaluated on a modified car. */
  params?: CarParams;
  /** True to record a trace for playback. Off by default because it costs memory. */
  trace?: boolean;
  /** Called every step with the car state when tracing is on. */
  onStep?: (car: CarState, elapsed: number) => void;
}

export interface RunResult {
  /** Metres of progress along the centreline. Always positive, never decreases. */
  distance: number;
  /** Fraction of the run spent inside the drivable width. */
  onTrackFraction: number;
  /** Mean tire utilization across the run. 1 means permanently on the limit. */
  meanUtilization: number;
  /** Fraction of the run with the fronts locked. */
  lockedFraction: number;
  /** Fraction of the run with the driven wheels spinning. */
  wheelspinFraction: number;
  /** Laps completed, counted from crossings of the start line. */
  laps: number;
  /** The scalar the search actually selects on. */
  fitness: number;
}

/**
 * Fitness weights.
 *
 * Exposed together because they define the objective and should be read as a set. The
 * backbone term dominates: a driver that covers twice the distance with twice the mistakes
 * should still win comfortably, which is what keeps the search pointed at going faster
 * rather than at being tidy.
 *
 * `meanUtilization` is weighted below the others on purpose. A quick driver spends a real
 * fraction of every lap at the limit, and penalising that hard would select for a cautious
 * driver that never slides — the opposite of what is wanted. What is punished is spending
 * time SATURATED and LOCKED, not using the tires.
 */
export const FITNESS_WEIGHTS = {
  /** Fitness per metre of progress. Sets the overall scale. */
  perMetre: 1,
  /**
   * Fitness per metre, per unit of on-track fraction, on top of the above.
   *
   * RAISED from 0.5 after watching a run plateau: at 0.5 a driver that left the circuit
   * often still outscored one that stayed on it, because leaving the circuit is fast. The
   * modifier is now large enough that a clean lap beats a scrappy one of the same length,
   * which is the ordering the whole exercise depends on.
   */
  onTrackBonus: 2.5,
  /** Penalty per metre for mean tire utilization above the threshold below. */
  utilizationPenalty: 0.35,
  /** Penalty per metre for time spent with the fronts locked. */
  lockPenalty: 0.6,
  /** Penalty per metre for time spent spinning the driven wheels. */
  wheelspinPenalty: 0.25,
  /** Utilization below this is free; above it costs. */
  utilizationFloor: 0.85,
} as const;

/**
 * Runs one driver for one evaluation and returns its score.
 *
 * A scratch car, observation and control set can be passed in so a search loop allocates
 * nothing per candidate — with thousands of candidates per generation that matters more
 * than the clarity of allocating here would be worth.
 */
export const runDriver = (
  driver: Driver,
  track: Track,
  options: RunOptions = {},
  scratch?: { car: CarState; observation: Observation; controls: Controls },
): RunResult => {
  const seconds = options.seconds ?? DEFAULT_RUN_SECONDS;
  const params = options.params ?? DEFAULT_CAR_PARAMS;
  const start = startStateFor(track);
  const car = scratch?.car ?? createCarState();
  const observation = scratch?.observation ?? createObservation();
  const controls = scratch?.controls ?? { throttle: 0, brake: 0, steer: 0 };

  // Start from rest on the centreline, pointing along the track.
  car.x = start.x;
  car.y = start.y;
  car.heading = start.heading;
  car.vx = 0;
  car.vy = 0;
  car.yawRate = 0;
  car.omega.fill(0);
  car.steerAngle = 0;
  car.steerCommand = 0;
  car.throttle = 0;
  car.brake = 0;
  car.gear = 1;
  car.rpm = params.engine.idleRpm;
  car.shiftTimer = 0;
  car.wear.fill(0);
  car.frontLockTime = 0;
  car.wheelspinTime = 0;
  car.saturatedTime = 0;
  car.distance = 0;

  const context: StepContext = { ...CLEAN_AIR };

  let previousDistance = 0;
  let progress = 0;
  let onTrackSteps = 0;
  let utilizationSum = 0;
  let lockedSteps = 0;
  let wheelspinSteps = 0;
  let laps = 0;

  /*
   * The car's lock and wheelspin timers are CUMULATIVE, so they are differenced rather
   * than tested. Testing `frontLockTime > 0` would count every step after the first lock
   * as locked for the rest of the run, which would make the penalty meaningless and
   * punish a single mistake for ninety seconds.
   */
  let previousLockTime = 0;
  let previousWheelspinTime = 0;

  const totalSteps = Math.round(seconds / DT);
  for (let step = 0; step < totalSteps; step++) {
    observe(observation, car, track, previousDistance);

    /*
     * Progress along the track, accumulated from the projection and unwrapped at the start
     * line so it is monotonic. Distance along the centreline is used rather than the car's
     * own odometer because a car facing the wrong way covers no ground however fast its
     * wheels turn, and a spinning car must not be able to farm fitness.
     */
    const advanced = observation.distance - previousDistance;
    if (advanced < -track.length / 2) progress += advanced + track.length;
    else if (advanced > track.length / 2) progress += advanced - track.length;
    else progress += advanced;
    previousDistance = observation.distance;

    // Laps come from progress rather than from the wrap above, which also fires when a
    // car crosses the line backwards. Progress is monotonic, so it cannot be gamed.
    laps = Math.floor(progress / track.length);

    if (observation.onTrack) onTrackSteps++;
    utilizationSum += meanUtilization(car);

    const lockDelta = car.frontLockTime - previousLockTime;
    const spinDelta = car.wheelspinTime - previousWheelspinTime;
    previousLockTime = car.frontLockTime;
    previousWheelspinTime = car.wheelspinTime;
    if (lockDelta > 0) lockedSteps++;
    if (spinDelta > 0) wheelspinSteps++;

    drive(driver, observation, controls);
    car.throttle = controls.throttle;
    car.brake = controls.brake;
    car.steerCommand = controls.steer;

    context.gripNoise = gripNoiseAt(car.distance, track.length);
    stepCar(car, params, DT, context);

    if (options.onStep) options.onStep(car, step * DT);
  }

  const steps = totalSteps;
  const onTrackFraction = steps > 0 ? onTrackSteps / steps : 0;
  const meanUse = steps > 0 ? utilizationSum / steps : 0;
  const lockedFraction = steps > 0 ? lockedSteps / steps : 0;
  const wheelspinFraction = steps > 0 ? wheelspinSteps / steps : 0;

  const distance = Math.max(0, progress);
  const w = FITNESS_WEIGHTS;
  const overLimit = meanUse > w.utilizationFloor ? meanUse - w.utilizationFloor : 0;

  /*
   * The on-track term is a MULTIPLIER on distance rather than an additive bonus, so that a
   * driver cannot bank progress by charging off the circuit and rejoining. A car in the
   * barriers covers no distance along the centreline, and this makes that explicit in the
   * arithmetic.
   */
  const fitness =
    distance * (w.perMetre + w.onTrackBonus * onTrackFraction) -
    distance * overLimit * w.utilizationPenalty -
    distance * lockedFraction * w.lockPenalty -
    distance * wheelspinFraction * w.wheelspinPenalty;

  return {
    distance,
    onTrackFraction,
    meanUtilization: meanUse,
    lockedFraction,
    wheelspinFraction,
    laps,
    fitness,
  };
};

/** Mean of the four tire utilization values. */
const meanUtilization = (car: CarState): number =>
  (car.utilization[0]! + car.utilization[1]! + car.utilization[2]! + car.utilization[3]!) * 0.25;
