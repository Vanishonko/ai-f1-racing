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
import { SectorTracker } from "./sectors.ts";

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

/**
 * The three rewards, sized so their ORDER expresses what racing is.
 *
 * MEASURED BEFORE THESE NUMBERS WERE CHOSEN, on scripted runs that actually drive, with the old weights
 * of 4000 per lap and 900 per checkpoint:
 *
 *   on-track 64%   distance 1114 m   distance reward 111   POINTS FROM CHECKPOINTS 3924
 *
 * Checkpoints outweighed distance by a factor of thirty-five while the driver was off the circuit for
 * a third of the run. That is the wrong ordering twice over: it says that scraping past a corner is
 * worth more than driving, and it says that a driver spending a third of its time on the grass is
 * doing well. The suspicion that the on-track punishment was too weak was correct.
 *
 * The ladder is now an ORDER rather than a set of numbers: a lap is worth ten checkpoints, a checkpoint
 * is worth a few hundred metres, and distance is a steady floor underneath both that is never gated,
 * so a car which has not yet learned to move still has something to climb.
 */
export const DEFAULT_LADDER: RewardLadder = {
  /** A completed lap, gated on staying on the circuit. The objective. */
  lapReward: 12000,
  /** Passing a corner well, scaled by the speed carried. Roughly a forty-second of a lap. */
  checkpointReward: 250,
  /**
   * Generations over which sector credit fades and lap credit grows.
   *
   * THE ANNEAL MUST OUTLAST THE LEARNING, and an earlier setting of a hundred and fifty did not. By
   * that generation a randomly-initialised population still cannot complete a lap — measured, a
   * scripted driver that steers properly manages a thousand to seventeen hundred metres of a
   * thirty-five hundred metre circuit — so the only reward still standing was the lap, which nobody
   * could reach, and distance. The search was left with no signal from the corners at exactly the
   * point it needed one.
   *
   * Checkpoints fading is right, because they are farmable. Checkpoints fading BEFORE anything can
   * complete a lap is a schedule that guarantees the search has nothing to climb.
   *
   * THE HORIZON IS SET IN THE UNITS TRAINING ACTUALLY RUNS IN. At a measured 1.4 generations per
   * second with eight workers, the earlier 2,500 annealed away in half an hour and the 6,000 first
   * tried here was spent by the end of the first hour — so a run left going overnight spent almost all
   * of its time with the corner signal at zero and the elite's record saturating. This is the value
   * that was wanted, computed rather than guessed:
   *
   *     anneal   corner signal remaining after 0.5 h   1 h   2 h   4 h   8 h
   *      6,000                               62%         7%     0%     0%     0%
   *     12,000                               89%        62%     7%     0%     0%
   *     25,000                               97%        89%    64%    10%     0%
   *     40,000                               99%        96%    84%    49%    15%
   *
   * 25,000 keeps the corner reward worth having for roughly three hours and hands the objective over
   * to the lap well inside a working day. 40,000 was rejected for the opposite failure to the original:
   * the lap reward reaches full weight so late that a run which has already learned to lap is still
   * being paid mostly for corners, which is the farmable regime.
   */
  annealGenerations: 25000,
};

/**
 * The yardstick a driver's RECORD is kept against, fixed for the life of the project.
 *
 * This is the full racing objective with both terms at their settled weights, and it is deliberately
 * NOT a snapshot of the annealing schedule. That distinction was got wrong once and cost a great deal:
 * the record was taken under `ladderFor(0)`, which is `{ lapReward: 0, checkpointReward: 500 }` — the
 * generation-zero objective, under which a lap is worth nothing at all. The elite was therefore ranked
 * purely on corner credit, which saturates, so a driver that improved its lap times could not move the
 * number it was being judged by.
 *
 * Keeping it separate from `DEFAULT_LADDER` means the annealing schedule can be retuned without
 * invalidating every recorded score, which is a comparison the whole project depends on.
 */
export const REFERENCE_LADDER: RewardLadder = {
  lapReward: 12000,
  checkpointReward: 250,
  /*
   * Unused by the reference, and present only because it shares `RewardLadder`'s type. A yardstick
   * that annealed would not be a yardstick.
   */
  annealGenerations: 25000,
};

export interface RunOptions {
  /** Seconds of simulated driving. */
  seconds?: number;
  /** Which quantity the fitness is built on. Defaults to average speed. */
  objective?: Objective;
  /** How many checkpoints the circuit is divided into. Zero disables them. */
  checkpointCount?: number;
  /**
   * Place checkpoints at corner entry, apex and exit instead of evenly.
   *
   * The default for training, because it measures the reward where the lap is actually decided.
   */
  cornerCheckpoints?: boolean;
  /** Cornering limit used to normalise checkpoint rewards. See `DEFAULT_GRIP_LIMIT`. */
  gripLimit?: number;
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
  /** Checkpoints passed in the correct order. Should be about `checkpointCount` per lap. */
  checkpointsPassed: number;
  /** The ungated distance reward, reported separately so it can be seen not to dominate. */
  distanceReward: number;
  /** What the lap term actually paid, so the ladder can be seen working. */
  lapReward: number;
  /** What the sector term actually paid, for the same reason. */
  checkpointReward: number;
  /**
   * Mean sector credit, in [0, 1]: how well the corners met were driven.
   *
   * The number behind cornering behaviour. Near 1 means the car carried close to the grip-limited
   * speed through nearly every checkpoint it reached.
   */
  checkpointCredit: number;
  /** Fastest speed carried through any checkpoint on the final lap, as a fraction of its limit. */
  checkpointBestFraction: number;
  /** Fastest speed carried through any checkpoint in the whole run, as a fraction of its limit. */
  checkpointPeakFraction: number;
  /** Mean sector credit over completed laps only, so a partial final lap does not dilute it. */
  meanLapCredit: number;
  /** How many corner checkpoints this circuit has. */
  checkpointCount: number;
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

  /*
   * A STEADY, ALWAYS-GROWING REWARD FOR GROUND COVERED.
   *
   * The other three terms are all gated by the on-track fraction, which is right — a lap cut across
   * the infield is not a lap — but it left the search with NO gradient at all in the state every
   * driver starts in. Measured: with the gate multiplying everything, a car that had not yet learned
   * to move scored exactly 0.0 for the speed term, so the very first thing to learn — press the
   * throttle — had nothing pointing towards it. A driver that cannot move cannot reach a checkpoint
   * either, so all four terms were simultaneously zero and the landscape was flat.
   *
   * Distance is therefore only PARTLY gated, and finding that number is the whole story of this
   * constant. Fully gated, it contributes nothing until a driver can already stay on the circuit,
   * which is the problem it exists to solve. Fully UNGATED, it is farmed: measured after fourteen
   * thousand generations, the best driver found scored 2961 — of which 2699 came from driving two and
   * a half kilometres with its on-track gate at 0.0007. A careful scripted driver staying entirely on
   * the circuit scored 2057. THE SEARCH HAD LEARNED THAT LEAVING THE TRACK PAYS, and it was right.
   *
   * The factor below is therefore a ramp rather than a gate: a fifth of the reward is available
   * immediately, so a car that cannot yet drive still has something to climb, and the remaining four
   * fifths arrive as it learns to stay on the circuit. Monotonic in on-track fraction at every value,
   * which is what makes it unprofitable to trade the circuit for distance.
   */
  distanceReward: 1.0,
  /** The share of the distance reward available regardless of where the car is. */
  distanceUngatedShare: 0.2,
  /**
   * The average speed, in metres per second, at which a completed lap earns its full reward.
   *
   * About a hundred and thirty kilometres per hour, which is a competent lap of this circuit rather
   * than a spectacular one — the point is that the top of the range should be reachable, and that a
   * crawl round should not pay the same as a racing lap.
   */
  lapPaceReference: 36,
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
   * SECTOR AND LAP TIMING.
   *
   * A lap is won in the corners, so that is where the reward is measured: `cornerCheckpoints` places
   * a checkpoint at the entry, apex and exit of every corner. Rewarding mere passage through one is
   * farmable the obvious way — CUT IT, because the shortest path through a corner clips the inside —
   * so what is paid for is the SPEED CARRIED, as a fraction of the grip-limited speed for the
   * curvature there, and only when the car was on the circuit as it crossed. Cutting puts the car on
   * the grass and forfeits that sector; taking it slowly forfeits most of it.
   *
   * The per-lap bookkeeping lives in `SectorTracker`, which is where the two ways this measurement
   * silently stops measuring are documented and guarded.
   */
  const sectors = new SectorTracker(track, {
    cornerCheckpoints: options.cornerCheckpoints,
    checkpointCount: options.checkpointCount,
    gripLimit: options.gripLimit,
  });
  const checkpointCount = sectors.count;
  /** Set each step from the observation, so "on the circuit" has one definition. */
  let carOnTrack = true;

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
    /*
     * PROGRESS IS ACCUMULATED FROM THE STEP ALONG THE CENTRELINE, AND A WRAP IS NOT A STEP.
     *
     * `observation.distance` is the projection onto the centreline and is therefore circular: it runs
     * 0..track.length and snaps back through zero at the start line. The obvious repair for that is to
     * detect the snap by its size and add the track length back on, and it is what this did:
     *
     *     if (advanced < -track.length / 2) progress += advanced + track.length;
     *     else if (advanced > track.length / 2) progress += advanced - track.length;
     *
     * The first branch is right for a car crossing the line FORWARDS — `advanced` is a small negative
     * number and adding a lap recovers it. The second branch is wrong for a car crossing BACKWARDS, and
     * that is not a rare case: a car oscillating across the line, which is exactly what a spinning or
     * badly-driven car does near its start point, steps s from 3.5 m to 3520 m and back. The second
     * branch sees +3517, subtracts a lap, and adds the remainder — so the crossing ADVANCES progress
     * instead of unwinding it, and every genuine step after it is then large enough to be treated as
     * another wrap. Measured on a run doing exactly that: the whole 90-second run reported 0 m of
     * progress while the car covered 320 m of odometer, and its fitness was built on the phantom.
     *
     * THE FIX IS THAT A WRAP CARRIES NO INFORMATION, so it is skipped rather than interpreted. There is
     * no need to guess a direction, because a crossing contributes nothing on its own: what a car gains
     * by going round is the ordinary steps it takes either side of the line, and those are small. A car
     * that crosses forwards still earns the metres it drives on the far side; a car that crosses
     * backwards and re-crosses has, correctly, gone nowhere.
     *
     * A whole lap in one tick is also physically impossible — at 60 Hz it would need 211,000 km/h — so
     * this discards only artefacts. Measured across seven drivers over 12,600 ticks: 99.88 per cent of
     * steps are within 2 m, and every outlier is exactly +/- track length.
     */
    const advanced = observation.distance - previousDistance;
    if (advanced < track.length / 2 && advanced > -track.length / 2) progress += advanced;
    previousDistance = observation.distance;

    const completedLaps = Math.max(0, Math.floor(progress / track.length));

    carOnTrack = observation.onTrack;
    if (carOnTrack) onTrackSteps++;
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

    /*
     * `car.distance` is the car's own odometer and is MONOTONIC — it accumulates across laps rather
     * than resetting at the line — which is exactly what the sector machine needs, because its
     * targets rise lap on lap. See `SectorTracker` for why wrapping the counter back to zero instead
     * makes every checkpoint re-fire on every tick after the first lap.
     */
    sectors.update(car.distance, speedNow, carOnTrack);

    /*
     * Bank the lap's sectors as soon as the line is crossed, and start a fresh lap.
     *
     * Draining the bank happens ONLY here, so a lap's credit is paid once and the term keeps
     * measuring lap after lap instead of saturating on the best lap of the run. Order matters: the
     * lap is closed before the reward is read below, so the lap reward and the sector credit it is
     * paid alongside describe the same driving.
     */
    if (completedLaps > laps) sectors.completeLap();
    laps = completedLaps;

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
  /*
   * CUBED, not squared. The gate has to make going off the circuit genuinely expensive rather than
   * merely unrewarding, and squaring was too forgiving: measured, a driver off the circuit for
   * forty-four per cent of a run still took ninety-four per cent of the available credit. Cubed takes
   * that to fifty-three per cent, while a driver on the circuit for ninety per cent of the time keeps
   * seventy-three per cent instead of eighty-one — a real cost for real excursions, and no penalty
   * worth noticing for a clean lap.
   */
  const gate = w.onTrackWeight * onTrackFraction * onTrackFraction * onTrackFraction;
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
  /*
   * A COMPLETED LAP PAYS IN PROPORTION TO HOW FAST IT WAS.
   *
   * Without this the lap reward is a cliff: nothing at all until a driver can complete a lap, then
   * five thousand. Measured, the consequence was a search that spent sixteen hundred generations
   * unable to beat a record it had set before the cliff existed — the record was 9615 under an
   * objective where checkpoints paid, and under the current objective the same parameters are worth
   * 1174 because the lap it could not finish pays nothing.
   *
   * Scaling by pace turns the cliff into a slope. A laboured lap earns a fraction, a quick one earns
   * full marks, and the gradient exists from the first lap anybody manages rather than from a
   * generation chosen in advance. `lapPaceReference` is the speed at which a lap is judged complete
   * value: set near the pace a competent driver reaches, so the top of the range is reachable and the
   * bottom is not free.
   */
  const lapPace = Math.min(1, averageSpeed / w.lapPaceReference);
  const lapReward = (options.lapReward ?? 0) * laps * gate * lapPace;
  /*
   * A ramp, not a gate and not a free pass. See `distanceReward`: the ungated share gives a car that
   * cannot yet drive something to climb, and the rest arrives as it learns to stay on the circuit, so
   * trading the circuit for distance is never profitable.
   */
  const distanceTerm =
    distance * w.distanceReward * (w.distanceUngatedShare + (1 - w.distanceUngatedShare) * onTrackFraction);

  /*
   * SECTOR CREDIT IS THE SPEED ACTUALLY CARRIED, as a fraction of what the car could have carried
   * there, averaged over the corners it met.
   *
   * The grip-limited speed for the curvature at a checkpoint is the fastest a car with this much grip
   * can physically go round it. Expressing the reward as a fraction OF that is what makes a hairpin and
   * a fast sweeper worth the same for the same quality of driving, rather than paying most for the
   * corner that happens to be taken fastest.
   *
   * Paid on the AVERAGE rather than the sum, and this changed when the per-lap reset was added. While
   * the credit was a run-long high-water mark the natural quantity was "how many checkpoints have you
   * ever cleared", which saturates. Now that every lap is measured, the meaningful question is "how
   * well are you driving the corners", which is a mean and stays comparable however many laps the run
   * contains. The sum would pay a long run more for the same driving, which is a run-length artefact
   * rather than a fact about the driver.
   */
  const sectorCredit = sectors.credit;
  const checkpointReward = (options.checkpointReward ?? 0) * checkpointCount * sectorCredit;
  const fitness =
    distanceTerm +
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
    checkpointsPassed: sectors.checkpointsPassed,
    distanceReward: distanceTerm,
    lapReward,
    checkpointReward,
    checkpointCredit: sectorCredit,
    checkpointBestFraction: sectors.bestFraction,
    checkpointPeakFraction: sectors.peakFraction,
    meanLapCredit: sectors.meanLapCredit,
    checkpointCount,
    steeringWork: steeringWorkPerMetre,
  };
};

/** Mean of the four tire utilization values. */
const meanUtilization = (car: CarState): number =>
  (car.utilization[0]! + car.utilization[1]! + car.utilization[2]! + car.utilization[3]!) * 0.25;
