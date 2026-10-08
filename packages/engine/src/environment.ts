/**
 * The environment: running a driver through a circuit and scoring it.
 *
 * This is the bridge between the car and the evolution strategy, and it is where the
 * project's central question is decided — "is this driver good?" — so the fitness function
 * is documented in more detail than the code strictly needs.
 *
 * WHAT MAKES A GOOD RACE DRIVER, and what is therefore rewarded:
 *
 *  - AVERAGE SPEED, as the backbone — distance over the run's duration, which is what the sport
 *    means by pace. Everything else is a modifier on it, so a driver cannot score well by being
 *    safe and slow. Distance alone was tried and is WRONG: it makes braking a cost, because a car
 *    that slows for a corner covers less ground. See `FITNESS_WEIGHTS`.
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
import { driveSmoothed, type Controls, type Driver } from "./driver.ts";
import { createObservation, observe, type Observation } from "./sense.ts";
import { gripNoiseAt } from "./rng.ts";
import { MAX_STEER_ANGLE } from "./steerLut.ts";
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

/*
 * WHY THE EVALUATION LENGTH MATTERS MORE THAN IT LOOKS.
 *
 * A driver trained on 45-second runs scored 856 m over 45 s and only 1522 m over 120 s — it fell
 * apart past the window it was selected in, and nothing in the training output said so. A short
 * evaluation does not merely cost accuracy, it selects for drivers that peak early.
 *
 * The default is a lap and a half of the shortest circuit in the set, which is enough for a driver
 * to reach every corner type more than once. Anything evaluating a trained driver should use the
 * same value, which is what `bestDriver`-based verification in the tests does.
 */

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

/**
 * Which quantity the fitness is built on.
 *
 * BOTH EXIST BECAUSE THE CHOICE MATTERS AND WAS MADE BY ARGUMENT RATHER THAN MEASUREMENT. Distance
 * has the flaw that braking costs it, so it discourages the most important skill in racing. Speed is
 * distance over time, which is what the sport means by pace. Keeping both selectable means the
 * difference can be measured instead of assumed, by `scripts/ab-test.ts`.
 */
export type Objective = "speed" | "distance";

/**
 * Reward for passing a point on the circuit, and for completing laps.
 *
 * WHY A LADDER RATHER THAN A SINGLE SCORE AT THE END. A run reports one number when it finishes, and
 * early in training every driver fails the same way — spins, stops, wanders off — so every score is
 * near zero and the search has nothing to climb. That is not hypothetical: it produced eighty
 * generations of literally no progress earlier in this project.
 *
 * Checkpoints break a lap into reachable pieces, so a driver that gets two hundred metres down the
 * road already scores better than one that gets fifty.
 *
 * THE CHECKPOINT REWARD MUST THEN BE TAKEN AWAY AGAIN, which is the part that matters. Left in place
 * it is farmable: a driver can sit on a checkpoint and wobble back and forth collecting it, exactly
 * as an earlier driver learned to drive off the circuit because distance kept accruing across the
 * infield. So the checkpoint weight ANNEALS TO ZERO while the lap weight GROWS, and the search is
 * forced from "get somewhere" to "get round quickly".
 *
 * Checkpoints are DIRECTIONAL and counted once, in order. Without that, the cheapest way to collect
 * them is to drive back and forth across the line.
 */
export interface RewardLadder {
  /** Points per lap, once the lap weight has fully annealed in. */
  lapReward: number;
  /** Points per checkpoint at the start, before annealing. */
  checkpointReward: number;
  /** Generations over which checkpoints fade out and laps fade in. */
  annealGenerations: number;
}

export const DEFAULT_LADDER: RewardLadder = {
  lapReward: 4000,
  checkpointReward: 900,
  annealGenerations: 300,
};

export interface RunOptions {
  /** Seconds of simulated driving. */
  seconds?: number;
  /** Which quantity the fitness is built on. Defaults to average speed. */
  objective?: Objective;
  /** How many checkpoints the circuit is divided into. Zero disables them. */
  checkpointCount?: number;
  /**
   * Ladder weights for this run, already annealed by the caller.
   *
   * The trainer computes these from the generation number; the environment only applies them, so the
   * annealing schedule lives in one place and a single run stays a pure function of its options.
   */
  lapReward?: number;
  checkpointReward?: number;
  /**
   * Overrides the top-speed weight for this run.
   *
   * Exists so the same search can be run with and without the term and the two compared, which is
   * the only way to know whether it helps. A setting that can only be changed by editing the source
   * is a setting nobody measures.
   */
  topSpeedWeight?: number;
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
  /** The scalar the search actually selects on: mean speed in metres per second, adjusted. */
  fitness: number;
  /** Mean speed over the run [m/s]. The headline number the objective is built on. */
  averageSpeed: number;
  /** Fastest speed reached anywhere in the run [m/s]. */
  topSpeed: number;
  /** Checkpoints passed in the correct order. */
  checkpointsPassed: number;
  /**
   * Steering travel per hundred metres, in units of full lock.
   *
   * A smoothness measure worth reporting on its own: low means the driver holds a line, high means
   * it is fighting the car. It is the number behind "smooth is fast".
   */
  steeringWork: number;
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
const FITNESS_WEIGHTS = {
  /**
   * The objective is AVERAGE SPEED, not distance.
   *
   * Distance was the original backbone and it has a specific flaw: BRAKING COSTS DISTANCE. A
   * driver that slows for a corner travels less far in the run than one that does not slow at all,
   * so the objective actively discouraged the single most important skill in racing. Measured, the
   * best driver used the brake for ZERO per cent of a two-minute run — it had learned to avoid the
   * pedal entirely.
   *
   * Average speed is the same measurement the sport uses: distance over time. Every metre gained
   * and every second saved count equally, which makes braking into a corner worth doing, because
   * carrying more speed through it gains more than the braking loses.
   */
  perMetrePerSecond: 1,
  /** Penalty per metre per second for mean tire utilization above the threshold below. */
  utilizationPenalty: 0.35,
  /** Penalty for time spent with the fronts locked. */
  lockPenalty: 0.6,
  /** Penalty for time spent spinning the driven wheels. */
  wheelspinPenalty: 0.25,
  /**
   * Penalty for working the steering against itself.
   *
   * SMOOTH IS FAST, and not only as a style preference: every reversed steering input scrubs speed
   * off the front tires, upsets the platform and makes the car unpredictable to anyone alongside it.
   * A twitching driver is also impossible to race wheel to wheel, which is the entire point of the
   * project.
   *
   * MEASURED BEFORE THIS EXISTED: the evolved driver reversed its steering direction 2,548 times in
   * sixty seconds — forty-two times a second, full lock to full lock. It was not driving, it was
   * vibrating, and nothing in the objective minded. The actuator limit bounds how fast a control can
   * move; this makes the search prefer not to move it at all without reason.
   *
   * Counted as the total steering travel divided by the distance covered, so it is a cost per metre
   * rather than per second, and a driver is not penalised simply for being on a twisty circuit.
   */
  steeringWorkPenalty: 0.06,
  /*
   * Weight on the fastest speed reached anywhere in the run.
   *
   * ADDS A REWARD FOR OUTRIGHT SPEED, which a pace-based objective does not directly ask for.
   * Average speed and top speed are not the same quantity: a driver can hold a respectable average
   * by never slowing much while never using the throttle properly either, and that is what the first
   * trained driver did — FULL THROTTLE FOR EIGHT PER CENT of a run, a peak of 196 km/h against a car
   * capable of 308.
   *
   * Deliberately small. The measured deficit is mostly SUSTAINED speed rather than peak, so this
   * exists to give the search a gradient towards using the throttle at all, not to let one fast
   * straight outscore a clean lap.
   */
  topSpeedWeight: 0.15,
  /** Utilization below this is free; above it costs. */
  utilizationFloor: 0.85,
  /**
   * On-track fraction below which a driver scores almost nothing.
   *
   * A MULTIPLIER, not a penalty, and it exists because the search found the shortcut.
   * Measured: over 130 generations the best fitness rose to 1249 while the fraction of the run
   * spent on the circuit fell from 80 per cent to 15. The driver had learned that leaving the
   * track is fast — the centreline distance keeps accruing as it cuts across the infield — so
   * distance alone was being maximised by not driving the circuit at all.
   *
   * That is not a tuning problem, it is the objective being wrong. A driver that cuts the
   * course has not learned to race, so staying on the circuit gates the score rather than
   * merely contributing to it. Below this floor the fitness collapses towards zero, which
   * makes the floor itself the thing to climb.
   */
  onTrackWeight: 3,
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
): RunResult =>
  runPolicy(
    (observation, controls) => {
      const applied = driveSmoothed(driver, observation, DT);
      controls.throttle = applied.throttle;
      controls.brake = applied.brake;
      controls.steer = applied.steer;
    },
    track,
    options,
    scratch,
  );

/**
 * The same evaluation, driven by any control function rather than by a network.
 *
 * THE POINT IS MEASUREMENT. A trained driver can only be judged against something, and "better
 * than nothing" is not a standard. This lets a hand-written policy, or a scripted manoeuvre, be
 * scored by exactly the same code that scores an evolved driver — same car, same track, same
 * objective, same determinism — so a comparison means something.
 *
 * It is also how a baseline is established: if a few lines of ordinary driving beat a long
 * evolutionary run, the search is what needs attention rather than the driver.
 */
export const runPolicy = (
  policy: (observation: Observation, controls: Controls) => void,
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
   * Steering work: the total distance the wheel travels, in units of full lock. Minimised by
   * holding a line; made large by fighting the car. See `steeringWorkPenalty`.
   */
  let steeringWork = 0;
  let previousSteer = 0;
  let topSpeed = 0;
  /*
   * Checkpoint progress. `nextCheckpoint` is the index of the one being aimed at, so passing them in
   * the wrong order or crossing one repeatedly earns nothing — the count only advances when the
   * correct next one is reached.
   */
  let checkpointsPassed = 0;
  let nextCheckpoint = 0;
  const checkpointCount = options.checkpointCount ?? 0;
  const checkpointStep = checkpointCount > 0 ? track.length / checkpointCount : 0;

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
    steeringWork += Math.abs(car.steerAngle - previousSteer) / MAX_STEER_ANGLE;
    previousSteer = car.steerAngle;

    const speedNow = Math.sqrt(car.vx * car.vx + car.vy * car.vy);
    if (speedNow > topSpeed) topSpeed = speedNow;

    if (checkpointCount > 0) {
      const target = nextCheckpoint * checkpointStep;
      /*
       * `distance` is monotonic along the lap, so a checkpoint counts when the car has travelled past
       * it. Requiring the CORRECT next one is what makes them directional: a car that reverses over a
       * line it has already crossed does not get it again, and a car that cuts the infield to reach a
       * later one does not skip the earlier ones.
       */
      if (car.distance >= target) {
        checkpointsPassed++;
        nextCheckpoint++;
        if (nextCheckpoint >= checkpointCount) nextCheckpoint = 0;
      }
    }

    controls.throttle = 0;
    controls.brake = 0;
    controls.steer = 0;
    policy(observation, controls);
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
   * STAYING ON THE CIRCUIT GATES THE SCORE.
   *
   * Two earlier formulations were tried. An additive bonus let a driver that cut the course
   * outscore one that drove it, because the centreline distance keeps accruing across the
   * infield. Multiplying distance by an on-track factor was better but still not enough: over
   * 130 generations fitness rose to 1249 while on-track time fell to 15 per cent, so the search
   * had found that leaving the circuit is worth more than the factor costs.
   *
   * Below the floor the score therefore collapses towards zero, and above it the factor rises
   * gradually. The floor itself becomes the thing to climb, which is the ordering a racing
   * objective needs: drive the circuit first, then drive it quickly.
   */
  /*
   * The gate is smooth and always increasing, so a driver that is off the circuit can always
   * improve by coming back towards it. See `onTrackWeight` for why a floor was worse than useless.
   */
  const gate = w.onTrackWeight * onTrackFraction * onTrackFraction;
  const averageSpeed = seconds > 0 ? distance / seconds : 0;
  // Steering work per metre covered, so a longer run does not pay more for the same habit.
  const steeringWorkPerMetre = distance > 1 ? (steeringWork / distance) * 100 : 0;
  /*
   * The top-speed term is gated by the same on-track factor, so speed bought by leaving the circuit
   * does not pay. The deficit this addresses is real, but not at the cost of the thing the gate
   * exists to enforce.
   */
  /*
   * The ladder is gated by the same on-track factor as everything else, so a lap completed by cutting
   * across the infield does not score.
   */
  const lapReward = (options.lapReward ?? 0) * laps * gate;
  const checkpointReward = (options.checkpointReward ?? 0) * checkpointsPassed * gate;
  const fitness =
    lapReward +
    checkpointReward +
    averageSpeed * w.perMetrePerSecond * gate +
    topSpeed * (options.topSpeedWeight ?? w.topSpeedWeight) * gate -
    averageSpeed * overLimit * w.utilizationPenalty -
    averageSpeed * lockedFraction * w.lockPenalty -
    averageSpeed * wheelspinFraction * w.wheelspinPenalty -
    steeringWorkPerMetre * w.steeringWorkPenalty;

  return {
    distance,
    onTrackFraction,
    meanUtilization: meanUse,
    lockedFraction,
    wheelspinFraction,
    laps,
    fitness,
    averageSpeed,
    topSpeed,
    checkpointsPassed,
    steeringWork: steeringWorkPerMetre,
  };
};

/** Mean of the four tire utilization values. */
const meanUtilization = (car: CarState): number =>
  (car.utilization[0]! + car.utilization[1]! + car.utilization[2]! + car.utilization[3]!) * 0.25;
