/**
 * Training entry point.
 *
 * Runs an evolution strategy against a circuit for as long as it is asked to, reporting
 * progress and checkpointing so a long run can be interrupted at any point and still be
 * useful.
 *
 *   node packages/cli/src/train.ts [options]
 *
 * The defaults are aimed at the overnight run this project was built for: leave it going and
 * come back to a trained driver. Everything that matters is on the command line, and the
 * checkpoint holds the best parameters ever found rather than the current search state, so an
 * interrupted run still yields the best driver it produced.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { CIRCUITS, buildCircuitByKey } from "../../engine/src/trackLibrary.ts";
import {
  createTrainer,
  trainGeneration,
  bestDriver,
  assessRun,
  type GenerationReport,
  type TrainerState,
} from "../../engine/src/evolve.ts";
import { runDriver, DEFAULT_RUN_SECONDS } from "../../engine/src/environment.ts";
import { createEvaluationPool } from "../../trainer/src/evaluationPool.ts";
import { PARAMETER_COUNT } from "../../engine/src/driver.ts";
import type { Track } from "../../engine/src/track.ts";

interface Options {
  circuit: string;
  seconds: number;
  hours: number;
  population: number;
  learningRate: number;
  sigma: number;
  seed: number;
  checkpoint: string;
  reportEvery: number;
  quiet: boolean;
  resume: boolean;
  workers: number | undefined;
}

const USAGE = `
Train a driver by evolution strategy.

  --circuit <key>      circuit to train on (default club)
  --seconds <n>        simulated seconds per evaluation (default ${DEFAULT_RUN_SECONDS})
  --hours <n>          stop after this many hours (default 16)
  --population <n>     perturbations per generation (default 16)
  --learning-rate <x>  Adam step size (default 0.05)
  --sigma <x>          perturbation standard deviation (default 0.02)
  --seed <n>           random seed, for a reproducible run (default 1)
  --checkpoint <path>  where to save the best driver (default checkpoints/<circuit>.json)
  --report <n>         print a line every n generations (default 10)
  --workers <n>        evaluation worker threads (default: one per core, minus one)
  --quiet              only print checkpoints and the final summary
  --no-resume          start from a fresh random draw instead of the checkpoint
  --list               list the available circuits and exit

Resuming is the default when a checkpoint exists for the chosen circuit, because a long run is
worth hours of progress by the time anything interrupts it.
`;

const parseArgs = (argv: string[]): Options | null => {
  const options: Options = {
    circuit: "club",
    seconds: DEFAULT_RUN_SECONDS,
    hours: 16,
    population: 16,
    learningRate: 0.05,
    sigma: 0.02,
    seed: 1,
    checkpoint: "",
    reportEvery: 10,
    quiet: false,
    resume: true,
    workers: undefined,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const next = (): string => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      return value;
    };
    switch (arg) {
      case "--circuit": options.circuit = next(); break;
      case "--seconds": options.seconds = Number(next()); break;
      case "--hours": options.hours = Number(next()); break;
      case "--population": options.population = Number(next()); break;
      case "--learning-rate": options.learningRate = Number(next()); break;
      case "--sigma": options.sigma = Number(next()); break;
      case "--seed": options.seed = Number(next()); break;
      case "--checkpoint": options.checkpoint = next(); break;
      case "--report": options.reportEvery = Number(next()); break;
      case "--quiet": options.quiet = true; break;
      case "--no-resume": options.resume = false; break;
      case "--workers": options.workers = Number(next()); break;
      case "--help": case "-h": console.log(USAGE); return null;
      case "--list":
        console.log("circuits:");
        for (const circuit of CIRCUITS) console.log(`  ${circuit.key.padEnd(10)} ${circuit.name}`);
        return null;
      default:
        throw new Error(`unknown option ${arg}\n${USAGE}`);
    }
  }
  if (!options.checkpoint) options.checkpoint = `checkpoints/${options.circuit}.json`;
  return options;
};

/**
 * Saves the best parameters found so far.
 *
 * The format is deliberately plain JSON with the metadata a run needs to be interpreted: which
 * circuit it was trained on, how long each evaluation was, and what it scored. A checkpoint
 * without that context is not reproducible, and a driver whose training conditions are unknown
 * cannot be compared with another.
 */
const saveCheckpoint = (
  path: string,
  options: Options,
  generation: number,
  fitness: number,
  genes: Float64Array,
): void => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify(
      {
        version: 1,
        circuit: options.circuit,
        seconds: options.seconds,
        seed: options.seed,
        generation,
        fitness,
        parameterCount: PARAMETER_COUNT,
        genes: Array.from(genes),
      },
      null,
      1,
    ),
  );
};

/**
 * Writes a line and flushes it.
 *
 * Node buffers stdout when it is not a terminal, which for a redirected overnight run means the
 * log lags the work by minutes and shows nothing at all until a buffer fills. A training run is
 * watched while it happens, so the output is forced out every time.
 */
const say = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

/**
 * Reads a checkpoint to continue from, or explains why it cannot be used.
 *
 * The circuit and evaluation length are CHECKED rather than assumed. Parameters trained for
 * ninety-second runs on the club circuit are not a valid starting point for another circuit, and
 * silently continuing from them would look like a run that had suddenly got worse for no reason.
 */
interface Resumed {
  genes: Float64Array;
  generation: number;
  fitness: number;
}

const readCheckpoint = (path: string, options: Options): Resumed | string => {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return "no checkpoint yet";
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return "checkpoint is not valid JSON";
  }
  const record = parsed as Partial<Resumed> & { circuit?: string; seconds?: number; parameterCount?: number };
  if (!Array.isArray(record.genes)) return "checkpoint has no genes";
  if (record.circuit !== options.circuit) {
    return `checkpoint is for ${record.circuit}, not ${options.circuit}`;
  }
  if (record.seconds !== options.seconds) {
    return `checkpoint was trained with ${record.seconds} s evaluations, not ${options.seconds}`;
  }
  if (record.genes.length !== PARAMETER_COUNT) {
    return `checkpoint has ${record.genes.length} parameters, this build needs ${PARAMETER_COUNT}`;
  }
  return {
    genes: Float64Array.from(record.genes as number[]),
    generation: record.generation ?? 0,
    fitness: record.fitness ?? 0,
  };
};

/**
 * Writes a status file the viewer can poll, so a training run is watchable as it happens.
 *
 * WITHOUT THIS A LONG RUN IS INVISIBLE. A thirteen-hour run once improved for six generations and
 * then achieved nothing for five thousand more, and the only trace was a column of numbers in a log
 * file nobody was watching. The failure was not that the information did not exist, it is that
 * nothing put it where it could be seen.
 *
 * The file carries the elite's parameters as well as the numbers, so the viewer can DRIVE the
 * current best driver while the search continues. Watching the car is the fastest way to notice
 * that something is wrong: a driver fighting its own steering or refusing to brake is obvious on
 * screen and invisible in a fitness number.
 */
const writeStatus = (
  path: string,
  options: Options,
  state: TrainerState,
  report: GenerationReport,
  warning: string,
  secondsPerGeneration: number,
  elapsed: number,
): void => {
  writeFileSync(
    path,
    JSON.stringify({
      version: 1,
      circuit: options.circuit,
      seconds: options.seconds,
      seed: options.seed,
      budgetHours: options.hours,
      generation: report.generation,
      elapsed,
      secondsPerGeneration,
      bestGeneration: state.bestGeneration,
      bestFitness: state.bestFitness,
      currentFitness: report.currentFitness,
      bestSampleFitness: report.bestSampleFitness,
      meanFitness: report.meanFitness,
      meanDistance: report.meanDistance,
      meanOnTrack: report.meanOnTrack,
      warning,
      // The elite, so the viewer can drive it.
      parameterCount: PARAMETER_COUNT,
      genes: Array.from(state.best),
    }),
  );
};

const formatClock = (seconds: number): string => {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return `${h}h ${String(m).padStart(2, "0")}m ${String(s).padStart(2, "0")}s`;
};

const main = async (): Promise<void> => {
  let options: Options | null;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 1;
    return;
  }
  if (!options) return;

  const track: Track | null = buildCircuitByKey(options.circuit);
  if (!track) {
    console.error(`no such circuit: ${options.circuit}`);
    process.exitCode = 1;
    return;
  }

  const checkpointPath = resolve(options.checkpoint);
  const statusPath = resolve(dirname(options.checkpoint), `${options.circuit}.status.json`);

  /*
   * Resume by default when a checkpoint exists.
   *
   * A long run is worth hours of progress by the time anything interrupts it, so starting over
   * silently would throw that away. `readCheckpoint` also validates that the checkpoint belongs
   * to this circuit and this evaluation length, because parameters trained for one circuit are
   * not a valid starting point for another and continuing from them would look like a run that
   * had mysteriously got worse.
   */
  let initial: Float64Array | undefined;
  let resumedGeneration = 0;
  if (options.resume) {
    const resumed = readCheckpoint(checkpointPath, options);
    if (typeof resumed === "string") {
      say(`starting fresh: ${resumed}`);
    } else {
      initial = resumed.genes;
      resumedGeneration = resumed.generation;
      say(
        `resuming from generation ${resumed.generation}, whose recorded fitness was ` +
          `${resumed.fitness.toFixed(0)}`,
      );
    }
  }

  const state = createTrainer(
    options.seed,
    {
      populationSize: options.population,
      learningRate: options.learningRate,
      sigma: options.sigma,
    },
    initial,
  );
  state.generation = resumedGeneration;

  say(`training on ${track.name} (${track.length.toFixed(0)} m)`);
  say(
    `${options.population} perturbations per generation, ${options.seconds} s per evaluation, ` +
      `seed ${options.seed}`,
  );
  say(`${PARAMETER_COUNT} parameters, ${formatClock(options.hours * 3600)} budget`);
  say(`checkpointing to ${checkpointPath}\n`);

  /*
   * Spread the evaluations across the cores.
   *
   * Every evaluation is independent of every other, so this is free performance: measured on this
   * machine, 4.3x with results that are BIT-IDENTICAL to running serially, because scores are
   * collected by index rather than by whichever worker finished first.
   */
  const pool = createEvaluationPool(options.workers);
  say(`evaluating across ${pool.size} worker threads`);
  const started = Date.now();
  const deadline = started + options.hours * 3600 * 1000;
  let best = -Infinity;
  let generations = 0;
  let interrupted = false;
  /** The last health warning printed, so the same one is not repeated every generation. */
  let lastWarning = "";

  /*
   * A long run has to survive being stopped. Ctrl-C saves before exiting, so an overnight run
   * that gets interrupted is still worth the electricity.
   */
  const onInterrupt = (): void => {
    interrupted = true;
  };
  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onInterrupt);

  say("gen      best (m/s)   mean dist   on track    elapsed");
  while (Date.now() < deadline && !interrupted) {
    const report = await trainGeneration(state, track, { seconds: options.seconds }, undefined, pool);
    generations++;

    if (report.bestEverFitness > best) {
      best = report.bestEverFitness;
      saveCheckpoint(checkpointPath, options, state.bestGeneration, best, state.best);
      if (options.quiet) {
        say(`  new best ${best.toFixed(1)} m/s at generation ${state.bestGeneration}, saved`);
      }
    }

    /*
     * Say so when the run stops being useful.
     *
     * A thirteen-hour run once improved for six generations and then achieved nothing for 5,300
     * more, and the log did not mention it — the best-ever column simply never changed. Reporting
     * the symptom in words is the difference between a run that is watched and one that is merely
     * left running.
     */
    const health = assessRun(state, report);

    /*
     * Publish after every generation rather than only on an improvement, so the viewer shows the
     * search as it moves and not just the moments it succeeded.
     */
    const elapsedSeconds = (Date.now() - started) / 1000;
    try {
      writeStatus(
        statusPath,
        options,
        state,
        report,
        health.warning,
        elapsedSeconds / Math.max(1, generations),
        elapsedSeconds,
      );
    } catch {
      // A status file is a convenience; failing to write one must not stop a long run.
    }

    if (health.warning && health.warning !== lastWarning) {
      lastWarning = health.warning;
      say(`  WARNING after generation ${report.generation}: ${health.warning}`);
    } else if (!health.warning) {
      lastWarning = "";
    }

    if (!options.quiet && report.generation % options.reportEvery === 0) {
      const elapsed = (Date.now() - started) / 1000;
      say(
        `${String(report.generation).padStart(4)}  ${best.toFixed(1).padStart(11)}  ` +
          `${report.meanDistance.toFixed(0).padStart(11)}  ` +
          `${(report.meanOnTrack * 100).toFixed(0).padStart(8)}%  ` +
          `${formatClock(elapsed).padStart(12)}`,
      );
    }
  }

  process.off("SIGINT", onInterrupt);
  process.off("SIGTERM", onInterrupt);
  await pool.close();

  // Final evaluation of the best driver, on a longer run than it was trained on. A driver that
  // only works for exactly its training duration has not learned to drive the circuit.
  const finalSeconds = Math.max(options.seconds, 120);
  const finalResult = runDriver(bestDriver(state), track, { seconds: finalSeconds });
  say(
    `\n${interrupted ? "interrupted" : "finished"} after ${generations} generations ` +
      `in ${formatClock((Date.now() - started) / 1000)}`,
  );
  say(
    `best driver over ${finalSeconds} s: ${finalResult.distance.toFixed(0)} m, ` +
      `${finalResult.laps} laps, ${finalResult.averageSpeed.toFixed(1)} m/s average ` +
      `(${(finalResult.averageSpeed * 3.6).toFixed(0)} km/h), ` +
      `on track ${(finalResult.onTrackFraction * 100).toFixed(0)}%, ` +
      `braking ${(finalResult.lockedFraction * 100).toFixed(0)}% locked, ` +
      `spinning ${(finalResult.wheelspinFraction * 100).toFixed(0)}%`,
  );
  /*
   * Always write a final checkpoint. If nothing ever improved, that is itself worth saving —
   * the file then holds the starting draw and `bestFitness` will be whatever it scored, which
   * is a clear signal that the run needs different settings rather than a silent surprise.
   */
  saveCheckpoint(checkpointPath, options, state.bestGeneration, state.bestFitness, state.best);
  say(`saved to ${checkpointPath}`);
};

await main();
