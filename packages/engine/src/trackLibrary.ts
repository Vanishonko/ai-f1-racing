/**
 * The circuit set.
 *
 * Four circuits, chosen so that a lap time means the same thing twice: a fixed set of
 * layouts is what makes "is this driver getting better" a measurable question, and
 * variety across the set is what stops a driver overfitting to one shape.
 *
 * Each circuit is control points run through the corner-rounding spline in `track.ts`.
 * Two of them are traced from real circuit diagrams and two are authored by hand, but
 * they are stored identically — the difference is provenance, not structure, and it is
 * recorded in each circuit's own file.
 *
 *  - `spa`      a real circuit: 7013 m, 27 corners, 54-210 km/h, nine overtaking zones.
 *               The benchmark. Everything being compared should be measured here.
 *  - `baku`     a real street circuit: 6007 m, 19 corners, a very long main straight
 *               and a tight middle sector. Tests braking from top speed and patience.
 *  - `chicane`  authored: 5445 m, 17 corners, three genuinely slow corners. Tests
 *               direction changes under load — releasing the brake and letting the car
 *               settle before turning in.
 *  - `club`     authored: 3521 m, 14 corners, four slow and three fast. A full circuit
 *               with a long run to the final corner, so a mistake in the last sector is
 *               recoverable up to the line. The layout for close finishes.
 *
 * WHAT DOES NOT BELONG HERE. This file once also held a generated-track experiment and
 * two layouts built by polygon filleting; both were removed once nothing imported them.
 * Anything added here should be a circuit that is actually raced, and any comment should
 * describe the circuit that is actually below it.
 */

import { buildTrack, type Track, type TrackControlPoints } from "./track.ts";
import { SPA_FRANCORCHAMPS } from "./spaFrancorchamps.ts";
import { BAKU_CITY } from "./bakuCity.ts";
import { CHICANE as CHICANE_RING } from "./chicane.ts";

/**
 * A chicane circuit, authored as a radius profile with evenly spaced waypoints.
 *
 * Three genuinely slow corners and five straights long enough to overtake into. The
 * point of the layout is the direction changes: a driver still hard on the brakes while
 * turning in will lock a front and go straight through one, which is the failure the
 * tire model was built to produce.
 *
 * See `chicane.ts` for the profile and for why the waypoints are evenly spaced.
 */
const CHICANE_SPEC: TrackControlPoints = {
  halfWidth: 9,
  points: CHICANE_RING.map(([x, y]) => [x, y] as [number, number]),
};

/**
 * A club circuit, authored by hand, and the most varied layout in the set.
 *
 * FOUR separate overtaking zones: straights of 545 m, 580 m, 845 m and 650 m each
 * leading into a corner slow enough to attack. The slowest corner is 58 km/h, which is
 * what makes a braking zone rather than another medium-speed sweeper — braking later
 * into a 58 km/h corner gains real time and a lockup costs the whole following straight.
 *
 * MEASURED: 3521 m, 14 corners from 58 to 201 km/h, four slow and three fast, four
 * overtaking zones, and 29.9 m between the closest separate parts of the lap against
 * the 17 m the surfaces need.
 *
 * It got that way by fixing a specific fault. Every corner once sat between 65 and
 * 138 km/h: nothing fast enough to be frightening, nothing slow enough to demand heavy
 * braking, and therefore nowhere a pass could be made. The top sweep was opened out for
 * speed, a waypoint was added to break it into two corners, and the final apex pulled in
 * for braking.
 *
 * TREAT AS CONTENT, NOT SCAFFOLDING. Three attempts to "tidy" this layout produced
 * tracks that were straighter, slower and worse — one of which shipped by mistake, and
 * one of which creased the track because an edited waypoint was transcribed into the
 * wrong corner of the circuit. Change it by measuring the result, not by eye.
 */
const CLUB_SPEC: TrackControlPoints = {
  halfWidth: 8.5,
  points: [
    [-240, -170], [60, -170], [220, -160], [310, -120], [330, -50],
    [300, 10], [240, 35], [180, 20], [140, -30], [100, -85],
    [30, -120], [-70, -125], [-180, -95], [-270, -40], [-320, 40],
    [-358, 134], [-302, 213], [-190, 263], [-45, 274],
    // Added to break the long top-left sweeper into two corners. Purely additive: every
    // variant that tightened a corner instead lost an overtaking zone or a fast section.
    [186, 239],
    [224, 213], [314, 140], [370, 45], [360, -50],
    [380, -140], [420, -209], [200, -305], [40, -315], [-120, -305],
    [-230, -265],
  ],
};

/** A real circuit, traced from the Wikimedia Commons diagram of Spa-Francorchamps. */
const SPA_SPEC: TrackControlPoints = {
  halfWidth: 10,
  points: SPA_FRANCORCHAMPS.map(([x, y]) => [x, y] as [number, number]),
};

/** A real street circuit, traced from a Wikimedia Commons course-layout diagram. */
const BAKU_SPEC: TrackControlPoints = {
  halfWidth: 9,
  points: BAKU_CITY.map(([x, y]) => [x, y] as [number, number]),
};

export interface NamedTrack {
  /** Stable identifier, used by the viewer's selector and by tests. */
  key: string;
  /** Display name. */
  name: string;
  spec: TrackControlPoints;
}

export const CIRCUITS: ReadonlyArray<NamedTrack> = [
  { key: "spa", name: "Spa-Francorchamps", spec: SPA_SPEC },
  { key: "baku", name: "Baku City", spec: BAKU_SPEC },
  { key: "chicane", name: "Chicane", spec: CHICANE_SPEC },
  { key: "club", name: "Club Circuit", spec: CLUB_SPEC },
];

/** Builds one named circuit. */
const buildCircuit = (entry: NamedTrack): Track =>
  buildTrack(entry.spec, entry.name, entry.key);

/** Builds every circuit, in the order they are listed. */
export const buildCircuits = (): Track[] => CIRCUITS.map(buildCircuit);

/** Builds one circuit by key, or null if the key is not one of them. */
export const buildCircuitByKey = (key: string): Track | null => {
  const found = CIRCUITS.find((entry) => entry.key === key);
  return found ? buildCircuit(found) : null;
};

/** The circuit used by tests and by the first drivable build. */
export const DEFAULT_TRACK_KEY = "club";
