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

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { CIRCUITS, buildCircuitByKey } from "../../engine/src/trackLibrary.ts";
import { createTrainer, trainGeneration, bestDriver } from "../../engine/src/evolve.ts";
import { runDriver, DEFAULT_RUN_SECONDS } from "../../engine/src/environment.ts";
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
  --quiet              only print checkpoints and the final summary
  --list               list the available circuits and exit
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

const formatClock = (seconds: number): string => {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return `${h}h ${String(m).padStart(2, "0")}m ${String(s).padStart(2, "0")}s`;
};

const main = (): void => {
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
  const state = createTrainer(options.seed, {
    populationSize: options.population,
    learningRate: options.learningRate,
    sigma: options.sigma,
  });

  say(`training on ${track.name} (${track.length.toFixed(0)} m)`);
  say(
    `${options.population} perturbations per generation, ${options.seconds} s per evaluation, ` +
      `seed ${options.seed}`,
  );
  say(`${PARAMETER_COUNT} parameters, ${formatClock(options.hours * 3600)} budget`);
  say(`checkpointing to ${checkpointPath}\n`);

  const started = Date.now();
  const deadline = started + options.hours * 3600 * 1000;
  let best = -Infinity;
  let generations = 0;
  let interrupted = false;

  /*
   * A long run has to survive being stopped. Ctrl-C saves before exiting, so an overnight run
   * that gets interrupted is still worth the electricity.
   */
  const onInterrupt = (): void => {
    interrupted = true;
  };
  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onInterrupt);

  say("gen      best-ever    mean dist   on track    elapsed");
  while (Date.now() < deadline && !interrupted) {
    const report = trainGeneration(state, track, { seconds: options.seconds });
    generations++;

    if (report.bestEverFitness > best) {
      best = report.bestEverFitness;
      saveCheckpoint(checkpointPath, options, state.bestGeneration, best, state.best);
      if (options.quiet) {
        say(`  new best ${best.toFixed(0)} at generation ${state.bestGeneration}, saved`);
      }
    }

    if (!options.quiet && report.generation % options.reportEvery === 0) {
      const elapsed = (Date.now() - started) / 1000;
      say(
        `${String(report.generation).padStart(4)}  ${best.toFixed(0).padStart(11)}  ` +
          `${report.meanDistance.toFixed(0).padStart(11)}  ` +
          `${(report.meanOnTrack * 100).toFixed(0).padStart(8)}%  ` +
          `${formatClock(elapsed).padStart(12)}`,
      );
    }
  }

  process.off("SIGINT", onInterrupt);
  process.off("SIGTERM", onInterrupt);

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
      `${finalResult.laps} laps, on track ${(finalResult.onTrackFraction * 100).toFixed(0)}%, ` +
      `mean tire use ${finalResult.meanUtilization.toFixed(2)}`,
  );
  /*
   * Always write a final checkpoint. If nothing ever improved, that is itself worth saving —
   * the file then holds the starting draw and `bestFitness` will be whatever it scored, which
   * is a clear signal that the run needs different settings rather than a silent surprise.
   */
  saveCheckpoint(checkpointPath, options, state.bestGeneration, state.bestFitness, state.best);
  say(`saved to ${checkpointPath}`);
};

main();
