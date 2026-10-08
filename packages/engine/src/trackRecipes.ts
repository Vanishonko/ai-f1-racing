/**
 * Turning a solved design into a Track.
 *
 * THE DESIGN SIDE (`trackDesign.ts`) fixes the corner angles and solves the straight
 * lengths so the loop closes. This side walks that segment list and assembles the
 * sample arrays the rest of the engine indexes.
 *
 * HISTORY, because this file was rewritten rather than repaired. It previously
 * carried a hairpin-detour generator and a set of composed recipes. Those were a dead
 * end: a hairpin fed from inside a straight necessarily has its return leg cross the
 * outbound one, so every one of 3,600 generated configurations that closed also
 * crossed itself. The generator is gone; only the assembly remains.
 */

import { followPlan, sincos, type Segment } from "./trackGen.ts";
import type { Track } from "./track.ts";
import { toWalk, type SolvedDesign } from "./trackDesign.ts";

/** What the segment walker hands back, before it becomes a Track. */
interface Walk {
  xs: number[];
  ys: number[];
  headings: number[];
  curvature: number[];
}

/**
 * Assembles a Track from a finished walk.
 *
 * TWO PASSES ON PURPOSE. The first measures, the second stores. A single-pass
 * version accumulated the running arc length in the same loop that wrote it into the
 * array, and the two disagreed: the stored array grew exponentially while a recount
 * over the very same coordinates gave the correct total, and a great deal of time
 * went into finding that. Measuring first removes the whole class of bug, because
 * every step length is known before a single value is written.
 */
export const assembleTrack = (name: string, halfWidth: number, walk: Walk): Track => {
  const count = walk.xs.length;

  // Pass 1: measure. `steps[i]` is the distance from sample i to sample i+1, with the
  // final entry closing the loop back to sample 0.
  const steps = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    const next = (i + 1) % count;
    const dx = walk.xs[next]! - walk.xs[i]!;
    const dy = walk.ys[next]! - walk.ys[i]!;
    steps[i] = Math.sqrt(dx * dx + dy * dy);
  }

  // Pass 2: store. `s[i]` is the arc length from sample 0 TO sample i, so it is the
  // running total of every step BEFORE i. The lap length is the total of all of them,
  // including the closing step.
  const xs = new Float64Array(count);
  const ys = new Float64Array(count);
  const s = new Float64Array(count);
  const tx = new Float64Array(count);
  const ty = new Float64Array(count);
  const curvature = new Float64Array(count);

  let running = 0;
  for (let i = 0; i < count; i++) {
    xs[i] = walk.xs[i]!;
    ys[i] = walk.ys[i]!;
    s[i] = running;
    curvature[i] = walk.curvature[i]!;
    running += steps[i]!;
  }
  const lapLength = running;

  /*
   * Tangents come from the heading the walk reported, which is exact. Recovering
   * them by differencing adjacent points was tried and is what produced a 7 m
   * minimum radius for a 14 m corner: at this sampling the differences are dominated
   * by coordinate rounding and the error is periodic.
   */
  for (let i = 0; i < count; i++) {
    const direction = sincos(walk.headings[i]!);
    tx[i] = direction.cos;
    ty[i] = direction.sin;
  }

  return {
    xs,
    ys,
    s,
    tx,
    ty,
    curvature,
    length: lapLength,
    spacing: count > 0 ? lapLength / count : 0.5,
    halfWidth,
    name,
  };
};

/** Builds a Track from a solved design. This is the supported path. */
export const buildDesignedTrack = (design: SolvedDesign): Track | null => {
  const walk = followPlan(toWalk(design), 25);
  return walk ? assembleTrack(design.name, design.halfWidth, walk) : null;
};

/** Builds a Track from a raw segment list, for tests and experiments. */
export const buildSegmentTrack = (
  name: string,
  halfWidth: number,
  segments: readonly Segment[],
): Track | null => {
  const walk = followPlan(segments, 25);
  return walk ? assembleTrack(name, halfWidth, walk) : null;
};
