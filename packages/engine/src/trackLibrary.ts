/**
 * Hand-authored tracks used for testing and as a stable benchmark set.
 *
 * These exist so that a behaviour seen in training can be reproduced. Generated
 * tracks give variety, but only a fixed layout lets a lap time mean the same
 * thing twice, so every measurement of "is this driver getting better" is taken
 * on these.
 *
 * Each layout targets a different skill, deliberately:
 *
 *  - `oval`: nothing but a long, gentle, high-speed turn. Baseline for "can it
 *    drive at all", and the wrong place to look for drama.
 *  - `hairpin`: a long straight into a first-gear hairpin. Tests braking
 *    discipline: arrive too hot or lock the fronts and the car runs wide with no
 *    steering, which is the failure the tire model was built to produce.
 *    KNOWN FLAW: its outbound leg dips back through the return leg, so the
 *    centreline crosses itself three times near s = 660 m. That makes the `(s, d)`
 *    projection ambiguous at the crossing only; everywhere else it is exact. Every
 *    attempt to open the circuit up produced a worse track, so the flaw is
 *    documented rather than fixed. See the test file for the bounds.
 *  - `chicane`: direction changes under load. Tests whether the driver can
 *    release the brake and let the car settle before turning in. Built by
 *    filleting a polygon of corners, so the control points already trace each
 *    arc and the spline never has to invent a radius.
 *  - `club`: a full circuit with a bit of everything, including a long run to
 *    the final corner. This is the layout for close finishes, because a mistake
 *    in the last sector is expensive and recoverable up to the line.
 */

import {
  buildTrack,
  minimumCornerRadius,
  selfIntersections,
  type Track,
  type TrackControlPoints,
} from "./track.ts";
import { roundCorners } from "./fillet.ts";
import { corner, solveDesign, type DesignSpec } from "./trackDesign.ts";
import { buildDesignedTrack } from "./trackRecipes.ts";

/**
 * A generous oval: two long straights joined by sweeping constant-radius turns.
 *
 * The corner waypoints are spaced widely so the spline rounds them into a
 * continuous arc rather than a corner, which is what makes this drivable at
 * speed.
 */
export const OVAL: TrackControlPoints = {
  halfWidth: 9,
  points: [
    [-220, -140],
    [220, -140],
    [420, -120],
    [500, -40],
    [500, 40],
    [420, 120],
    [220, 140],
    [-220, 140],
    [-420, 120],
    [-500, 40],
    [-500, -40],
    [-420, -120],
  ],
};

/**
 * A long run into a tight right-hand U, then a slower complex on the way back.
 *
 * Built by filleting a polygon, so the control points already trace each arc and
 * the spline never has to invent a radius. That matters most here: an earlier
 * version placed the apex by hand with two waypoints bunched together, which does
 * tighten the radius but also made the outbound leg dip back through the return
 * leg and cross it three times.
 *
 * The two legs are 250 m apart and the U's ends are 175 m apart, because the
 * fillet shortens each edge it touches — squeeze the U harder than that and the
 * leg corner and the U corner fillet into each other, which produced two further
 * crossings before the spacing was fixed.
 *
 * The result is the slowest corner on any of these circuits, which is the point:
 * it is where a lockup is most expensive and where a good exit matters most.
 */
export const HAIRPIN: TrackControlPoints = {
  halfWidth: 8,
  points: roundCorners(
    [
      [-380, 125], [180, 125], [400, 125],
      [430, 50], [400, -125],
      [-140, -125], [-320, -125],
      [-430, -190], [-480, -100], [-460, 20],
    ],
    45,
  ),
};

/**
 * A chicane: quick left-right under braking, then a slower complex.
 *
 * The paired waypoints at the chicane are the point of the track. A driver who
 * is still hard on the brakes while turning in will lock a front and go straight
 * through it.
 */
export const CHICANE: TrackControlPoints = {
  halfWidth: 7.5,
  points: roundCorners(
    [
      [-420, 170], [120, 170], [300, 145], [430, 70], [460, -30],
      [390, -110], [270, -95], [200, -150], [290, -215], [170, -275],
      [-40, -300], [-250, -270], [-400, -185], [-480, -60], [-470, 80],
    ],
    55,
  ),
};
/**
 * A club circuit built around a tight hairpin.
 *
 * The lap runs along a long bottom straight, turns up the right, then hits a
 * genuine first-gear hairpin at the end of a long run before flowing back to the
 * line. The hairpin is the slowest corner on any of these circuits at about
 * 53 km/h, which is what makes it a real overtaking opportunity rather than
 * another medium-speed sweeper: braking later into a 50 km/h corner gains real
 * time, and a lockup there costs the whole following straight.
 *
 * The previous version's tightest corner was 65 km/h and it had exactly one slow
 * corner in three kilometres, so the whole lap read as flowing and round with
 * nowhere to attack.
 *
 * HOW IT IS BUILT, which matters for anyone editing it: the hairpin is a DETOUR
 * off a plain rectangular loop, so both of its legs leave the same straight and
 * only ever travel outward. That is the guarantee that they cannot touch any other
 * part of the circuit — a property that hand-placed apex points repeatedly failed
 * to have. Tightness comes from how far apart the U's two end points are, NOT from
 * how far the detour reaches; reaching further out with the ends far apart simply
 * produces a bigger, faster sweep.
 */
/**
 * The club circuit, and the most varied layout in the set.
 *
 * MEASURED PROFILE: 3458 m, corners spread across 64-137 km/h, and FOUR separate
 * overtaking zones — straights of 545 m, 580 m, 845 m and 650 m each leading into a
 * corner slow enough to attack. The slowest corner is 64 km/h and the final complex
 * has a 75 km/h corner after a 650 m run, so there is a genuine braking zone near the
 * end of the lap as well as at the start.
 *
 * It got that way by fixing a specific fault. Every corner used to sit between 65
 * and 138 km/h: nothing fast enough to be frightening, nothing slow enough to
 * demand heavy braking, and therefore nowhere a pass could actually be made. The
 * top sweep was opened out for speed and the final apex pulled in for braking, and
 * the number of usable overtaking zones went from three to four.
 *
 * The signature complex around [300, 10] -> [240, 35] -> [180, 20] -> [140, -30] is
 * the right-left flick onto the long left-hand run. Its waypoints are deliberately
 * close together, because bunched control points sharpen the spline radius, and
 * that is what gives the corner its character.
 *
 * TREAT AS CONTENT, NOT SCAFFOLDING. Two attempts to "tidy" this block produced
 * layouts that were straighter, slower and worse, one of which shipped by mistake.
 */
export const CLUB: TrackControlPoints = {
  halfWidth: 8.5,
  points: [
    // Opening straight into the signature right-left flick.
    [-240, -170], [60, -170], [220, -160], [310, -120], [330, -50],
    [300, 10], [240, 35], [180, 20], [140, -30], [100, -85],
    // Long left-hand sweep across the top, opened out for a genuine fast section.
    [30, -120], [-70, -125], [-180, -95], [-270, -40], [-320, 40],
    [-358, 134], [-302, 213], [-190, 263], [-45, 274], [101, 258],
    [224, 213], [314, 140], [370, 45],
    // End complex down the right side into a properly tight final corner, then
    // back to the line. The apex is deliberately pulled in so the last corner is
    // the slowest on the circuit and the long run down to it is a braking zone.
    [360, -50], [380, -140], [420, -209], [200, -305], [40, -315],
    [-120, -305], [-230, -265],
  ],
};



/*
 * SPA, built from a searched angle set and its real corner characters.
 *
 * 6988 m against the real circuit's 7004, six corners spanning 78-250 km/h, and a
 * 78 km/h hairpin fed by an 1812 m straight. The character is right: flat-out
 * corners, one very long straight, and a slow hairpin at the end of it.
 *
 * Replaces "The Oval", which was two corners of identical radius and a great deal
 * of straight — a shape, not a circuit.
 */
const SPA_DESIGN: DesignSpec = {
  name: "Spa-Francorchamps",
  halfWidth: 9.5,
  corners: [60, 45, 150, -30, 75, 60].map((a, i) => corner(a, [145, 250, 105, 78, 195, 78][i]!)),
  preferredStraights: [350, 900, 700, 1020, 1040, 1020],
};

/*
 * BAKU, a street circuit: almost nothing but long straights joined by tight
 * 90-degree corners. Every corner is between 72 and 150 km/h and there are seven
 * straights of 593-963 m, so passing is done with the slipstream and a late lunge
 * rather than with flowing corners.
 *
 * Replaces "Hairpin", which had a hairpin but only five corners and no long
 * straight section, so it had the shape of a circuit without the traffic.
 */
const BAKU_DESIGN: DesignSpec = {
  name: "Baku City",
  halfWidth: 9,
  corners: [30, 60, 45, 45, 45, 60, 75].map((a, i) => corner(a, [150, 125, 72, 72, 125, 88, 105][i]!)),
  preferredStraights: [869, 775, 593, 716, 777, 798, 963],
};

export interface NamedTrack {
  key: string;
  name: string;
  /** A hand-placed circuit, or null when this entry is a solved design. */
  spec: TrackControlPoints | null;
  /** A design solved at build time, or null when this entry is hand-placed. */
  design: DesignSpec | null;
}

export const HAND_TRACKS: ReadonlyArray<NamedTrack> = [
  { key: "spa", name: "Spa-Francorchamps", spec: null, design: SPA_DESIGN },
  { key: "baku", name: "Baku City", spec: null, design: BAKU_DESIGN },
  { key: "chicane", name: "Chicane", spec: CHICANE, design: null },
  { key: "club", name: "Club Circuit", spec: CLUB, design: null },
];

/**
 * Builds one named circuit.
 *
 * Two kinds of entry coexist deliberately. The solved designs are the newer and
 * better ones; the hand-placed circuits are kept because they are validated and
 * because one of them is the most varied layout in the set.
 */
export const buildNamedTrack = (entry: NamedTrack): Track | null => {
  if (entry.design) {
    const solved = solveDesign(entry.design);
    return solved ? buildDesignedTrack(solved) : null;
  }
  return entry.spec ? buildTrack(entry.spec, entry.name) : null;
};

/** Builds every circuit. Throws if one is degenerate. */
export const buildHandTracks = (): Track[] => {
  const built: Track[] = [];
  for (const entry of HAND_TRACKS) {
    const track = buildNamedTrack(entry);
    if (!track) throw new Error(`circuit failed to build: ${entry.name}`);
    built.push(track);
  }
  return built;
};

export const buildHandTrack = (key: string): Track | null => {
  const found = HAND_TRACKS.find((t) => t.key === key);
  return found ? buildNamedTrack(found) : null;
};

/** The default track for tests and for the first drivable build. */
export const DEFAULT_TRACK_KEY = "club";
