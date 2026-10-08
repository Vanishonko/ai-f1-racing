/**
 * A worker thread that scores one parameter vector.
 *
 * The whole of the trainer's cost is here: a driver's fitness is a simulated run, and runs are
 * independent, so they move to workers wholesale. Each worker holds the circuit it was given and
 * builds nothing else, so a request is one driver's parameters in and one score out.
 *
 * Kept deliberately thin. Anything clever in here would be logic that cannot be debugged from the
 * main thread and cannot be reached by a test.
 */

import { parentPort } from "node:worker_threads";
import { buildCircuitByKey } from "../../engine/src/trackLibrary.ts";
import { runDriver, type Objective } from "../../engine/src/environment.ts";
import { createDriver, PARAMETER_COUNT } from "../../engine/src/driver.ts";

interface Request {
  genes: number[];
  circuit: string;
  seconds: number;
  objective: Objective;
  checkpointCount: number;
  lapReward: number;
  checkpointReward: number;
  topSpeedWeight: number;
}

if (!parentPort) throw new Error("the evaluation worker must be started as a worker thread");
const port = parentPort;

/*
 * Circuits are built once and kept. A request names its circuit, and building one is more expensive
 * than the evaluation itself, so rebuilding per request would dominate the cost of a small one.
 */
import type { Track } from "../../engine/src/track.ts";

const circuits = new Map<string, Track>();

port.on("message", (request: Request) => {
  try {
    if (!Array.isArray(request.genes) || request.genes.length !== PARAMETER_COUNT) {
      throw new Error(
        `expected ${PARAMETER_COUNT} parameters, received ${request.genes?.length ?? 0}`,
      );
    }
    let track = circuits.get(request.circuit);
    if (track === undefined) {
      const built = buildCircuitByKey(request.circuit);
      if (built === null) throw new Error(`no such circuit: ${request.circuit}`);
      circuits.set(request.circuit, built);
      track = built;
    }

    const driver = createDriver(Float64Array.from(request.genes), () => 0);
    const result = runDriver(driver, track, {
      seconds: request.seconds,
      objective: request.objective,
      checkpointCount: request.checkpointCount,
      lapReward: request.lapReward,
      checkpointReward: request.checkpointReward,
      topSpeedWeight: request.topSpeedWeight,
    });

    port.postMessage({
      fitness: result.fitness,
      distance: result.distance,
      averageSpeed: result.averageSpeed,
      topSpeed: result.topSpeed,
      onTrackFraction: result.onTrackFraction,
      laps: result.laps,
      checkpointsPassed: result.checkpointsPassed,
    });
  } catch (error) {
    // Rethrowing inside a worker kills it silently, which would hang a run with no explanation.
    // The message is sent back deliberately so the main thread can report what went wrong.
    throw new Error(`evaluation failed: ${(error as Error).message}`);
  }
});
