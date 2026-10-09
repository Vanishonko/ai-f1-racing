/**
 * Drivable viewer: renders the deterministic sim and lets you drive it.
 *
 * The physics here is THE SAME code the trainer will run. Nothing is forked or
 * simplified for display, so what you feel in this page is what the evolutionary
 * search will be optimising against. That is only possible because the engine has
 * no DOM or I/O dependencies and is bit-deterministic.
 *
 * Imports use relative paths so the typechecker can resolve them, but the build
 * rewrites each specifier to `/engine/*.js` for the browser. Keeping the source
 * importable by `tsc` matters: without it the viewer would be unchecked
 * JavaScript and a typo here would only show up as a blank canvas.
 */

import {
  CLEAN_AIR,
  createCarState,
  DEFAULT_CAR_PARAMS,
  stepCar,
  WHEEL_FL,
  WHEEL_FR,
  WHEEL_RL,
  WHEEL_RR,
  type CarState,
  type StepContext,
} from "../../engine/src/car.ts";
import { buildCircuitByKey, CIRCUITS, DEFAULT_TRACK_KEY } from "../../engine/src/trackLibrary.ts";
import {
  projectToTrack,
  projectToTrackNear,
  pointAtDistance,
  cornerCheckpoints,
  type Track,
} from "../../engine/src/track.ts";
import { createTiming, updateTiming, formatTime } from "../../engine/src/timing.ts";
import { gripNoiseAt } from "../../engine/src/rng.ts";
import { createDriver, drive, PARAMETER_COUNT, type Driver } from "../../engine/src/driver.ts";
import { createObservation, observe } from "../../engine/src/sense.ts";
import { tireForces } from "../../engine/src/tire.ts";

const canvas = document.getElementById("view") as HTMLCanvasElement;
const ctx = canvas.getContext("2d")!;

/**
 * The active track. Swappable at runtime, which is the whole point of having a
 * track library: a driver that is quick on one layout and slow on another is the
 * interesting case, and it is impossible to notice that without switching.
 */
let track: Track = buildCircuitByKey(DEFAULT_TRACK_KEY)!;

/**
 * Debug and measurement handle, exposed on `window`.
 *
 * It exists because steering direction is the one property no engine test can
 * check: every force and moment can be self-consistent while the car turns the
 * wrong way, and that is exactly what happened. Reading the live heading out of a
 * running page is how the convention was finally settled.
 *
 * The track field must be REASSIGNED on every circuit switch. Capturing the object
 * once at startup snapshots the value, so measurements would silently describe the
 * track you had just left.
 */
interface SimHandle {
  car: typeof car;
  track: Track;
  params: typeof params;
  stepContext: StepContext;
  resetToStart: () => void;
  held: Set<string>;
  selectTrack: (key: string) => void;
  /** The camera, so zoom and rotation can be inspected from outside. */
  camera: { x: number; y: number; scale: number };
  setZoom: (factor: number) => void;
  setChaseRotation: (on: boolean) => void;
  zoomState: () => { chaseZoom: number; overviewZoom: number; chaseRotates: boolean; rotation: number };
  setPlayback: (speed: number) => void;
  playback: () => number;
  sessionSeconds: () => number;
  seek: (seconds: number) => void;
  stepFrame: () => void;
}
let simHandle: SimHandle | null = null;
const car: CarState = createCarState();
const params = DEFAULT_CAR_PARAMS;
const stepContext: StepContext = { ...CLEAN_AIR };

const DT = 1 / 60;
const TRAIL_LENGTH = 220;
const trail: Array<{ x: number; y: number }> = [];

/** Keys currently held, so throttle and steering can ramp like real inputs. */
const held = new Set<string>();

/** Real F1 splits the lap into three sectors, and so does this. */
const SECTOR_COUNT = 3;

/**
 * Sector and lap timing.
 *
 * Distance comes from projecting the car onto the centreline each step rather than
 * from a counter the car maintains. The physics core is kept free of any notion of
 * laps or sectors so it stays replayable and testable, and the projection is already
 * the authoritative answer to "where on the track is this car".
 */
let timing = createTiming(track.length, SECTOR_COUNT);
let sessionTime = 0;
let lastProjectedS = 0;

/*
 * DRIVER STATE, declared before the reset that clears it.
 *
 * `resetToStart` calls into these, so they must exist by the time it can run. An earlier version had
 * them further down the file, which is a temporal dead zone error the moment the reset is called
 * rather than a subtlety — the page failed to load at all.
 */
let driver: Driver | null = null;

/**
 * What the loaded checkpoint was, so the panel can say which driver is driving.
 *
 * A generation number is the only way to tell two checkpoints apart at a glance, and without it there
 * is no way to know whether the thing on screen is the run you just finished or one from an hour ago.
 */
interface DriverInfo {
  generation: number;
  fitness: number;
  trainedSeconds: number;
  circuit: string;
}
let driverInfo: DriverInfo | null = null;
const observation = createObservation();
const aiControls = { throttle: 0, brake: 0, steer: 0 };

/** True when the AI is driving rather than the keyboard. */
let aiDriving = false;

const resetToStart = (): void => {
  const point = pointAtDistance(track, 0);
  car.x = point.x;
  car.y = point.y;
  car.heading = Math.atan2(point.ty, point.tx);
  car.vx = 0;
  car.vy = 0;
  car.yawRate = 0;
  car.omega.fill(0);
  car.steerAngle = 0;
  car.steerCommand = 0;
  car.throttle = 0;
  car.brake = 0;
  // First gear, not neutral: gear index 0 is the first ratio.
  car.gear = 1;
  car.rpm = params.engine.idleRpm;
  car.wear.fill(0);
  car.frontLockTime = 0;
  car.wheelspinTime = 0;
  car.saturatedTime = 0;
  car.distance = 0;
  trail.length = 0;
  sessionTime = 0;
  /*
   * `lastProjectedS` MUST be reset with everything else.
   *
   * It is the reference the lap-distance projection measures against, so leaving it at wherever the
   * car happened to be makes the next step compute a gap from the wrong place. The symptom was
   * specific and only showed up on the SECOND rewind: replaying to five seconds gave 348 m the first
   * time and 0 m the second, because the stale reference made the projection think the car had
   * wrapped past the start line. A state variable that is read every step has to be reset with the
   * rest, and this one was missed because nothing else in the reset resets it.
   */
  lastProjectedS = 0;
  timing = createTiming(track.length, SECTOR_COUNT);

  resetDriverState();
};

/**
 * Clears the driver's own carried state.
 *
 * A driver is NOT a pure function of the current observation: it holds the rate-limited actuator
 * positions from the previous step. Those are not part of the car, so resetting the car alone leaves
 * them behind, and because they feed the next control decision a rewind lands somewhere different
 * every time — measured, replaying to five seconds gave 93.99 m, 96.31 m and 99.12 m on three
 * consecutive attempts.
 *
 * That is the difference between replay working and merely appearing to: an inexact rewind looks
 * like physics noise and is actually forgotten state.
 *
 * Declared as a separate function because it refers to bindings defined further down the file, and
 * calling them from `resetToStart` directly is a temporal dead zone error rather than a subtlety.
 */
const resetDriverState = (): void => {
  aiControls.throttle = 0;
  aiControls.brake = 0;
  aiControls.steer = 0;
  if (!driver) return;
  driver.applied.throttle = 0;
  driver.applied.brake = 0;
  driver.applied.steer = 0;
  driver.intent.throttle = 0;
  driver.intent.brake = 0;
  driver.intent.steer = 0;
  /*
   * The steering RATE as well, because the steering is a second-order system and the rate is half its
   * state. Left behind, a rewound or reset car carries the wheel's previous motion and keeps turning
   * from a movement it no longer has.
   */
  driver.steerRate = 0;
};

/**
 * Writes the lap and sector panel.
 *
 * Colours follow the convention the sport uses, so the panel reads at a glance:
 * purple for a session best in that sector, green for a personal best, and the default
 * colour otherwise. Showing the best time per sector makes it obvious where a lap is
 * being won or lost rather than only reporting the total.
 */
const updateTimingPanel = (): void => {
  setText("lapCount", `${timing.laps}`);
  setText("lastLap", formatTime(timing.lastLap ? timing.lastLap.time : null));
  setText("bestLap", formatTime(timing.bestLap));
  setText("sectorNow", `${Math.min(timing.sectorsDone + 1, SECTOR_COUNT)} / ${SECTOR_COUNT}`);

  const last = timing.lastLap?.sectors ?? [];
  for (let i = 0; i < SECTOR_COUNT; i++) {
    const done = last[i];
    const isLast = i === last.length - 1 && done !== undefined;
    setText(`s${i + 1}`, done === undefined ? "--.---" : done.toFixed(3));
    setClass(`s${i + 1}`, isLast && timing.lastGrade === "purple" ? "purple"
      : isLast && timing.lastGrade === "personal" ? "personal" : "");
    setText(`b${i + 1}`, timing.sectorBests[i] === null ? "--.---" : timing.sectorBests[i]!.toFixed(3));
  }
};

/**
 * Switches circuits.
 *
 * The camera refits on the next frame, so a small track and a large one are both
 * framed sensibly without any per-track tuning. What you learn from switching is
 * the point: a genome that is quick here and slow there is the interesting case,
 * and it is invisible on a single layout.
 */
const selectTrack = (key: string): void => {
  const next = buildCircuitByKey(key);
  if (!next) return;
  track = next;
  // The debug handle must be updated too. Assigning the object once at startup
  // captures the VALUE, so after a switch it kept pointing at the old circuit and
  // every measurement taken through it was of the track we had just left.
  if (simHandle) simHandle.track = next;
  resetToStart();
  // A driver is trained for one circuit, so a checkpoint must be reloaded on a switch.
  void fetchDriverFor(key);
};

resetToStart();

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------
window.addEventListener("keydown", (event: KeyboardEvent) => {
  held.add(event.key.toLowerCase());
  if (event.key === " ") event.preventDefault();

  /*
   * Camera keys are handled here rather than through `held`, because they are one-shot actions
   * rather than continuous controls. A zoom that repeated while a key was held would run away.
   */
  switch (event.key) {
    case "r":
    case "R":
      resetToStart();
      break;
    case "v":
    case "V":
      // Toggle whether the chase camera rotates to the car's heading.
      chaseRotates = !chaseRotates;
      break;
    case "+":
    case "=":
      zoomBy(1.15);
      break;
    case "-":
    case "_":
      zoomBy(1 / 1.15);
      break;
    case "0":
      chaseZoom = 1;
      overviewZoom = 1;
      break;

    /*
     * PLAYBACK. The layout is the one every video player uses, because the point is to slow a
     * corner down and step through it without having to learn a new scheme.
     *
     *   P        pause and resume
     *   J / L    back and forward five seconds
     *   , / .    back and forward a single frame
     *   [ / ]    slower and faster
     *
     * Going BACK is a deterministic replay from the start rather than a stored history: the
     * simulation is reproducible, so fast-forwarding to an earlier time reproduces exactly the state
     * that was there. Storing frames would be a second source of truth for the car's state and would
     * disagree with the first one eventually.
     */
    case "p":
    case "P":
      playbackSpeed = playbackSpeed === 0 ? 1 : 0;
      lastTime = performance.now();
      break;
    case "j":
    case "J":
      fastForwardTo(Math.max(0, sessionTime - 5));
      lastTime = performance.now();
      break;
    case "l":
    case "L":
      fastForwardTo(sessionTime + 5);
      lastTime = performance.now();
      break;
    case ",":
      /*
       * One frame back. There is no step-in-reverse, so this replays from the start to one step
       * before the current time — exact, and at sixty steps a second fast enough to feel immediate
       * for a few seconds of history. Beyond that it slows down, which is an honest limit rather
       * than a silent failure.
       */
      fastForwardTo(Math.max(0, sessionTime - DT));
      playbackSpeed = 0;
      lastTime = performance.now();
      break;
    case ".":
      stepsQueued++;
      playbackSpeed = 0;
      lastTime = performance.now();
      break;
    case "[":
      // Halve, down to a sixteenth speed.
      playbackSpeed = playbackSpeed <= 1 / 32 ? playbackSpeed : playbackSpeed / 2;
      break;
    case "]":
      // Double, up to sixteen times.
      playbackSpeed = Math.min(16, playbackSpeed === 0 ? 1 : playbackSpeed * 2);
      break;
    default:
      break;
  }
});

/*
 * The wheel zooms. Bound to the canvas rather than the window so the page can still be scrolled
 * when the pointer is over the panels.
 */
canvas.addEventListener(
  "wheel",
  (event: WheelEvent) => {
    event.preventDefault();
    // Exponential, so each notch is the same proportional change however far in or out you are.
    zoomBy(event.deltaY < 0 ? 1.12 : 1 / 1.12);
  },
  { passive: false },
);
window.addEventListener("keyup", (event: KeyboardEvent) => held.delete(event.key.toLowerCase()));
window.addEventListener("blur", () => held.clear());

/**
 * The trained driver, when one has been loaded.
 *
 * A driver is a pure function of its observation, so watching one is exactly the same
 * simulation as training it — the same step, the same car, the same track. Nothing about the
 * viewer changes the physics, which is what makes what you watch worth believing.
 */

/** The circuit key currently selected, for the status poll. */
const currentCircuitKey = (): string =>
  CIRCUITS.find((entry) => entry.name === track.name)?.key ?? DEFAULT_TRACK_KEY;

/**
 * Loads a checkpoint saved by the trainer.
 *
 * The parameter count is checked rather than trusted: a checkpoint from a different build of
 * the network would otherwise load silently and produce a driver whose weights land in the
 * wrong layers, which looks like a driver that simply cannot drive.
 */
const loadDriver = (data: unknown, circuitName: string): string | null => {
  if (typeof data !== "object" || data === null) return "checkpoint is not an object";
  const record = data as {
    genes?: unknown;
    circuit?: unknown;
    fitness?: unknown;
    generation?: unknown;
    seconds?: unknown;
  };
  if (!Array.isArray(record.genes)) return "checkpoint has no genes array";
  if (record.genes.length !== PARAMETER_COUNT) {
    return `checkpoint has ${record.genes.length} parameters, this build needs ${PARAMETER_COUNT}`;
  }
  driver = createDriver(Float64Array.from(record.genes as number[]), () => 0);
  driverInfo = {
    generation: typeof record.generation === "number" ? record.generation : 0,
    fitness: typeof record.fitness === "number" ? record.fitness : 0,
    trainedSeconds: typeof record.seconds === "number" ? record.seconds : 0,
    circuit: typeof record.circuit === "string" ? record.circuit : circuitName,
  };
  return null;
};

/** Fetches the checkpoint for the current circuit, if one has been trained. */
const fetchDriverFor = async (circuitKey: string): Promise<void> => {
  const status = document.getElementById("ai-status");
  try {
    const response = await fetch(`/checkpoints/${circuitKey}.json`);
    if (!response.ok) {
      driver = null;
      if (status) status.textContent = "no checkpoint for this circuit";
      return;
    }
    const error = loadDriver(await response.json(), circuitKey);
    if (status) status.textContent = error ?? "trained driver loaded";
  } catch {
    driver = null;
    driverInfo = null;
    if (status) status.textContent = "checkpoint could not be read";
  }
};

/**
 * A training run's live status, polled from the server.
 *
 * THE POINT IS TO WATCH THE SEARCH, not only its result. A long run once improved for six
 * generations and then achieved nothing for five thousand more, and the only trace was a number in
 * a log file. Showing the curve, the health warning and the current best driver on screen is what
 * turns "left running" into "being watched".
 */
interface TrainingStatus {
  circuit: string;
  generation: number;
  elapsed: number;
  secondsPerGeneration: number;
  bestGeneration: number;
  bestFitness: number;
  currentFitness: number;
  meanDistance: number;
  meanOnTrack: number;
  /** The elite's REAL measured speeds, in metres per second. */
  bestAverageSpeed: number;
  bestTopSpeed: number;
  /** Speed carried through the corner checkpoints, and how many there are. */
  eliteCheckpointCredit?: number;
  eliteCheckpointCount?: number;
  warning: string;
  /** The best parameters ever found. */
  genes: number[];
  /** The search centre: where the population actually is, which is what "is it still trying" means. */
  meanGenes?: number[];
}

let trainingStatus: TrainingStatus | null = null;
/** Recent best-fitness values, for the sparkline. */
const fitnessHistory: number[] = [];

const pollTraining = async (circuitKey: string): Promise<void> => {
  try {
    const response = await fetch(`/checkpoints/${circuitKey}.status.json`, { cache: "no-store" });
    if (!response.ok) {
      trainingStatus = null;
      return;
    }
    const record = (await response.json()) as TrainingStatus;
    trainingStatus = record;
    if (fitnessHistory.length === 0 || record.bestFitness !== fitnessHistory[fitnessHistory.length - 1]) {
      fitnessHistory.push(record.bestFitness);
      if (fitnessHistory.length > 240) fitnessHistory.shift();
    }
    /*
     * Keep the driven driver in step with the search. Only when the elite has actually changed,
     * so a driver mid-corner is not swapped out from under itself.
     */
    if (aiDriving && Array.isArray(record.genes) && record.genes.length === PARAMETER_COUNT) {
      if (!driverInfo || driverInfo.generation !== record.bestGeneration) {
        driver = createDriver(Float64Array.from(record.genes), () => 0);
        driverInfo = {
          generation: record.bestGeneration,
          fitness: record.bestFitness,
          trainedSeconds: record.secondsPerGeneration > 0 ? 0 : 0,
          circuit: record.circuit,
        };
      }
    }
  } catch {
    trainingStatus = null;
  }
};

/** Draws the training curve as a simple sparkline. */
const drawFitnessSpark = (): void => {
  const canvasEl = document.getElementById("fitness-spark") as HTMLCanvasElement | null;
  if (!canvasEl) return;
  const ctx2 = canvasEl.getContext("2d");
  if (!ctx2) return;
  const { width, height } = canvasEl;
  ctx2.clearRect(0, 0, width, height);
  if (fitnessHistory.length < 2) return;

  let lo = Infinity;
  let hi = -Infinity;
  for (const value of fitnessHistory) {
    if (value < lo) lo = value;
    if (value > hi) hi = value;
  }
  const span = hi - lo || 1;
  ctx2.strokeStyle = "#b57bff";
  ctx2.lineWidth = 1.5;
  ctx2.beginPath();
  for (let i = 0; i < fitnessHistory.length; i++) {
    const x = (i / (fitnessHistory.length - 1)) * width;
    const y = height - ((fitnessHistory[i]! - lo) / span) * height;
    if (i === 0) ctx2.moveTo(x, y);
    else ctx2.lineTo(x, y);
  }
  ctx2.stroke();
};

/**
 * Loads the elite from the running trainer and restarts the lap with it.
 *
 * WHY A BUTTON RATHER THAN AUTOMATIC. The panel already swaps the driver when the elite changes,
 * which is right for watching a run progress. But when a new best appears the car is usually
 * mid-corner, so the change takes effect from wherever it happened to be — which makes it
 * impossible to compare one generation's line against another's. This restarts from the same point
 * with the current elite, so two generations can be watched back to back from an identical start.
 *
 * The status file already carries the elite's parameters, so there is nothing to fetch beyond what
 * the panel is already polling.
 */
const replayLatestElite = (): void => {
  const status = trainingStatus;
  const label = document.getElementById("replay-gen");
  if (!status || !Array.isArray(status.genes) || status.genes.length !== PARAMETER_COUNT) {
    if (label) label.textContent = "no run in progress";
    return;
  }

  /*
   * WHICH DRIVER TO WATCH IS THE QUESTION THE REPLAY EXISTS TO ANSWER.
   *
   * The elite is the best ever found; the centre is where the population actually is. While a run is
   * improving they are close. When it stops improving they diverge, and only the centre answers
   * whether the search is still trying — a centre unlike the elite is exploring, and a centre like a
   * worse copy of it is stuck.
   */
  const which = (document.getElementById("replay-which") as HTMLSelectElement | null)?.value ?? "best";
  const genes = which === "mean" ? status.meanGenes : status.genes;
  if (!Array.isArray(genes) || genes.length !== PARAMETER_COUNT) {
    if (label) label.textContent = `no ${which} parameters in the status file`;
    return;
  }
  driver = createDriver(Float64Array.from(genes), () => 0);
  driverInfo = {
    generation: which === "mean" ? status.generation : status.bestGeneration,
    fitness: which === "mean" ? status.currentFitness : status.bestFitness,
    trainedSeconds: 0,
    circuit: status.circuit,
  };
  const toggle = document.getElementById("ai-drive") as HTMLInputElement | null;
  if (toggle) {
    toggle.checked = true;
    aiDriving = true;
  }
  resetToStart();
  updateDriverPanel();
};

/** Writes the training panel. */
const updateTrainingPanel = (): void => {
  const field = (id: string, value: string): void => {
    const node = document.getElementById(id);
    if (node) node.textContent = value;
  };
  if (!trainingStatus) {
    field("train-state", "no run in progress");
    field("train-gen", "--");
    field("train-best", "--");
    field("train-mean", "--");
    field("train-warn", "");
    drawFitnessSpark();
    return;
  }
  const t = trainingStatus;
  field("train-state", "running");
  field("train-gen", `${t.generation}  (best at ${t.bestGeneration})`);
  /*
   * Speed in km/h, from the simulated run. `bestFitness` is a unitless blend of laps, checkpoints,
   * pace and speed — printing it with "km/h" after it read 321 for a driver averaging 108, which is
   * how a fitness number came to look like a speed and be believed.
   */
  const kmh = (value: number): string => `${(value * 3.6).toFixed(0)} km/h`;
  field(
    "train-best",
    t.bestAverageSpeed ? `${kmh(t.bestAverageSpeed)} avg, ${kmh(t.bestTopSpeed)} peak` : "--",
  );
  field("train-mean", `${t.meanDistance.toFixed(0)} m, ${(t.meanOnTrack * 100).toFixed(0)}% on track`);
  /*
   * Corner credit, which is the number the ladder is really optimising: how much of the speed each
   * corner physically allows is actually being carried. Shown next to pace because they answer
   * different questions — pace says how fast the lap is, credit says how much is left in the corners.
   */
  field(
    "train-credit",
    t.eliteCheckpointCredit !== undefined && t.eliteCheckpointCount
      ? `${t.eliteCheckpointCredit.toFixed(0)} / ${t.eliteCheckpointCount}`
      : "--",
  );
  field("train-warn", t.warning ? `WARNING: ${t.warning}` : "");
  const replay = document.getElementById("replay-gen");
  if (replay) {
    replay.textContent =
      `elite gen ${t.bestGeneration} (${t.bestFitness.toFixed(0)})  |  ` +
      `centre gen ${t.generation} (${t.currentFitness.toFixed(0)})`;
  }
  drawFitnessSpark();
};

/** Writes the checkpoint's own metadata into the driver panel. */
const updateDriverPanel = (): void => {
  const setField = (id: string, value: string): void => {
    const node = document.getElementById(id);
    if (node) node.textContent = value;
  };

  /*
   * Playback state, so it is never ambiguous whether the car is standing still because it is paused
   * or because it has stopped. A paused simulation that looks like a broken one is worse than no
   * pause at all.
   */
  setField(
    "playback",
    playbackSpeed === 0 ? "paused" : playbackSpeed === 1 ? "1x" : `${playbackSpeed}x`,
  );
  if (!driverInfo) {
    setField("ai-gen", "--");
    setField("ai-fitness", "--");
    setField("ai-trained", "--");
    return;
  }
  setField("ai-gen", String(driverInfo.generation));
  setField("ai-fitness", driverInfo.fitness.toFixed(0));
  setField(
    "ai-trained",
    driverInfo.trainedSeconds > 0 ? `${driverInfo.trainedSeconds} s runs` : "--",
  );
};

/**
 * Drives the car from the loaded network.
 *
 * The observation is taken from the projection the viewer already maintains, so the AI sees
 * exactly the same track state the lap timing does.
 */
const readAiInputs = (): void => {
  if (!driver) return;
  observe(observation, car, track, lastProjectedS);
  drive(driver, observation, aiControls);
  car.throttle = aiControls.throttle;
  car.brake = aiControls.brake;
  car.steerCommand = aiControls.steer;
};

const readInputs = (): void => {
  if (aiDriving) {
    readAiInputs();
    return;
  }
  const wantsThrottle = held.has("w") || held.has("arrowup");
  const wantsBrake = held.has("s") || held.has("arrowdown") || held.has(" ");
  const wantsLeft = held.has("a") || held.has("arrowleft");
  const wantsRight = held.has("d") || held.has("arrowright");

  // Ramp the pedals and the wheel rather than snapping them, so the driver's
  // inputs are analog in the same way the eventual AI's outputs will be.
  const pedalRate = 4.5 / 60;
  const steerRate = 3.2 / 60;

  car.throttle = clamp01(car.throttle + (wantsThrottle ? pedalRate : -pedalRate * 1.6));
  car.brake = clamp01(car.brake + (wantsBrake ? pedalRate * 1.3 : -pedalRate * 2.0));

  /*
   * `steerCommand = -1` turns the car RIGHT and `+1` turns it LEFT. That is the
   * opposite of what the sign looks like it should mean, and it is worth stating
   * plainly because it was got wrong twice.
   *
   * The engine's convention was verified by driving the page and reading the
   * heading: a negative command produces a NEGATIVE heading change, and a negative
   * canvas rotation is clockwise, which on screen is a right turn. The engine test
   * pins the same mapping from the physics side.
   */
  const targetSteer = wantsLeft ? 1 : wantsRight ? -1 : 0;
  const delta = targetSteer - car.steerCommand;
  car.steerCommand += Math.abs(delta) < steerRate ? delta : Math.sign(delta) * steerRate;

  // Q halves brake pressure: the difference between stamping on the pedal and
  // braking at the limit is the whole point of the tire model, so it needs a key.
  stepContext.brakeScale = held.has("q") ? 0.5 : 1;

  // Number keys pick a circuit, which is quicker than reaching for the dropdown.

};

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * Wires the circuit dropdown and the number keys.
 *
 * Both exist because they are useful in different moments: the dropdown says what
 * is available, the number keys let you flick between layouts without leaving the
 * wheel.
 */
const setupTrackSelector = (): void => {
  const select = document.getElementById("trackSelect") as HTMLSelectElement | null;
  if (!select) return;

  for (const entry of CIRCUITS) {
    const option = document.createElement("option");
    option.value = entry.key;
    option.textContent = entry.name;
    select.appendChild(option);
  }
  select.value = CIRCUITS.find((entry) => entry.name === track.name)?.key ?? DEFAULT_TRACK_KEY;
  select.addEventListener("change", () => selectTrack(select.value));

  window.addEventListener("keydown", (event) => {
    const index = Number(event.key) - 1;
    if (Number.isInteger(index) && index >= 0 && index < CIRCUITS.length) {
      const key = CIRCUITS[index]!.key;
      select.value = key;
      selectTrack(key);
    }
  });
};
const setupDriverToggle = (): void => {
  const toggle = document.getElementById("ai-drive") as HTMLInputElement | null;
  if (!toggle) return;
  toggle.addEventListener("change", () => {
    aiDriving = toggle.checked && driver !== null;
    if (toggle.checked && driver === null) {
      toggle.checked = false;
      const status = document.getElementById("ai-status");
      if (status) status.textContent = "no checkpoint loaded";
    }
    resetToStart();
  });
};

/**
 * The replay button is wired once. The trainer's status is read from the panel's own poll, so the
 * button never fetches anything itself and cannot show a different generation from the one on
 * screen.
 */
const setupReplayButton = (): void => {
  const button = document.getElementById("replay");
  if (!button) return;
  button.addEventListener("click", replayLatestElite);
  const label = document.getElementById("replay-gen");
  if (label) label.textContent = "no run in progress";
};

setupTrackSelector();
setupDriverToggle();
setupReplayButton();
void fetchDriverFor(DEFAULT_TRACK_KEY);

/*
 * Poll the training status twice a second. A run publishes after every generation, so this is
 * comfortably ahead of it, and the request is a small file rather than anything computed.
 */
void pollTraining(DEFAULT_TRACK_KEY);
setInterval(() => { void pollTraining(currentCircuitKey()); }, 500);


// ---------------------------------------------------------------------------
// Tire smoke
// ---------------------------------------------------------------------------
/**
 * Deliberately crude smoke, and deliberately NOT in the engine.
 *
 * Emitted when a tire is sliding — locked or spinning hard — and stored as a flat
 * ring buffer so nothing allocates per frame. It is a visual aid for seeing where
 * the limit is, not a fluid simulation, so it is a handful of fading discs.
 *
 * Keeping it out of `packages/engine` matters: particles are a rendering concern
 * with a random element, and the engine's determinism is what makes replays
 * reproducible from a seed. A cosmetic effect must never be able to break that, so
 * the engine has no idea this exists.
 */
const SMOKE_MAX = 160;
const smoke = {
  x: new Float64Array(SMOKE_MAX),
  y: new Float64Array(SMOKE_MAX),
  age: new Float64Array(SMOKE_MAX),
  life: new Float64Array(SMOKE_MAX),
  size: new Float64Array(SMOKE_MAX),
  count: 0,
  write: 0,
  // Emission is throttled so a long slide does not empty the whole pool at once.
  cooldown: 0,
};

const emitSmoke = (x: number, y: number, intensity: number): void => {
  const index = smoke.write;
  smoke.x[index] = x;
  smoke.y[index] = y;
  smoke.age[index] = 0;
  smoke.life[index] = 0.55 + 0.35 * ((index * 37) % 100) / 100;
  smoke.size[index] = 1.6 + 2.6 * intensity;
  smoke.write = (index + 1) % SMOKE_MAX;
  if (smoke.count < SMOKE_MAX) smoke.count++;
};

const updateSmoke = (dt: number): void => {
  smoke.cooldown -= dt;
  const wantsSmoke = (document.getElementById("smoke") as HTMLInputElement | null)?.checked ?? false;
  if (!wantsSmoke) { smoke.count = 0; return; }

  // Which tires are sliding, and how hard.
  const offsets: Array<[number, number]> = [
    [params.cgToFront, params.trackFront / 2],
    [params.cgToFront, -params.trackFront / 2],
    [-params.cgToRear, params.trackRear / 2],
    [-params.cgToRear, -params.trackRear / 2],
  ];

  const reference = Math.max(Math.abs(car.vx), 2);
  const cos = Math.cos(car.heading);
  const sin = Math.sin(car.heading);

  for (let w = 0; w < 4; w++) {
    const slip = Math.abs((car.omega[w]! * params.wheelRadius - car.vx) / reference);
    // Only well past the grip peak makes smoke, so it reads as a warning rather
    // than as constant haze.
    if (slip < 0.45) continue;
    const intensity = Math.min(1, (slip - 0.45) / 0.9);
    if (smoke.cooldown > 0) continue;
    const [forward, lateral] = offsets[w]!;
    emitSmoke(
      car.x + forward * cos - lateral * sin,
      car.y + forward * sin + lateral * cos,
      intensity,
    );
  }
  if (smoke.cooldown <= 0) smoke.cooldown = 0.012;

  for (let i = 0; i < smoke.count; i++) smoke.age[i]! += dt;
};

const drawSmoke = (): void => {
  const wantsSmoke = (document.getElementById("smoke") as HTMLInputElement | null)?.checked ?? false;
  if (!wantsSmoke) return;

  for (let i = 0; i < smoke.count; i++) {
    const t = smoke.age[i]! / smoke.life[i]!;
    if (t >= 1) continue;
    const radius = smoke.size[i]! * (0.6 + t * 2.4) * camera.scale * 0.5;
    const alpha = (1 - t) * 0.35;
    ctx.beginPath();
    ctx.arc(
      toScreenX(smoke.x[i]!, smoke.y[i]!),
      toScreenY(smoke.x[i]!, smoke.y[i]!),
      Math.max(1, radius),
      0,
      Math.PI * 2,
    );
    ctx.fillStyle = `rgba(214,220,228,${alpha.toFixed(3)})`;
    ctx.fill();
  }
};

// ---------------------------------------------------------------------------
// Camera
// ---------------------------------------------------------------------------
let camera = { x: 0, y: 0, scale: 1 };
const followToggle = document.getElementById("follow") as HTMLInputElement;

/**
 * Whether the chase camera rotates to the car's heading.
 *
 * Two different views share the name "chase": one that tracks the car while staying upright, and
 * one rotated behind it. The first is better for reading the racing line, the second for watching
 * the car rotate and the rear end slide, so both are available and toggled with `R`.
 */
let chaseRotates = false;

/**
 * Zoom multiplier for the chase view, driven by the wheel and the `+`/`-` keys.
 *
 * Clamped to a range that stays useful rather than merely finite: below a third of the default the
 * car is a few pixels across, and above three and a half times the screen is filled with tire.
 */
const CHASE_ZOOM_MIN = 0.35;
const CHASE_ZOOM_MAX = 3.5;
let chaseZoom = 1;

/** Zoom multiplier for the whole-circuit view, so the overview can be framed by hand too. */
const OVERVIEW_ZOOM_MIN = 0.4;
const OVERVIEW_ZOOM_MAX = 4;
let overviewZoom = 1;

const zoomBy = (factor: number): void => {
  if (followToggle.checked) {
    chaseZoom = clampTo(chaseZoom * factor, CHASE_ZOOM_MIN, CHASE_ZOOM_MAX);
  } else {
    overviewZoom = clampTo(overviewZoom * factor, OVERVIEW_ZOOM_MIN, OVERVIEW_ZOOM_MAX);
  }
};

const clampTo = (value: number, low: number, high: number): number =>
  value < low ? low : value > high ? high : value;

/**
 * Camera rotation in radians, applied about the point the camera is centred on.
 *
 * Sign convention matches the simulation: yaw, steering and heading are all positive
 * counter-clockwise, and the screen's y axis points down, so a positive rotation here turns the
 * world clockwise on screen. Deriving it from the car's heading with this sign makes "forward"
 * point up the screen.
 */
let cameraRotation = 0;

/** Sine and cosine of the camera rotation, recomputed whenever the camera moves. */
let camCos = 1;
let camSin = 0;

const updateCamera = (): void => {
  const canvasAspect = canvas.width / canvas.height;
  const margin = 1.25;

  if (followToggle.checked) {
    // Chase camera: locked to the car, zoomed in enough to see the tires work.
    camera.scale = (Math.min(canvas.width, canvas.height) / 90) * chaseZoom;
    camera.x = car.x;
    camera.y = car.y;
    // Only the chase view rotates. A rotated circuit is harder to read than an upright one.
    cameraRotation = chaseRotates ? car.heading : 0;
  } else {
    // Fit the whole circuit.
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < track.xs.length; i++) {
      if (track.xs[i]! < minX) minX = track.xs[i]!;
      if (track.xs[i]! > maxX) maxX = track.xs[i]!;
      if (track.ys[i]! < minY) minY = track.ys[i]!;
      if (track.ys[i]! > maxY) maxY = track.ys[i]!;
    }
    const spanX = (maxX - minX) * margin;
    const spanY = (maxY - minY) * margin;
    camera.scale = Math.min(canvas.width / spanX, canvas.height / spanY) * overviewZoom;
    camera.x = (minX + maxX) / 2;
    camera.y = (minY + maxY) / 2;
    cameraRotation = 0;
    void canvasAspect;
  }

  // Computed once per frame rather than per point: the transforms below run for every track sample
  // and every smoke particle, so a trigonometry call inside them would dominate the frame.
  const rotation = cameraRotation;
  if (rotation === 0) {
    camCos = 1;
    camSin = 0;
  } else {
    camCos = Math.cos(rotation);
    camSin = Math.sin(rotation);
  }
};

/*
 * World to screen, with the camera's rotation applied about its centre.
 *
 * Written as a rotation matrix rather than as an angle so there is no `atan2` and no trigonometry
 * outside `updateCamera`, which keeps this on the right side of the determinism contract that the
 * engine follows — the viewer is not held to it, but a shared convention is worth more than a
 * local exception.
 *
 * The y axis flip is why the cross terms look swapped: world y increases upward and screen y
 * increases downward.
 */
simHandle = {
  car, track, params, stepContext, resetToStart, held, selectTrack,
  /*
   * The camera is on the handle so it can be inspected and driven from outside. Zoom and rotation
   * are things you check by looking at the screen, and "does the wheel change the scale" is not a
   * question a screenshot answers on its own.
   */
  camera,
  setZoom: (factor: number) => zoomBy(factor),
  setChaseRotation: (on: boolean) => { chaseRotates = on; },
  zoomState: () => ({ chaseZoom, overviewZoom, chaseRotates, rotation: cameraRotation }),
  // Transport, so playback can be driven and inspected from outside.
  setPlayback: (speed: number) => { playbackSpeed = speed; },
  playback: () => playbackSpeed,
  sessionSeconds: () => sessionTime,
  seek: (seconds: number) => { fastForwardTo(Math.max(0, seconds)); lastTime = performance.now(); },
  stepFrame: () => { stepsQueued++; playbackSpeed = 0; },
};
(window as unknown as { sim: SimHandle }).sim = simHandle;

const toScreenX = (x: number, y: number): number => {
  const dx = (x - camera.x) * camera.scale;
  const dy = (y - camera.y) * camera.scale;
  return dx * camCos - dy * camSin + canvas.width / 2;
};
const toScreenY = (x: number, y: number): number => {
  const dx = (x - camera.x) * camera.scale;
  const dy = (y - camera.y) * camera.scale;
  return canvas.height / 2 - (dx * camSin + dy * camCos);
};

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
const REDRAW = {
  asphalt: "#2a2f36",
  kerb: "#4a5058",
  line: "#6f7883",
  grass: "#101512",
  sky: "#0b0d10",
};

/**
 * Checkpoint positions for the current circuit, computed once per circuit.
 *
 * These are the places the reward is measured — entry, apex and exit of every corner. Drawing them
 * turns "corner credit 24.9 of 43" from a number into something you can watch the car earn, and makes
 * it obvious at a glance which corners are being taken well and which are being thrown away.
 */
let checkpointDistances: number[] = [];
let checkpointCacheKey = "";

const refreshCheckpoints = (): void => {
  if (checkpointCacheKey === track.key) return;
  checkpointCacheKey = track.key;
  checkpointDistances = cornerCheckpoints(track);
};

/**
 * Draws the checkpoints, and marks the one the car is currently approaching.
 *
 * The next checkpoint is highlighted because that is the one being paid for right now: the reward
 * samples the speed over the approach, so the interesting question at any moment is how fast the car
 * is arriving at the one ahead.
 */
const nextCheckpointFrom = (distance: number): number | null => {
  if (checkpointDistances.length === 0) return null;
  for (const at of checkpointDistances) {
    if (at > distance) return at;
  }
  return checkpointDistances[0] ?? null;
};

const drawCheckpoints = (): void => {
  refreshCheckpoints();
  if (checkpointDistances.length === 0) return;
  const next = nextCheckpointFrom(car.distance);

  for (const at of checkpointDistances) {
    const point = pointAtDistance(track, at);
    const cos = 1;
    const sin = 0;
    void cos;
    void sin;
    // A short bar across the circuit, from one edge to the other.
    const nx = -point.ty;
    const ny = point.tx;
    const inner = track.halfWidth - 0.5;
    const a = toScreenX(point.x - nx * inner, point.y - ny * inner);
    const b = toScreenY(point.x - nx * inner, point.y - ny * inner);
    const c = toScreenX(point.x + nx * inner, point.y + ny * inner);
    const d = toScreenY(point.x + nx * inner, point.y + ny * inner);

    /*
     * Wide enough to see at any zoom. A bar scaled purely by `camera.scale` vanishes in the overview,
     * where the scale is around one pixel per metre — which is how the first version of this shipped
     * invisible, showing a single purple pixel on the whole canvas.
     */
    const isNext = next !== null && Math.abs(at - next) < 1e-9;
    ctx.strokeStyle = isNext ? "#3ddc84" : "rgba(181, 123, 255, 0.85)";
    ctx.lineWidth = isNext ? Math.max(3, 0.5 * camera.scale) : Math.max(2, 0.25 * camera.scale);
    ctx.beginPath();
    ctx.moveTo(a, b);
    ctx.lineTo(c, d);
    ctx.stroke();
  }
};

const drawTrack = (): void => {
  const width = track.halfWidth * camera.scale;

  // Track surface: one stroked path along the centreline. Cheaper and smoother
  // than filling a mesh, and it scales cleanly with the camera.
  ctx.lineJoin = "round";
  ctx.lineCap = "round";

  ctx.strokeStyle = REDRAW.grass;
  ctx.lineWidth = width * 2 + Math.max(6, 4 * camera.scale);
  strokeCentreline();

  ctx.strokeStyle = REDRAW.asphalt;
  ctx.lineWidth = width * 2;
  strokeCentreline();

  // Kerbs: narrow strokes just inside the edge.
  ctx.strokeStyle = REDRAW.kerb;
  ctx.lineWidth = Math.max(1, 1.1 * camera.scale);
  ctx.setLineDash([6, 6]);
  for (const side of [-1, 1]) {
    ctx.beginPath();
    for (let i = 0; i < track.xs.length; i++) {
      const nx = -track.ty[i]! * track.halfWidth * side;
      const ny = track.tx[i]! * track.halfWidth * side;
      const px = track.xs[i]! + nx;
      const py = track.ys[i]! + ny;
      const sx = toScreenX(px, py);
      const sy = toScreenY(px, py);
      if (i === 0) ctx.moveTo(sx, sy);
      else ctx.lineTo(sx, sy);
    }
    ctx.stroke();
  }
  ctx.setLineDash([]);

  // Start / finish.
  const start = pointAtDistance(track, 0);
  const nx = -start.ty * track.halfWidth;
  const ny = start.tx * track.halfWidth;
  ctx.strokeStyle = "#e6edf3";
  ctx.lineWidth = Math.max(2, 0.5 * camera.scale);
  ctx.beginPath();
  ctx.moveTo(toScreenX(start.x + nx, start.y + ny), toScreenY(start.x + nx, start.y + ny));
  ctx.lineTo(toScreenX(start.x - nx, start.y - ny), toScreenY(start.x - nx, start.y - ny));
  ctx.stroke();
};

const strokeCentreline = (): void => {
  ctx.beginPath();
  for (let i = 0; i < track.xs.length; i++) {
    const sx = toScreenX(track.xs[i]!, track.ys[i]!);
    const sy = toScreenY(track.xs[i]!, track.ys[i]!);
    if (i === 0) ctx.moveTo(sx, sy);
    else ctx.lineTo(sx, sy);
  }
  ctx.closePath();
  ctx.stroke();
};

const drawTrail = (): void => {
  if (trail.length < 2) return;
  ctx.lineWidth = Math.max(1, 0.16 * camera.scale);
  for (let i = 1; i < trail.length; i++) {
    const alpha = i / trail.length;
    ctx.strokeStyle = `rgba(91,157,255,${(alpha * 0.5).toFixed(3)})`;
    ctx.beginPath();
    ctx.moveTo(
      toScreenX(trail[i - 1]!.x, trail[i - 1]!.y),
      toScreenY(trail[i - 1]!.x, trail[i - 1]!.y),
    );
    ctx.lineTo(toScreenX(trail[i]!.x, trail[i]!.y), toScreenY(trail[i]!.x, trail[i]!.y));
    ctx.stroke();
  }
};

/**
 * The four wheel contact points, in world coordinates.
 *
 * One place that knows how to map the car's body frame onto the world, so the
 * rings, the vectors and the smoke cannot drift out of agreement with each other.
 */
const wheelContacts = (): Array<[number, number]> => {
  const offsets: Array<[number, number]> = [
    [params.cgToFront, params.trackFront / 2],
    [params.cgToFront, -params.trackFront / 2],
    [-params.cgToRear, params.trackRear / 2],
    [-params.cgToRear, -params.trackRear / 2],
  ];
  const cos = Math.cos(car.heading);
  const sin = Math.sin(car.heading);
  return offsets.map(([forward, lateral]) => [
    car.x + forward * cos - lateral * sin,
    car.y + forward * sin + lateral * cos,
  ]);
};

/**
 * GRIP RINGS: how much of each tire's friction budget is in use, and how hard it
 * is being pressed into the road.
 *
 * Ring SIZE is the normal load, ring COLOUR is utilization. Read together they
 * show load transfer directly: under braking the front rings swell and go red
 * while the rears shrink and cool down. That is the single most useful thing to
 * watch when tuning, and it is a completely different quantity from the force
 * vectors below.
 */
const drawGripRings = (): void => {
  const contacts = wheelContacts();
  for (let w = 0; w < 4; w++) {
    const [wx, wy] = contacts[w]!;
    const load = car.normalLoad[w]!;
    const used = car.utilization[w]!;

    const radius = Math.max(3, Math.sqrt(load) * 0.055 * camera.scale);
    ctx.beginPath();
    ctx.arc(toScreenX(wx, wy), toScreenY(wx, wy), radius, 0, Math.PI * 2);
    ctx.strokeStyle = used > 0.99 ? "#ff3b30" : used > 0.9 ? "#ffb340" : "#3ddc84";
    ctx.lineWidth = Math.max(1.5, 0.3 * camera.scale);
    ctx.stroke();

    if (car.saturated[w] === 1) {
      ctx.fillStyle = "rgba(255,59,48,0.22)";
      ctx.fill();
    }
  }
};

/**
 * FORCE VECTORS: the tire force at each contact patch, drawn as an arrow.
 *
 * Deliberately a different quantity from the grip rings, because an earlier
 * version wired both checkboxes to the same drawing function, which made one of
 * them useless and hid whatever the other would have shown.
 *
 * This is the overlay that explains behaviour rather than just reporting it. A
 * locked front shows a long arrow pointing BACKWARDS along the car's motion and
 * almost nothing sideways, which is the visual proof of why the car will not turn:
 * the tire is still braking hard, it has simply stopped pushing across.
 *
 * Forces are recomputed here from the live car state rather than stored by the
 * engine, so nothing is added to the physics or to the replay format for the sake
 * of a debug drawing.
 */
const drawForceVectors = (): void => {
  const contacts = wheelContacts();
  const cos = Math.cos(car.heading);
  const sin = Math.sin(car.heading);
  // Newtons to pixels: 4000 N should be a clearly visible but not silly arrow.
  const newtonScale = camera.scale * 0.00035;

  for (let w = 0; w < 4; w++) {
    const isFront = w === 0 || w === 1;
    const Fz = Math.max(0, car.normalLoad[w]!);
    if (Fz < 1) continue;

    const cgOffset = isFront ? params.cgToFront : -params.cgToRear;
    const steer = isFront ? car.steerAngle : 0;
    const c = Math.cos(steer);
    const sn = Math.sin(steer);

    const vxW = car.vx * c + (car.vy + car.yawRate * cgOffset) * sn;
    const vyW = -car.vx * sn + (car.vy + car.yawRate * cgOffset) * c;
    const reference = Math.abs(vxW) < 1 ? 1 : Math.abs(vxW);
    const slipRatio = (car.omega[w]! * params.wheelRadius - vxW) / reference;
    const slipAngle = vyW / reference;

    const force = tireForces(Fz, slipRatio, slipAngle, 1, params.tire, car.omega[w]!);

    // Wheel frame back to body frame, then body frame to world.
    const fxBody = force.fx * c - force.fy * sn;
    const fyBody = force.fx * sn + force.fy * c;
    const fxWorld = fxBody * cos - fyBody * sin;
    const fyWorld = fxBody * sin + fyBody * cos;

    const [wx, wy] = contacts[w]!;
    const x0 = toScreenX(wx, wy);
    const y0 = toScreenY(wx, wy);
    const x1 = toScreenX(wx + fxWorld * newtonScale, wy + fyWorld * newtonScale);
    const y1 = toScreenY(wx + fxWorld * newtonScale, wy + fyWorld * newtonScale);

    const length = Math.sqrt((x1 - x0) ** 2 + (y1 - y0) ** 2);
    if (length < 3) continue;

    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.strokeStyle = car.saturated[w] === 1 ? "#ff3b30" : "#5b9dff";
    ctx.lineWidth = Math.max(1.5, 0.35 * camera.scale);
    ctx.stroke();

    // Arrowhead.
    const angle = Math.atan2(y1 - y0, x1 - x0);
    const head = Math.min(7, length * 0.4);
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x1 - head * Math.cos(angle - 0.4), y1 - head * Math.sin(angle - 0.4));
    ctx.lineTo(x1 - head * Math.cos(angle + 0.4), y1 - head * Math.sin(angle + 0.4));
    ctx.closePath();
    ctx.fillStyle = car.saturated[w] === 1 ? "#ff3b30" : "#5b9dff";
    ctx.fill();
  }
};

const drawCar = (): void => {
  const bodyLength = (params.cgToFront + params.cgToRear) * camera.scale;
  const bodyWidth = params.trackFront * camera.scale;

  ctx.save();
  ctx.translate(toScreenX(car.x, car.y), toScreenY(car.x, car.y));
  ctx.rotate(-car.heading);

  // Chassis.
  ctx.fillStyle = "#ff3b30";
  ctx.beginPath();
  ctx.roundRect(-bodyLength * 0.46, -bodyWidth / 2, bodyLength, bodyWidth, Math.max(2, bodyWidth * 0.22));
  ctx.fill();

  // Nose, so orientation is readable at a glance.
  ctx.fillStyle = "#ffd0cd";
  ctx.beginPath();
  ctx.roundRect(bodyLength * 0.18, -bodyWidth * 0.32, bodyLength * 0.28, bodyWidth * 0.64, 2);
  ctx.fill();

  // Wheels, drawn at their actual steering angle.
  ctx.fillStyle = "#0b0d10";
  const wheelLength = 0.62 * bodyWidth;
  const wheelWidth = 0.32 * bodyWidth;
  const corners: Array<[number, number, boolean]> = [
    [params.cgToFront, params.trackFront / 2, true],
    [params.cgToFront, -params.trackFront / 2, true],
    [-params.cgToRear, params.trackRear / 2, false],
    [-params.cgToRear, -params.trackRear / 2, false],
  ];
  for (const [forward, lateral, steers] of corners) {
    ctx.save();
    ctx.translate(forward * camera.scale, -lateral * camera.scale);
    // Screen Y is flipped relative to the world's, so a wheel turned by
    // +steerAngle in the car's frame draws at -steerAngle here.
    if (steers) ctx.rotate(-car.steerAngle);
    ctx.fillRect(-wheelLength / 2, -wheelWidth / 2, wheelLength, wheelWidth);
    ctx.restore();
  }

  ctx.restore();
};

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------
/**
 * DOM field helpers, defined once.
 *
 * `updateTimingPanel` had grown its own private copies of these, which is how two
 * slightly different ways of writing to the same panel appear. Both lookups tolerate a
 * missing element so the panel degrades rather than throwing if the markup changes.
 */
const setText = (id: string, value: string): void => {
  const node = document.getElementById(id);
  if (node) node.textContent = value;
};
const setClass = (id: string, className: string): void => {
  const node = document.getElementById(id);
  if (node) node.className = className;
};
const bar = (id: string, value: number): void => {
  const node = document.getElementById(id) as HTMLElement | null;
  if (node) node.style.width = `${Math.round(clamp01(value) * 100)}%`;
};

const updatePanel = (): void => {
  const speed = Math.sqrt(car.vx * car.vx + car.vy * car.vy) * 3.6;
  setText("speed", speed.toFixed(0));
  setText("gear", String(car.gear + 1));
  setText("rpm", car.rpm.toFixed(0));
  setText("thr-pct", `${Math.round(car.throttle * 100)}%`);
  setText("brk-pct", `${Math.round(car.brake * 100)}%`);
  setText("str-val", car.steerAngle.toFixed(2));
  bar("thr", car.throttle);
  bar("brk", car.brake);
  // The bar fills rightward for a RIGHT turn, and the indicator is inverted
  // because a positive steering angle is a left turn.
  bar("str", (-car.steerAngle / 0.55 + 1) / 2);

  const frontLoad = car.normalLoad[WHEEL_FL]! + car.normalLoad[WHEEL_FR]!;
  const rearLoad = car.normalLoad[WHEEL_RL]! + car.normalLoad[WHEEL_RR]!;
  const total = frontLoad + rearLoad;
  setText("load", `${((frontLoad / total) * 100).toFixed(0)}% / ${((rearLoad / total) * 100).toFixed(0)}%`);

  const frontUse = Math.max(car.utilization[WHEEL_FL]!, car.utilization[WHEEL_FR]!);
  const rearUse = Math.max(car.utilization[WHEEL_RL]!, car.utilization[WHEEL_RR]!);
  setText("grip", `${frontUse.toFixed(2)} / ${rearUse.toFixed(2)}`);

  const lockNode = document.getElementById("lock");
  if (lockNode) {
    lockNode.textContent = `${car.frontLockTime.toFixed(2)} s`;
    lockNode.style.color = car.frontLockTime > 0.4 ? "#ff3b30" : "";
  }
  const spinNode = document.getElementById("spin");
  if (spinNode) {
    spinNode.textContent = `${car.wheelspinTime.toFixed(2)} s`;
    spinNode.style.color = car.wheelspinTime > 0.4 ? "#ffb340" : "";
  }

  const wear = (car.wear[0]! + car.wear[1]! + car.wear[2]! + car.wear[3]!) / 4;
  setText("wear", `${(wear * 100).toFixed(1)}%`);

  // Off-track warning: the car is outside the drivable width, which is what the
  // accent colour drives.
  const projection = projectToTrack(track, car.x, car.y);
  document.body.style.setProperty("--accent", projection.onTrack ? "#ff3b30" : "#ffb340");
};

// ---------------------------------------------------------------------------
// Loop
// ---------------------------------------------------------------------------
const resize = (): void => {
  const rect = canvas.parentElement!.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const width = Math.max(1, Math.round(rect.width * dpr));
  const height = Math.max(1, Math.round(rect.height * dpr));
  if (canvas.width === width && canvas.height === height) return;
  canvas.width = width;
  canvas.height = height;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
};

/*
 * The backing size is checked every frame rather than only on a window resize event.
 *
 * A resize event fires when the WINDOW changes, not when the canvas's own box does, so hiding the
 * panel changed the stage from 980 pixels to 1280 without firing anything — and the canvas stretched
 * a stale buffer, which is exactly "it does not fill the browser" while the element technically did.
 * Asking once per frame is a cheap geometry read that cannot miss a layout change, whatever caused
 * it.
 */
const keepCanvasSized = (): void => resize();
window.addEventListener("resize", resize);
resize();

/**
 * Lets the side panel be resized by dragging, and collapsed by double-clicking the handle.
 *
 * The useful split depends on what you are looking at: watching a racing line wants the whole
 * screen, reading telemetry wants the panel wide. A fixed three-hundred-pixel column cannot serve
 * both, and the canvas is the part worth the space.
 *
 * Panel width is stored so it survives a reload — the choice is about how you work, not about the
 * session.
 */
const setupSplitter = (): void => {
  const splitter = document.getElementById("splitter");
  const aside = document.querySelector("aside");
  if (!splitter || !aside) return;

  const PANEL_MIN = 200;
  const STAGE_MIN = 240;
  /**
   * The panel never takes more than this, whatever it is dragged to.
   *
   * A dragged width is REMEMBERED, which is right for a preference but means a bad value persists
   * across reloads and looks like a broken layout. That happened: a test drag saved 580px into
   * localStorage, so the canvas was squeezed to 695px of a 1280px window on every subsequent load
   * and looked like it did not fill the browser at all.
   */
  const PANEL_MAX = 420;
  const STORAGE_KEY = "panel-width";
  const HIDDEN_KEY = "panel-hidden";

  const apply = (width: number): void => {
    const capped = Math.max(PANEL_MIN, Math.min(width, PANEL_MAX, window.innerWidth - STAGE_MIN));
    /*
     * A custom property, not `grid-template-columns` directly: an inline grid leaves the class-based
     * hidden state unable to override it, which left a dead column beside the canvas.
     */
    document.body.style.setProperty("--panel-width", `${capped}px`);
    setTimeout(resize, 0);
  };

  const stored = Number(localStorage.getItem(STORAGE_KEY));
  if (Number.isFinite(stored) && stored >= PANEL_MIN) {
    // Re-saved under the cap, so an over-wide value from before the cap existed is corrected rather
    // than merely clamped on every load.
    apply(stored);
    localStorage.setItem(STORAGE_KEY, String(Math.min(stored, PANEL_MAX)));
  }

  /*
   * THE CANVAS IS THE POINT, so the panel starts hidden and the whole window is the track. It is one
   * key away when the telemetry is wanted, and which of those you want is a preference worth
   * remembering.
   */
  /*
   * THE CANVAS IS THE DEFAULT. The panel is one key away and its state is remembered, but a fresh
   * browser gets the whole window for the track — the panel is a reference, and the driving is the
   * thing being watched.
   */
  if (localStorage.getItem(HIDDEN_KEY) !== "false") document.body.classList.add("panel-hidden");
  setTimeout(resize, 0);

  let dragging = false;
  splitter.addEventListener("pointerdown", (event) => {
    dragging = true;
    splitter.classList.add("dragging");
    splitter.setPointerCapture((event as PointerEvent).pointerId);
  });
  splitter.addEventListener("pointermove", (event) => {
    if (!dragging) return;
    apply(window.innerWidth - (event as PointerEvent).clientX);
  });
  splitter.addEventListener("pointerup", () => {
    if (!dragging) return;
    dragging = false;
    splitter.classList.remove("dragging");
    const asideWidth = aside.getBoundingClientRect().width;
    if (asideWidth > 0) localStorage.setItem(STORAGE_KEY, String(Math.round(asideWidth)));
  });

  /*
   * Double-clicking the divider hides the panel entirely, giving the whole window to the canvas.
   * The state is a class on the body rather than inline styles so it cannot fight the drag width.
   */
  const togglePanel = (): void => {
    const hidden = document.body.classList.toggle("panel-hidden");
    localStorage.setItem(HIDDEN_KEY, String(hidden));
    /*
     * Re-measured on a TIMER rather than on an animation frame.
     *
     * `requestAnimationFrame` callbacks run BEFORE layout for the frame, so reading the canvas's box
     * there returns the size it had before the class changed — measured, the canvas stayed at 980
     * pixels wide with the panel hidden and the whole window free. A zero-delay timer runs after the
     * browser has laid out, which is the earliest moment the new size exists.
     */
    setTimeout(resize, 0);
  };
  splitter.addEventListener("dblclick", togglePanel);

  // `H` toggles the panel too, for the same reason a video player has one key for fullscreen.
  window.addEventListener("keydown", (event) => {
    if (event.key === "h" || event.key === "H") togglePanel();
  });
  const button = document.getElementById("panel-toggle");
  if (button) button.addEventListener("click", togglePanel);
};

setupSplitter();


/**
 * The live sim state, exposed for measurement.
 *
 * This is not just a convenience: steering direction is the one property that no
 * engine test can check, because every force, moment and load transfer can be
 * self-consistent while the car turns the wrong way. Being able to read the
 * actual heading and position out of a running page is how the convention gets
 * verified end to end.
 */

/*
 * PLAYBACK CONTROL.
 *
 * The simulation is a fixed-step system driven by an accumulator, so running it at other than real
 * time is arithmetic on that accumulator rather than a change to the physics. Nothing about the
 * result changes: two seconds of slow motion and two seconds of normal speed produce the same car
 * state, which is what makes slow motion useful for watching a corner rather than merely a
 * different-looking animation.
 *
 * REWIND IS A DETERMINISTIC RESTART. There is no stored history to rewind through and inventing one
 * would be a second source of truth for the car's state. Instead the car is reset to the start and
 * the run is replayed at high speed up to the target time. The simulation is deterministic, so the
 * state arrived at is exactly the state that was there before — the same property the trainer
 * depends on, used here for playback.
 */
let accumulator = 0;
let lastTime = performance.now();
/** Physics steps requested by hand, consumed one per frame. */
let stepsQueued = 0;

/**
 * A complete copy of the state at the start line.
 *
 * Copied from the live car rather than written out field by field, so a field added to the car later
 * is captured without anyone remembering to add it here. That is the whole point: the previous
 * approach was a hand-written list and it was wrong twice.
 */
interface RewindSnapshot {
  car: Record<string, unknown>;
  applied: { throttle: number; brake: number; steer: number };
  steerRate: number;
  observation: ReturnType<typeof createObservation>;
}
let rewindSnapshot: RewindSnapshot | null = null;

const captureRewindSnapshot = (): void => {
  const copy: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(car)) {
    // Typed arrays are copied, not aliased, or the snapshot would keep changing after it was taken.
    copy[key] = ArrayBuffer.isView(value) ? (value as Float64Array).slice() : value;
  }
  rewindSnapshot = {
    car: copy,
    applied: { ...(driver ? driver.applied : aiControls) },
    steerRate: driver ? driver.steerRate : 0,
    observation: { ...observation },
  };
};

const restoreRewindSnapshot = (): void => {
  const snapshot = rewindSnapshot;
  if (!snapshot) return;
  const target = car as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(snapshot.car)) {
    target[key] = ArrayBuffer.isView(value) ? (value as Float64Array).slice() : value;
  }
  const controls = driver ? driver.applied : aiControls;
  controls.throttle = snapshot.applied.throttle;
  controls.brake = snapshot.applied.brake;
  controls.steer = snapshot.applied.steer;
  if (driver) driver.steerRate = snapshot.steerRate;
  Object.assign(observation, snapshot.observation);

  trail.length = 0;
  sessionTime = 0;
  lastProjectedS = 0;
  timing = createTiming(track.length, SECTOR_COUNT);
};

/** Multiplier on simulated time. Zero means paused. */
let playbackSpeed = 1;
/**
 * How many physics steps to run before drawing a frame.
 *
 * Slow motion needs the opposite of a bigger budget: at a quarter speed some frames contain no step
 * at all, and the car should visibly hold still rather than jitter between positions.
 */
const SLOW_STEPS = 1;
/** Upper bound on steps in one frame, raised so high speeds stay smooth without freezing the page. */
const MAX_STEPS = 64;

/**
 * Performs one fixed physics step.
 *
 * Extracted so that ordinary running, single-stepping and the fast-forward used by rewind all
 * advance the car by exactly the same route. A second copy of this logic would be a second place for
 * the lap distance to be computed wrongly.
 */
const stepOnce = (): void => {
  readInputs();
  stepContext.gripNoise = gripNoiseAt(car.distance, track.length);
  stepCar(car, params, DT, stepContext);

  // Advance the lap distance from the car's actual position, handling the wrap at the
  // start/finish line so the accumulated distance is monotonic.
  const projection = projectToTrackNear(track, car.x, car.y, lastProjectedS, 60);
  const step = projection.s - lastProjectedS;
  if (step < -track.length / 2) car.distance += step + track.length;
  else if (step > track.length / 2) car.distance += step - track.length;
  else car.distance += step;
  lastProjectedS = projection.s;

  sessionTime += DT;
  updateTiming(timing, car.distance, sessionTime);
};

/**
 * Runs the car forward to a target session time as fast as possible, without drawing.
 *
 * Used by rewind. `now` is the wall clock and is not used by the physics, so this is a pure
 * fast-forward of simulated time.
 */
const fastForwardTo = (targetSeconds: number): void => {
  /*
   * REWIND RESTORES A SNAPSHOT RATHER THAN CALLING THE RESET.
   *
   * The reset function is a list of assignments, and a list is only as complete as its author's
   * memory: two pieces of state were missed and each produced a rewind that landed somewhere
   * different every time. Chasing the third the same way would be more of the same.
   *
   * A snapshot cannot be incomplete, because it is taken from the live object rather than written
   * out by hand. Whatever the car and its driver carry, the snapshot has it.
   */
  if (rewindSnapshot) restoreRewindSnapshot();
  else resetToStart();
  const targetSteps = Math.round(targetSeconds / DT);
  /*
   * The trail is recorded during the replay, so it is cleared BEFORE the steps run rather than after
   * — clearing it afterwards would leave a rewound car with no trail at all, which looks like a car
   * that has just appeared rather than one that has been driving.
   */
  trail.length = 0;
  for (let i = 0; i < targetSteps; i++) {
    stepOnce();
    trail.push({ x: car.x, y: car.y });
  }
  if (trail.length > TRAIL_LENGTH) trail.splice(0, trail.length - TRAIL_LENGTH);
};

const frame = (now: number): void => {
  // Fixed-step simulation with an accumulator, so the physics runs at exactly
  // 60 Hz regardless of display refresh rate. A 120 Hz monitor must not change
  // the result, or the trainer and the viewer would disagree.
  const elapsed = Math.min((now - lastTime) / 1000, 0.25);
  lastTime = now;

  if (stepsQueued > 0) {
    // A single step requested by the `>` key while paused.
    while (stepsQueued > 0) {
      stepOnce();
      stepsQueued--;
    }
    accumulator = 0;
  } else if (playbackSpeed <= 0) {
    // Paused, and deliberately not accumulating: unpausing should resume from here rather than
    // catch up on however long the pause lasted.
    accumulator = 0;
  } else {
    accumulator += elapsed * playbackSpeed;

    let steps = 0;
    while (accumulator >= DT && steps < MAX_STEPS) {
      stepOnce();
      accumulator -= DT;
      steps++;
    }
    /*
     * Drop any leftover time when the budget was exhausted. Without this the accumulator grows
     * without bound at high speeds and the page freezes trying to catch up — the simulation would
     * fall further and further behind the clock it is being asked to follow.
     */
    if (steps >= MAX_STEPS) accumulator = 0;
  }
  void SLOW_STEPS;

  // Emission is driven from the current car state once per frame rather than per
  // physics step, so the pool lasts longer and the effect does not depend on how
  // many substeps the loop happened to run.
  updateSmoke(elapsed);

  trail.push({ x: car.x, y: car.y });
  if (trail.length > TRAIL_LENGTH) trail.shift();

  keepCanvasSized();
  updateDriverPanel();
  updateTrainingPanel();
  updateTimingPanel();
  updateCamera();
  ctx.fillStyle = REDRAW.sky;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  drawTrack();
  if ((document.getElementById("checkpoints") as HTMLInputElement | null)?.checked) drawCheckpoints();
  drawTrail();
  drawSmoke();
  if ((document.getElementById("rays") as HTMLInputElement).checked) drawGripRings();
  if ((document.getElementById("ghost") as HTMLInputElement).checked) drawForceVectors();
  drawCar();
  updatePanel();

  requestAnimationFrame(frame);
};

requestAnimationFrame(frame);

/*
 * Captured once, at the end of initialisation, so the snapshot is taken from a fully built car and a
 * loaded driver. Taking it inside `resetToStart` runs during startup, before the driver exists and
 * before several bindings are initialised, which is a temporal dead zone error rather than a
 * subtlety.
 */
captureRewindSnapshot();
