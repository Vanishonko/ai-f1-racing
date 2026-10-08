/**
 * Lap and sector timing.
 *
 * SECTORS ARE MEASURED FROM DISTANCE TRAVELLED, not from position. The car already
 * accumulates arc length along the centreline, and that accumulation is monotonic and
 * already handles the wrap at the start/finish line, so timing needs no geometry of its
 * own and cannot disagree with the track about where the car is.
 *
 * PURPLE AND PERSONAL BESTS. A sector time is compared against the best set so far in
 * that sector: matching it is a personal best, beating it is purple. The table of bests
 * lives in the timing state rather than on a car, so a whole field shares one — which
 * is what makes a purple sector mean something when several cars are on track.
 */

export type SectorGrade = "none" | "personal" | "purple";

export interface LapRecord {
  /** Total lap time [s]. */
  time: number;
  /** Per-sector times, in order. */
  sectors: number[];
}

export interface TimingState {
  /** Distance at which each sector ends, ascending. The last is the lap distance. */
  boundaries: number[];
  /** Lap distance [m]. */
  lapLength: number;
  /** Total distance travelled at the previous update [m]. */
  previousDistance: number;
  /** Session time at the previous update [s]. */
  previousElapsed: number;
  /** Duration of the step just taken [s]. */
  lastStep: number;
  /** Session time at which the current sector began [s]. */
  sectorStart: number;
  /** Sector boundaries passed on the current lap. */
  sectorsDone: number;

  /** Laps completed in full. */
  laps: number;
  /** Completed sector times on the current lap, in order. */
  currentSectors: number[];
  /** The last completed lap, if any. */
  lastLap: LapRecord | null;
  /** Fastest completed lap, if any [s]. */
  bestLap: number | null;
  /** Best time per sector across the session. */
  sectorBests: Array<number | null>;
  /** How the most recently completed sector compared with the session's bests. */
  lastGrade: SectorGrade;
  /** The most recently completed sector's time [s], or null. */
  lastSectorTime: number | null;
}

/**
 * Creates timing state for a lap of `lapLength` metres split into equal sectors.
 *
 * Equal thirds is a simplification; real sectors are placed so each holds a
 * representative mix of corners. It is a parameter so a circuit can supply its own
 * boundaries later without any change here.
 */
export const createTiming = (lapLength: number, sectorCount = 3): TimingState => {
  const boundaries: number[] = [];
  for (let i = 1; i <= sectorCount; i++) boundaries.push((lapLength * i) / sectorCount);
  return {
    boundaries,
    lapLength,
    previousDistance: 0,
    previousElapsed: 0,
    lastStep: 0,
    sectorStart: 0,
    sectorsDone: 0,
    laps: 0,
    currentSectors: [],
    lastLap: null,
    bestLap: null,
    sectorBests: boundaries.map(() => null),
    lastGrade: "none",
    lastSectorTime: null,
  };
};

/**
 * Advances timing by one step.
 *
 * @param distance total distance travelled since the session began [m]
 * @param elapsed total session time [s]
 */
export const updateTiming = (state: TimingState, distance: number, elapsed: number): void => {
  const lapLength = state.lapLength;
  if (lapLength <= 0) return;

  state.lastStep = elapsed - state.previousElapsed;
  state.previousElapsed = elapsed;

  const before = state.previousDistance % lapLength;
  const after = distance % lapLength;
  const advanced = distance - state.previousDistance;
  state.previousDistance = distance;
  if (advanced <= 0 || state.lastStep <= 0) return;

  /*
   * Walk every boundary crossed during this step rather than testing only where the car
   * ended up.
   *
   * A step can cross more than one boundary when the car is quick and the tick is long,
   * and a boundary stepped clean over is a sector silently dropped — which shows up as a
   * lap with two sectors in it. At 300 km/h one tick covers 1.4 m, so the window is
   * narrow but it exists.
   */
  for (let i = 0; i < state.boundaries.length; i++) {
    const boundary = state.boundaries[i]!;
    const crossed =
      (before < boundary && after >= boundary) ||
      (after < before && (boundary > before || boundary <= after));
    if (!crossed) continue;

    /*
     * Where within the step the boundary was reached, interpolated rather than snapped
     * to the tick. Snapping would quantise every sector time to the timestep and sectors
     * would be decided by tick alignment rather than by driving.
     */
    const distanceIntoStep = (boundary - before + lapLength) % lapLength;
    const fraction = advanced > 1e-9 ? distanceIntoStep / advanced : 0;
    completeSector(state, i, elapsed - (1 - fraction) * state.lastStep);
  }
};

/** Records a sector completed at `boundaryElapsed` seconds into the session. */
const completeSector = (state: TimingState, sector: number, boundaryElapsed: number): void => {
  const sectorTime = boundaryElapsed - state.sectorStart;
  if (sectorTime <= 0) return;

  state.currentSectors.push(sectorTime);
  state.sectorStart = boundaryElapsed;
  state.sectorsDone++;
  state.lastSectorTime = sectorTime;

  const best = state.sectorBests[sector] ?? null;
  if (best === null || sectorTime < best - 1e-9) {
    state.sectorBests[sector] = sectorTime;
    state.lastGrade = "purple";
  } else if (sectorTime <= best + 1e-9) {
    state.lastGrade = "personal";
  } else {
    state.lastGrade = "none";
  }

  // A full set of sectors is a completed lap.
  if (state.sectorsDone >= state.boundaries.length) {
    const lapTime = state.currentSectors.reduce((a, b) => a + b, 0);
    state.lastLap = { time: lapTime, sectors: state.currentSectors.slice() };
    if (state.bestLap === null || lapTime < state.bestLap) state.bestLap = lapTime;
    state.laps++;
    state.currentSectors = [];
    state.sectorsDone = 0;
    state.sectorStart = boundaryElapsed;
  }
};

/** Formats a time as m:ss.mmm, or a dash when there is no time yet. */
export const formatTime = (seconds: number | null): string => {
  if (seconds === null || !Number.isFinite(seconds)) return "--:--.---";
  const minutes = Math.floor(seconds / 60);
  const rest = seconds - minutes * 60;
  const whole = Math.floor(rest);
  const millis = Math.round((rest - whole) * 1000);
  return `${minutes}:${String(whole).padStart(2, "0")}.${String(millis).padStart(3, "0")}`;
};
