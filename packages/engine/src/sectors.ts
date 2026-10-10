/**
 * Sector tracking: which checkpoint comes next, and what passing it was worth.
 *
 * This exists as its own module because it is the one part of the reward that is a STATEFUL LAP
 * MACHINE rather than a formula, and getting it wrong is invisible — it fails by paying a plausible
 * number for something other than driving. It did exactly that: a two-lap run reported five thousand
 * checkpoints passed and earned nothing, and a driver was scored on where it failed to finish a lap
 * rather than on how it drove the one it did.
 *
 * TWO THINGS HAVE TO BE TRUE FOR THE MEASUREMENT TO MEAN ANYTHING, and they are separate faults:
 *
 *  1. THE CHECKPOINT TARGET MUST CARRY ITS LAP. `car.distance` is the car's odometer and increases
 *     across laps rather than resetting at the line, so a target has to increase with it: the
 *     checkpoint at 26 m of lap two is at 3,547 m of odometer, not 26 m. Compare against the bare
 *     position and every checkpoint from the second lap on is "already passed" — the test holds on
 *     EVERY tick, the counter runs away, and every sample it takes is of the same few metres of road.
 *     Measured on the broken code: 5,443 checkpoints passed over two laps of a circuit that has
 *     forty-two of them, and zero credit earned, because a whole lap's measurement had collapsed into
 *     one point just past the start line.
 *
 *     Writing the last checkpoint's lap offset by hand does not fix it either, and that mistake is
 *     recorded here because it was made: the offset has to be recomputed for the checkpoint being
 *     aimed at, not for the counter, or the target jumps a whole lap the moment the counter wraps.
 *
 *  2. CREDIT MUST BE EARNED PER LAP, NOT ONCE EVER. A high-water mark taken across the whole run
 *     saturates: the first lap that gets a corner right sets the record, nothing later can beat it,
 *     and the term stops distinguishing a corner driven well from one driven badly. Measured, the
 *     project's leading driver had already banked 41 of 42 checkpoints at 108 per cent of their
 *     grip limit — the reward had nothing left to say about corners, and had gone quiet on the
 *     straight after the first lap.
 *
 * So each lap is scored on its own and banked when it completes, which keeps the term paying for the
 * whole run instead of only the first lap.
 */

import { cornerCheckpoints, sampleIndexAt, type Track } from "./track.ts";

/**
 * A representative cornering limit, in metres per second squared.
 *
 * Used only to express a sector reward as a FRACTION of what the car could have carried there, so
 * that a hairpin and a fast sweeper are worth the same for the same quality of driving. It is a
 * normalising constant rather than a physical model: the physics has the real one.
 */
const DEFAULT_GRIP_LIMIT = 14;

/** A straight has no cornering limit, so this stands in for the car's own terminal speed. */
const TERMINAL_SPEED = 85;

/** Grip-limited speed for a curvature, capped so a straight does not produce an infinite limit. */
const gripLimitedSpeed = (curvature: number, gripLimit: number): number => {
  const k = Math.abs(curvature);
  if (k < 1e-6) return TERMINAL_SPEED;
  return Math.min(TERMINAL_SPEED, Math.sqrt(gripLimit / k));
};

/** Evenly spaced checkpoints, for comparing against the corner-placed ones. */
const evenlySpaced = (length: number, count: number): number[] => {
  const positions: number[] = [];
  for (let i = 0; i < count; i++) positions.push((length * i) / count);
  return positions;
};

export interface SectorOptions {
  /** Place checkpoints at corner entry, apex and exit instead of evenly. */
  cornerCheckpoints?: boolean | undefined;
  /** How many checkpoints the circuit is divided into. Zero disables them. */
  checkpointCount?: number | undefined;
  /** Cornering limit used to normalise rewards. See `DEFAULT_GRIP_LIMIT`. */
  gripLimit?: number | undefined;
}

export class SectorTracker {
  /** Distance along the centreline at which each checkpoint sits, ascending. */
  readonly positions: ReadonlyArray<number>;
  /** Centreline length of the circuit, added once per lap when a target is formed. */
  private readonly trackLength: number;

  /** Speed carried through each checkpoint THIS lap [m/s]. Cleared when a lap completes. */
  private readonly bestSpeed: Float64Array;
  /** Set when the car was off the circuit at the moment it passed; that sector is forfeit. */
  private readonly cut: Uint8Array;
  /** Grip-limited speed at each checkpoint [m/s], the denominator of the credit. */
  private readonly limits: Float64Array;

  /** Checkpoint being aimed at, in [0, count). The only index that wraps. */
  private next = 0;
  /**
   * Which lap's worth of checkpoints `next` is currently addressing.
   *
   * This is the number that must be folded into the target. Kept SEPARATE from the index rather than
   * replacing it with one cumulative counter, because the two are needed in different places: the
   * target needs the lap, and every per-checkpoint array needs the index.
   */
  private lap = 0;
  /** Index of the first checkpoint of the current lap, so a lap's span can be measured. */
  private lapStart = 0;
  private passed = 0;
  /** Credit banked from completed laps, as a sum of per-checkpoint fractions. */
  private banked = 0;
  /** Checkpoints counted into `banked`, i.e. those belonging to completed laps. */
  private bankedSectors = 0;
  /** Mean sector credit of each completed lap, so lap-to-lap spread can be reported. */
  private readonly lapCredits: number[] = [];
  /** Best fraction of a grip limit ever reached on any checkpoint, for reporting. */
  private best = 0;

  constructor(track: Track, options: SectorOptions = {}) {
    const gripLimit = options.gripLimit ?? DEFAULT_GRIP_LIMIT;
    this.trackLength = track.length;
    this.positions = options.cornerCheckpoints
      ? cornerCheckpoints(track)
      : options.checkpointCount
        ? evenlySpaced(track.length, options.checkpointCount)
        : [];

    const count = this.positions.length;
    this.bestSpeed = new Float64Array(count);
    this.cut = new Uint8Array(count);
    this.limits = new Float64Array(count);
    /*
     * The grip limit is resolved ONCE, at construction, from the curvature at each checkpoint.
     * Sampling the track per checkpoint per tick would put a track lookup on the hot path for a
     * number that cannot change.
     */
    for (let i = 0; i < count; i++) {
      const curvature = Math.abs(track.curvature[sampleIndexAt(track, this.positions[i]!)] ?? 0);
      this.limits[i] = gripLimitedSpeed(curvature, gripLimit);
    }
  }

  get count(): number {
    return this.positions.length;
  }

  /** Checkpoints passed in the correct order, across every lap of the run. */
  get checkpointsPassed(): number {
    return this.passed;
  }

  /**
   * How many checkpoints the current lap has attempted.
   *
   * The lap spans the checkpoint window that has wrapped `lap` times, so the count is the offset in
   * that window plus a full set for every wrap. Adding the wrap is what keeps the denominator growing
   * with the run; without it a multi-lap run would be divided by a single lap's worth of checkpoints.
   */
  private get attempted(): number {
    return this.next + this.lap * this.count - this.lapStart;
  }

  /** Credit for one checkpoint in the lap in progress: speed as a fraction of its grip limit. */
  private creditAt(index: number): number {
    if (this.cut[index] === 1) return 0;
    const limit = this.limits[index]!;
    if (limit <= 0) return 0;
    const achieved = (this.bestSpeed[index] ?? 0) / limit;
    return achieved > 1 ? 1 : achieved;
  }

  /**
   * Credit earned by the lap in progress, over its wrapped checkpoint window.
   *
   * The window has to be walked modulo the checkpoint count, because a lap does not begin at index
   * zero — it begins wherever the previous one ended, and the final checkpoint of a lap always sits
   * before the first one of the next.
   */
  private lapCredit(): number {
    let sum = 0;
    let index = this.lapStart;
    for (let seen = this.attempted; seen > 0; seen--) {
      sum += this.creditAt(index % this.count);
      index++;
    }
    return sum;
  }

  /**
   * Mean sector credit over the whole run, in [0, 1].
   *
   * The denominator is the SECTORS ATTEMPTED, not the checkpoint count. Dividing by the count would
   * score a long run below a short one for identical driving, because a run cut off mid-lap has not
   * attempted every checkpoint yet would still be divided by all of them. Attempted sectors is the
   * honest denominator: the fraction of the corners met that were met well.
   */
  get credit(): number {
    const sectors = this.bankedSectors + this.attempted;
    if (sectors === 0) return 0;
    return (this.banked + this.lapCredit()) / sectors;
  }

  /**
   * Fastest speed carried through any checkpoint on the lap in progress, as a fraction of its limit.
   *
   * Scoped to the current lap rather than the whole run, because an all-time high-water mark is the
   * thing this module exists to avoid: it is reported as a per-lap number in the status file, and a
   * per-lap number that only ever goes up is not a per-lap number.
   */
  get bestFraction(): number {
    let best = 0;
    let index = this.lapStart;
    for (let seen = this.attempted; seen > 0; seen--) {
      const at = index % this.count;
      const limit = this.limits[at]!;
      if (limit > 0) {
        const achieved = (this.bestSpeed[at] ?? 0) / limit;
        if (achieved > best) best = achieved;
      }
      index++;
    }
    return best;
  }

  /** Best fraction of a grip limit reached at any point in the run, for reporting. */
  get peakFraction(): number {
    return this.best;
  }

  /** Mean sector credit over completed laps only, so a partial final lap does not dilute it. */
  get meanLapCredit(): number {
    if (this.lapCredits.length === 0) return 0;
    let sum = 0;
    for (const value of this.lapCredits) sum += value;
    return sum / this.lapCredits.length;
  }

  /**
   * Records the approach to the next checkpoint, and advances it if it has now been reached.
   *
   * Speed is recorded on the APPROACH rather than only at the crossing, because a single sample taken
   * on the line is a lottery and the search would be optimising noise. Only on-circuit samples count,
   * so the speed kept is one the car genuinely carried on the road.
   *
   * Returns the index of the checkpoint just passed, or -1 if none was.
   */
  update(distance: number, speed: number, onTrack: boolean): number {
    if (this.count === 0) return -1;

    const index = this.next;
    if (onTrack && speed > (this.bestSpeed[index] ?? 0)) this.bestSpeed[index] = speed;

    /*
     * THE TARGET CARRIES ITS LAP, and this line is the whole of fault 1 in the module note.
     *
     * `distance` is the car's odometer, which does not reset at the line, so lap two's checkpoint at
     * 26 m sits at 3,547 m of odometer. `this.next` is a per-lap index while `this.lap` is the lap,
     * and the target is the two combined. Using the bare position here made the test true on every
     * tick from the second lap on: measured, 5,443 passes over two laps of a forty-two-checkpoint
     * circuit, and no credit, because the entire lap's measurement was taken at one point.
     */
    const target = this.positions[index]! + this.lap * this.trackLength;
    if (distance < target) return -1;

    this.passed++;
    /*
     * ON-CIRCUIT IS JUDGED AT THE CROSSING, not throughout the approach.
     *
     * An earlier version forfeited every checkpoint still to come once the car had been off the
     * circuit anywhere before reaching one, so a single early excursion scored nothing for the rest of
     * the lap. What this reward means to express is whether THIS corner was driven or cut, and that is
     * a property of this crossing.
     */
    if (!onTrack) this.cut[index] = 1;
    const fraction = this.creditAt(index);
    if (fraction > this.best) this.best = fraction;

    /*
     * Wrap the INDEX and advance the LAP together. Advancing only one of the two is fault 1 again,
     * and advancing the lap at the line instead of the index here would leave the last checkpoint of
     * one lap and the first of the next sharing a target a whole lap out.
     */
    this.next++;
    if (this.next >= this.count) {
      this.next = 0;
      this.lap++;
    }
    return index;
  }

  /**
   * Banks the lap that has just completed and starts a fresh one.
   *
   * Called when the car crosses the start line. Clearing `bestSpeed` is what keeps the term alive:
   * without it the record set on an early lap is unbeatable and every later lap scores the same
   * however it was driven.
   *
   * `lapStart` is not reset to zero with the index, because a lap ends at the last checkpoint of the
   * circuit and the next begins just after it — the sequence stays continuous while the index wraps.
   */
  completeLap(): void {
    if (this.count === 0) return;

    const attempted = this.attempted;
    if (attempted > 0) {
      const credit = this.lapCredit();
      this.banked += credit;
      this.bankedSectors += attempted;
      this.lapCredits.push(credit / attempted);
    }

    this.bestSpeed.fill(0);
    this.cut.fill(0);
    this.lapStart = this.lap * this.count + this.next;
  }
}

export { DEFAULT_GRIP_LIMIT };
