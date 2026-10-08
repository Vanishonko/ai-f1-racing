/**
 * Scores parameter vectors in worker threads.
 *
 * WHY THIS EXISTS. Three things were true at once and nobody put them together: an evaluation is
 * completely independent of every other evaluation, the machine has eight cores, and the trainer
 * was using one of them. Measured on this hardware a ninety-second evaluation costs 183 ms of wall
 * time, and a generation is forty-nine of them, so a generation costs nine seconds and a night's
 * training costs a night. Spreading the same work across the cores is the single largest speedup
 * available and it changes nothing about the result.
 *
 * DETERMINISM IS PRESERVED because every evaluation is a pure function of its parameters, the
 * circuit and the run length — no shared state, no ordering effects. Results are collected by index
 * rather than by completion order, so a generation produces byte-identical scores regardless of how
 * the work happened to be scheduled.
 *
 * WORKERS ARE POOLED rather than spawned per generation. Starting a thread costs tens of
 * milliseconds, which against a 183 ms evaluation would be a real tax at this granularity.
 */

import { Worker } from "node:worker_threads";
import { availableParallelism } from "node:os";
import { fileURLToPath } from "node:url";

/** One unit of work: score these parameters. */
export interface EvaluationRequest {
  genes: Float64Array;
  circuit: string;
  seconds: number;
  objective: "speed" | "distance";
  /** Every value that affects the score must reach the worker; see `evolve.ts`. */
  checkpointCount: number;
  lapReward: number;
  checkpointReward: number;
  topSpeedWeight: number;
}

/** What came back. */
export interface EvaluationResult {
  fitness: number;
  distance: number;
  averageSpeed: number;
  topSpeed: number;
  onTrackFraction: number;
  laps: number;
  checkpointsPassed: number;
}

interface Pending {
  resolve: (result: EvaluationResult) => void;
  reject: (error: Error) => void;
}

export interface EvaluationPool {
  /** Scores every request, in parallel, and returns the results in the SAME ORDER. */
  run(requests: EvaluationRequest[]): Promise<EvaluationResult[]>;
  /** Number of workers actually started. */
  size: number;
  /** Stops every worker. */
  close(): Promise<void>;
}

const WORKER_PATH = fileURLToPath(new URL("./evaluationWorker.ts", import.meta.url));

/**
 * Starts an evaluation pool.
 *
 * @param size workers to start. Defaults to one fewer than the core count, leaving a core for the
 *        main thread so it can collect results and write checkpoints without competing.
 */
export const createEvaluationPool = (size?: number): EvaluationPool => {
  const count = Math.max(1, size ?? Math.max(1, availableParallelism() - 1));
  const workers: Worker[] = [];
  const idle: Worker[] = [];
  const pending = new Map<Worker, Pending>();

  const start = (): Worker => {
    const worker = new Worker(WORKER_PATH);
    worker.unref();
    workers.push(worker);
    idle.push(worker);
    return worker;
  };

  /** Waits for any worker to become free. */
  const takeIdle = (): Promise<Worker> =>
    new Promise((resolve) => {
      const check = (): void => {
        const worker = idle.pop();
        if (worker) resolve(worker);
        else setTimeout(check, 1);
      };
      check();
    });

  const runOne = async (request: EvaluationRequest): Promise<EvaluationResult> => {
    const worker = await takeIdle();
    return new Promise<EvaluationResult>((resolve, reject) => {
      pending.set(worker, { resolve, reject });
      /*
       * The genes are sent as a plain array rather than a typed array. A `Float64Array` is
       * structured-cloneable and would be faster, but it arrives in the worker as a typed array
       * whose length the worker then has to validate against the network it builds — and a
       * checkpoint written as JSON is a plain array anyway. One representation throughout, so
       * nothing has to convert between them.
       */
      worker.postMessage({ ...request, genes: Array.from(request.genes) });
    });
  };

  for (let i = 0; i < count; i++) start();

  for (const worker of workers) {
    worker.on("message", (message: EvaluationResult) => {
      const entry = pending.get(worker);
      pending.delete(worker);
      idle.push(worker);
      entry?.resolve(message);
    });
    worker.on("error", (error: Error) => {
      const entry = pending.get(worker);
      pending.delete(worker);
      entry?.reject(error);
    });
  }

  return {
    size: count,
    async run(requests: EvaluationRequest[]): Promise<EvaluationResult[]> {
      // `Promise.all` preserves input order regardless of which worker finishes first, which is what
      // keeps a generation reproducible.
      return Promise.all(requests.map(runOne));
    },
    async close(): Promise<void> {
      await Promise.all(workers.map((worker) => worker.terminate()));
    },
  };
};
