/*
 * What is the elite actually being paid for?
 *
 * The training curves stall, and three separate explanations have been proposed: the checkpoint index
 * running away, the checkpoint reward saturating, and the anneal switching the objective off. They
 * predict different numbers, so the only way to choose is to print the terms.
 *
 * Reads a checkpoint file and reports every component of the fitness under a range of run lengths and
 * ladder settings, so a change to the reward can be judged against the numbers it replaces rather
 * than against a feeling.
 *
 *   node scripts/reward-breakdown.ts [--checkpoint checkpoints/club.json] [--circuit club]
 */
import { readFileSync } from "node:fs";
import { buildCircuitByKey } from "../packages/engine/src/trackLibrary.ts";
import { runDriver, DEFAULT_LADDER } from "../packages/engine/src/environment.ts";
import { createDriver } from "../packages/engine/src/driver.ts";
import { cornerCheckpoints } from "../packages/engine/src/track.ts";
import { ladderFor } from "../packages/engine/src/evolve.ts";

const arg = (name: string, fallback: string): string => {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 && process.argv[at + 1] ? process.argv[at + 1]! : fallback;
};

const checkpointPath = arg("checkpoint", "checkpoints/club.json");
const circuitKey = arg("circuit", "club");

const file = JSON.parse(readFileSync(checkpointPath, "utf8")) as { genes: number[] };
const genes = Float64Array.from(file.genes);
const track = buildCircuitByKey(circuitKey);
if (!track) throw new Error(`unknown circuit ${circuitKey}`);

const checkpoints = cornerCheckpoints(track);
console.log(`circuit            ${track.name} (${track.length.toFixed(0)} m)`);
console.log(`corner checkpoints ${checkpoints.length}`);
console.log(`genes              ${genes.length}`);
console.log("");

const driver = () => createDriver(genes.slice(), () => 0.5);
const ladder = DEFAULT_LADDER;

const pad = (s: string, n: number) => s.padStart(n);
const header = [
  pad("sec", 5),
  pad("laps", 5),
  pad("dist", 8),
  pad("avg", 7),
  pad("onTk", 6),
  pad("cu", 6),
  pad("cpPass", 7),
  pad("cpCredit", 9),
  pad("meanLap", 8),
  pad("lapR", 8),
  pad("cpR", 8),
  pad("fitness", 10),
];
console.log(header.join(""));

/** Recompute the named terms so the printout can be checked against `runDriver`'s own total. */
const report = (seconds: number, generation: number): void => {
  const l = ladderFor(generation, ladder);
  const r = runDriver(driver(), track, {
    seconds,
    cornerCheckpoints: true,
    lapReward: l.lapReward,
    checkpointReward: l.checkpointReward,
  });
  console.log(
    [
      pad(seconds.toFixed(0), 5),
      pad(String(r.laps), 5),
      pad(r.distance.toFixed(0), 8),
      pad(r.averageSpeed.toFixed(2), 7),
      pad((r.onTrackFraction * 100).toFixed(1), 6),
      pad(String(r.checkpointCount), 6),
      pad(String(r.checkpointsPassed), 7),
      pad(r.checkpointCredit.toFixed(3), 9),
      pad(r.meanLapCredit.toFixed(3), 8),
      pad(r.lapReward.toFixed(0), 8),
      pad(r.checkpointReward.toFixed(0), 8),
      pad(r.fitness.toFixed(0), 10),
    ].join(""),
  );
};

console.log("--- ladder at the elite's own generation (834), varying run length ---");
for (const seconds of [90, 120, 180, 240, 300]) report(seconds, 834);

console.log("");
console.log("--- the same run as the anneal progresses (180 s, so several laps are available) ---");
for (const generation of [0, 250, 500, 834, 1250, 1500, 2000, 2500]) report(180, generation);

console.log("");
console.log("--- per-lap checkpoint credit, to see whether it is measured per lap or once ever ---");
{
  const r = runDriver(driver(), track, {
    seconds: 240,
    cornerCheckpoints: true,
    lapReward: 0,
    checkpointReward: 0,
  });
  console.log(
    `240 s: ${r.laps} laps, ${r.distance.toFixed(0)} m, checkpointCredit ${r.checkpointCredit.toFixed(3)} ` +
      `of ${r.checkpointCount}, best ${r.checkpointBestFraction.toFixed(3)}`,
  );
}
