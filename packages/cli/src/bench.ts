/**
 * Measures a trained driver and says whether it is actually any good.
 *
 *   node packages/cli/src/bench.ts [--circuit club] [--checkpoint path] [--seconds 90]
 *
 * THE POINT IS THE BASELINE. "It drives" is not a standard. A trained driver is scored against a
 * hand-written policy that steers to the line and lifts for the corners it cannot take flat — a few
 * dozen lines, no learning, no tuning. If a thirteen-hour evolutionary run cannot beat that, the
 * search is what needs attention. Without a comparison there is no way to know which of those two
 * things is true, and a training curve going up does not answer it.
 *
 * It also reports the behaviours that are easy to lose while chasing distance:
 *
 *   - SMOOTHNESS, as steering travel per hundred metres. A high number means the driver is fighting
 *     the car, which scrubs speed, upsets the platform and makes it impossible to race alongside.
 *   - BRAKE USE, as the fraction of the run spent braking. A driver that never brakes has learned
 *     to avoid the corner rather than to take it.
 *   - CONSISTENCY across two run lengths, because a driver tuned on short runs can fall apart past
 *     the window it was selected in. That happened: a driver scoring 856 m over 45 s managed only
 *     1522 m over 120 s.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildCircuitByKey, CIRCUITS } from "../../engine/src/trackLibrary.ts";
import { runDriver, runPolicy } from "../../engine/src/environment.ts";
import { createDriver, PARAMETER_COUNT, type Driver } from "../../engine/src/driver.ts";
import type { Observation } from "../../engine/src/sense.ts";
import type { Controls } from "../../engine/src/driver.ts";
import { sampleIndexAt, type Track } from "../../engine/src/track.ts";

interface Options {
  circuit: string;
  checkpoint: string;
  seconds: number;
}

const parse = (argv: string[]): Options => {
  const options: Options = { circuit: "club", checkpoint: "", seconds: 90 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const next = (): string => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      return value;
    };
    if (arg === "--circuit") options.circuit = next();
    else if (arg === "--checkpoint") options.checkpoint = next();
    else if (arg === "--seconds") options.seconds = Number(next());
    else if (arg === "--list") {
      for (const circuit of CIRCUITS) console.log(`${circuit.key.padEnd(10)} ${circuit.name}`);
      process.exit(0);
    } else throw new Error(`unknown option ${arg}`);
  }
  if (!options.checkpoint) options.checkpoint = `checkpoints/${options.circuit}.json`;
  return options;
};

/**
 * A hand-written reference driver: hold the line, and slow for corners that need it.
 *
 * `commitment` is a crude grip budget in metres per second squared. It is swept rather than tuned,
 * because the point is a fair floor rather than the best possible script.
 */
const referencePolicy =
  (commitment: number) =>
  (observation: Observation, controls: Controls): void => {
    /*
     * Steering: correct the heading error, then ease back towards the centreline. Both terms are
     * deliberately gentle — this is a reference for a smooth driver, not a controller tuned to win.
     */
    const headingTerm = -observation.headingErrorSin * 1.6;
    const lineTerm = -observation.lateral * 0.03;
    controls.steer = Math.max(-1, Math.min(1, headingTerm + lineTerm));

    // Corner speed from the curvature a little way ahead, so it lifts before the corner rather than
    // after it. The lead grows with speed because a faster car needs more warning.
    const vx = observation.values[REFERENCE_VX]! * 80;
    const lookahead = observation.distance + 25 + vx * 0.8;
    const index = sampleIndexAt(trackRef, lookahead);
    const curvature = Math.abs(trackRef.curvature[index] ?? 0);
    const limit = Math.sqrt(commitment / Math.max(curvature, 1e-6));

    if (vx < limit) {
      controls.throttle = 1;
      controls.brake = 0;
    } else if (vx > limit * 1.15) {
      controls.throttle = 0;
      controls.brake = 0.5;
    } else {
      controls.throttle = 0.2;
      controls.brake = 0;
    }
  };

/**
 * Index of forward speed in the observation.
 *
 * Eleven rays of two values each, then vx. Read as a name rather than a magic number so a change to
 * the ray count cannot silently make this read the wrong slot.
 */
const RAY_COUNT_FOR_INDEX = 11;
const REFERENCE_VX = RAY_COUNT_FOR_INDEX * 2;

/** Set before the reference policy is used, so the policy needs no closure over the track. */
let trackRef: Track;

const describe = (label: string, result: ReturnType<typeof runDriver>): void => {
  console.log(
    `  ${label.padEnd(22)} ${result.distance.toFixed(0).padStart(5)} m  ` +
      `${String(result.laps).padStart(2)} laps  ` +
      `${(result.averageSpeed * 3.6).toFixed(0).padStart(3)} km/h  ` +
      `track ${(result.onTrackFraction * 100).toFixed(0).padStart(3)}%  ` +
      `steer ${result.steeringWork.toFixed(2).padStart(5)}  ` +
      `locked ${(result.lockedFraction * 100).toFixed(0).padStart(2)}%  ` +
      `spin ${(result.wheelspinFraction * 100).toFixed(0).padStart(2)}%`,
  );
};

const main = (): void => {
  const options = parse(process.argv.slice(2));
  const track = buildCircuitByKey(options.circuit);
  if (!track) {
    console.error(`no such circuit: ${options.circuit}`);
    process.exitCode = 1;
    return;
  }
  trackRef = track;

  const path = resolve(options.checkpoint);
  let driver: Driver | null = null;
  try {
    const record = JSON.parse(readFileSync(path, "utf8")) as {
      genes?: number[];
      generation?: number;
      fitness?: number;
      circuit?: string;
      seconds?: number;
    };
    if (!Array.isArray(record.genes) || record.genes.length !== PARAMETER_COUNT) {
      throw new Error(`expected ${PARAMETER_COUNT} parameters`);
    }
    driver = createDriver(Float64Array.from(record.genes), () => 0);
    console.log(
      `${path}\n  trained to generation ${record.generation ?? "?"} on ${record.circuit ?? "?"} ` +
        `with ${record.seconds ?? "?"} s evaluations, recorded fitness ${(record.fitness ?? 0).toFixed(1)}\n`,
    );
  } catch (error) {
    console.log(`${path}: ${(error as Error).message} — benchmarking the reference driver only\n`);
  }

  console.log(`${track.name}, ${track.length.toFixed(0)} m, ${options.seconds} s runs\n`);
  console.log("  driver                    dist  laps   speed   on trk  steer  lock  spin");

  if (driver) describe("evolved", runDriver(driver, track, { seconds: options.seconds }));

  /*
   * The reference is swept across commitments and the best result shown, so the comparison is
   * against the best a simple script can do rather than against an arbitrary setting.
   */
  let best: ReturnType<typeof runDriver> | null = null;
  let bestCommitment = 0;
  for (const commitment of [4, 6, 8, 10, 12, 14, 16]) {
    const result = runPolicy(referencePolicy(commitment) as never, track, { seconds: options.seconds });
    if (!best || result.distance > best.distance) {
      best = result;
      bestCommitment = commitment;
    }
  }
  if (best) describe(`reference (grip ${bestCommitment})`, best);

  /*
   * Consistency across run lengths. A driver selected on short runs can fall apart past the window
   * it was optimised in, and that is invisible unless it is measured.
   */
  if (driver) {
    console.log("\n  consistency across run lengths:");
    for (const seconds of [options.seconds, options.seconds * 2, options.seconds * 4]) {
      const result = runDriver(driver, track, { seconds });
      const perSecond = result.distance / seconds;
      console.log(
        `    ${String(seconds).padStart(4)} s: ${result.distance.toFixed(0).padStart(5)} m  ` +
          `${(perSecond * 3.6).toFixed(0).padStart(3)} km/h sustained  ` +
          `${(result.averageSpeed * 3.6 / (perSecond * 3.6) * 100).toFixed(0)}% of its own pace`,
      );
    }
  }
};

main();
