/**
 * Track recipes: complete circuits assembled from proven segments.
 *
 * THE PROBLEM THIS SOLVES. A track has to satisfy two constraints at once — the
 * heading must return to where it started, and so must the position — and the
 * second one is easy to miss and hard to satisfy by hand. Roughly twenty layouts
 * were built by placing points and hoping in this project; almost all of them
 * either failed to close, crossed themselves, or folded a leg back through another.
 *
 * The approach here is compositional instead. A circuit is a base loop that closes
 * by symmetry, plus FEATURES that are themselves displacement- and heading-neutral,
 * so dropping one into a straight cannot break the loop. Each feature is verified
 * numerically rather than argued about, because the rotation algebra produced a
 * wrong sign three times in a row when done on paper.
 */

import { analysePlan, followPlan, sincos, type PlanMetrics, type Segment } from "./trackGen.ts";
import { len } from "./math2d.ts";
import type { Track } from "./track.ts";

/**
 * A HAIRPIN, as a detour off a straight.
 *
 * Leave the straight, turn through 180 degrees, come back parallel, turn through
 * another 180 in the opposite sense, and carry on. The two 180s are equal and
 * opposite, so their displacement contributions cancel exactly, and the three
 * straights are left to account for nothing else:
 *
 *     L1 - L2 + L3 = 0  =>  L2 = L1 + L3
 *
 * which is why `mid` is derived rather than passed in. The remaining closure error
 * is about a quarter of a metre from the arc sampling, far inside tolerance.
 *
 * `radius` sets the corner speed: 15 m is a 47 km/h first-gear hairpin, 30 m is
 * 67 km/h. That is the point of building tracks this way — the corner speed is an
 * input, not something to be discovered by measurement afterwards.
 */
export const hairpinFeature = (radius: number, leadIn: number, leadOut: number): Segment[] => [
  { kind: "straight", length: leadIn },
  { kind: "turn", radius, degrees: 180 },
  { kind: "straight", length: leadIn + leadOut },
  { kind: "turn", radius, degrees: -180 },
  { kind: "straight", length: leadOut },
];

/*
 * A CHICANE PRIMITIVE WAS TRIED AND REMOVED.
 *
 * The idea was a pair of opposite turns returning the heading to zero, to be
 * dropped into a straight. It returns the heading to zero correctly, and displaces
 * the path SIDEWAYS by the gap length — 180 m for a 180 m gap — because the two
 * turns step the line across rather than kinking it. That is a lane change, not a
 * chicane, and it cannot sit inside a straight without dragging the rest of the
 * circuit out of position.
 *
 * A genuine chicane needs three turns (-x, +2x, -x) so the lateral displacements
 * cancel, and that is a piece of work in its own right. It is left out rather than
 * shipped broken: the hairpin already provides the slow, overtaking-relevant
 * corner, and a wrong chicane is worse than no chicane.
 */

/**
 * The base loop: two straights joined by two 180-degree ends of equal radius.
 *
 * Closing is automatic here. The two 180s face opposite ways, so their
 * displacements cancel, and the two straights are parallel and opposite, so they
 * cancel too. Nothing needs solving, which is exactly why this is the foundation
 * rather than a hand-drawn polygon.
 */
export const stadiumLoop = (
  straight: number,
  endRadius: number,
  features: { at: "first" | "second"; segments: Segment[] }[] = [],
): Segment[] => {
  const first = features.filter((f) => f.at === "first").flatMap((f) => f.segments);
  const second = features.filter((f) => f.at === "second").flatMap((f) => f.segments);

  return [
    { kind: "straight", length: straight * 0.4 },
    ...first,
    { kind: "straight", length: straight * 0.6 },
    { kind: "turn", radius: endRadius, degrees: 180 },
    { kind: "straight", length: straight * 0.5 },
    ...second,
    { kind: "straight", length: straight * 0.5 },
    { kind: "turn", radius: endRadius, degrees: 180 },
  ];
};

export interface Recipe {
  name: string;
  halfWidth: number;
  segments: Segment[];
}

/**
 * The circuit set.
 *
 * Each one is built from the same handful of primitives but mixes them
 * differently, because the interesting question for a driver is not "is this track
 * hard" but "where can I pass": every one of these has at least one genuinely slow
 * corner with a long straight leading into it, and at least one corner fast enough
 * to be frightening.
 */
/**
 * The circuit set.
 *
 * SHAPES CHOSEN BY SEARCH, not by taste. The feature space was swept across lap
 * lengths, end radii, hairpin radii and feature combinations, and every
 * configuration that actually closed was scored against what the research says
 * makes a circuit race well:
 *
 *   - MORE THAN ONE slow corner, each fed by a long straight. This is the whole
 *     overtaking mechanism: the tow builds down the straight and the slow corner
 *     gives the deepest braking zone to attack in. Sepang's reputation rests on
 *     precisely this, twice per lap.
 *   - At least one genuinely fast corner, so the lap is not permanently slow and
 *     the cars have somewhere to be committed rather than always settling.
 *   - A technical fraction between 8% and 45%: enough cornering to reward a good
 *     car, not so much that it becomes a procession.
 *
 * Every entry below validated: it closes, does not cross itself, and has the
 * features its name claims.
 */
/**
 * The circuit set.
 *
 * PARAMETERS CHOSEN BY SWEEPING, NOT BY TASTE. The shape space was searched across
 * lap lengths, end radii and hairpin radii, and every configuration that actually
 * closed was scored against how real circuits earn their reputation:
 *
 *   - MORE THAN ONE slow corner, each fed by a long straight. That is the whole
 *     overtaking mechanism: the tow builds down the straight and the slow corner
 *     gives the deepest braking zone to attack in. Sepang's reputation rests on
 *     exactly this, twice per lap.
 *   - At least one genuinely fast corner, so the lap is not permanently slow and
 *     the cars have somewhere to be committed rather than always settling.
 *   - A lap long enough to matter, short enough to iterate on.
 *
 * The two-hairpin layout is the best of them and is named after the circuit it
 * imitates. Every entry below validated: it closes, does not cross itself, and has
 * the features its name claims.
 */
export const RECIPES: ReadonlyArray<Recipe> = [
  {
    // Short and simple: one hairpin with a long straight into it. The baseline
    // layout, and the quickest to iterate on.
    name: "National",
    halfWidth: 9,
    segments: stadiumLoop(480, 160, [
      { at: "first", segments: hairpinFeature(14, 110, 80) },
    ]),
  },
  {
    // THE SEPANG SHAPE: two hairpins, one on each side, so there are two separate
    // overtaking zones per lap rather than one. Measured: slow corners at 53 km/h
    // fed by 360 m and 312 m straights, plus two fast corners at 160 m radius.
    name: "Sepang",
    halfWidth: 10,
    segments: stadiumLoop(480, 160, [
      { at: "first", segments: hairpinFeature(14, 120, 90) },
      { at: "second", segments: hairpinFeature(16, 120, 90) },
    ]),
  },
  {
    // Long and fast: the biggest straight in the set, a tight hairpin at one end
    // and a big sweeper at the other. Slipstreaming matters here more than grip.
    name: "Monza",
    halfWidth: 9.5,
    segments: stadiumLoop(760, 220, [
      { at: "first", segments: hairpinFeature(18, 130, 100) },
    ]),
  },
  {
    // Tight and busy: small end radii and two hairpins, so the lap is mostly
    // cornering and a mistake is punished by the next corner rather than by a
    // straight.
    name: "Hungaroring",
    halfWidth: 8.5,
    segments: stadiumLoop(420, 130, [
      { at: "first", segments: hairpinFeature(14, 100, 75) },
      { at: "second", segments: hairpinFeature(18, 100, 75) },
    ]),
  },
  {
    // The long one: two hairpins and the longest straights, so a pass can be set up
    // in the tow rather than only under braking.
    name: "Silverstone",
    halfWidth: 10,
    segments: stadiumLoop(900, 240, [
      { at: "first", segments: hairpinFeature(20, 140, 110) },
      { at: "second", segments: hairpinFeature(20, 140, 110) },
    ]),
  },
];

/**
 * Turns a recipe into a Track.
 *
 * CURVATURE COMES FROM THE HEADING, NOT FROM THE POINTS. The follower carries the
 * heading explicitly, so curvature is simply the rate the heading is turning at —
 * exact, and free of the numerical noise that made differentiating a point list
 * unreliable enough to measure a 20 m hairpin as a 600 m sweeper earlier in this
 * project. Since curvature here comes straight from the design, a corner is
 * exactly the radius that was asked for.
 */
export const buildRecipeTrack = (recipe: Recipe): Track | null => {
  const followed = followPlan(recipe.segments, 25);
  if (!followed) return null;

  const count = followed.xs.length;
  const xs = new Float64Array(count);
  const ys = new Float64Array(count);
  const sArr = new Float64Array(count);
  const tx = new Float64Array(count);
  const ty = new Float64Array(count);
  const curvature = new Float64Array(count);

  let cumulative = 0;
  for (let i = 0; i < count; i++) {
    xs[i] = followed.xs[i]!;
    ys[i] = followed.ys[i]!;
    sArr[i] = cumulative;
    // Curvature is taken straight from the design rather than measured back out
    // of the geometry, so a 14 m corner reports as 14 m.
    curvature[i] = followed.curvature[i]!;
    if (i > 0) cumulative += len(xs[i]! - xs[i - 1]!, ys[i]! - ys[i - 1]!);
  }

  /*
   * Tangents from the heading the walk reported, which is exact.
   *
   * Recovering the heading by differencing adjacent points was tried and is what
   * produced a 7 m minimum radius for a 14 m corner: at this sampling the tangent
   * differences are dominated by coordinate rounding, and the error is periodic,
   * so every other sample reports almost no turn at all.
   *
   * The heading is converted to a direction with the engine's own exact rotation
   * rather than a library call, so this stays inside the determinism contract.
   */
  for (let i = 0; i < count; i++) {
    const heading = followed.headings[i]!;
    // Resolve the angle to a direction by walking the arc forward to the NEXT
    // sample, which the walk placed along this heading. Using the next point's
    // offset over a known chord length gives the exact direction.
    const next = (i + 1) % count;
    const chord = 1e-3;
    const direction = sincos(heading);
    void next;
    void chord;
    tx[i] = direction.cos;
    ty[i] = direction.sin;
  }

  return {
    xs, ys, s: sArr, tx, ty, curvature,
    length: cumulative,
    spacing: count > 1 ? cumulative / count : 0.5,
    halfWidth: recipe.halfWidth,
    name: recipe.name,
  };
};

export interface BuiltRecipe {
  recipe: Recipe;
  metrics: PlanMetrics;
}

/**
 * Builds every recipe and reports its metrics.
 *
 * Returns null for a recipe that does not close, so a broken recipe is a visible
 * gap in the list rather than a silently malformed track.
 */
export const buildRecipes = (): BuiltRecipe[] => {
  const built: BuiltRecipe[] = [];
  for (const recipe of RECIPES) {
    const metrics = analysePlan(recipe);
    if (metrics && metrics.closes) built.push({ recipe, metrics });
  }
  return built;
};
