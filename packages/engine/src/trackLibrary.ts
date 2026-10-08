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
 * A club circuit with a bit of everything, finishing with a hairpin.
 *
 * The complex around [300, 10] -> [240, 35] -> [180, 20] -> [140, -30] is the
 * signature of the lap: a right-left flick onto the long left-hand sweep that runs
 * up and across the top. The waypoints there are deliberately close together,
 * because bunched control points sharpen the spline radius, and that is what gives
 * the corner its character.
 *
 * The lap then ends with a long run down the right side into a tight hairpin and a
 * straight back to the line, which is what puts the lap's decisive corner adjacent
 * to the finish.
 *
 * THE PREVIOUS VERSION HAD TWO LONG STRAIGHTS AT y = -170 AND y = -180. They were
 * 10 m apart while each carried a half-width of 8.5 m, so the two surfaces
 * genuinely overlapped along their whole length and the track read as a single
 * fat ribbon rather than two legs. Measured closest approach was 4.9 m against the
 * 17 m required to stay clear. The hairpin fixes it by separating the legs by the
 * diameter of the turn, which is also what makes the turn geometrically possible.
 *
 * TREAT THIS BLOCK AS CONTENT, NOT SCAFFOLDING. Attempts to "tidy" it produced a
 * circuit that was straighter, slower and considerably less interesting.
 *
 * The last two waypoints open onto a long straight that starts almost at the
 * start/finish line. That is deliberate: it means a mistake in the final complex
 * costs you the drag to the flag, which is where close finishes come from.
 */
export const CLUB: TrackControlPoints = {
  halfWidth: 8.5,
  points: [
    // Opening straight, then the signature right-left flick.
    [-240, -170], [60, -170], [220, -160], [310, -120], [330, -50],
    [300, 10], [240, 35], [180, 20], [140, -30], [100, -85],
    // Long left-hand sweep up and across the top of the circuit.
    [30, -120], [-70, -125], [-180, -95], [-270, -40], [-320, 40],
    [-320, 120], [-270, 190], [-170, 235], [-40, 245], [90, 230],
    [200, 190], [280, 125], [330, 40],
    // Final complex: a long run down into a tight hairpin, then back to the line.
    [360, -50], [380, -140], [330, -230], [200, -280], [40, -290],
    [-120, -280], [-230, -240],
  ],
};

export interface NamedTrack {
  key: string;
  name: string;
  spec: TrackControlPoints;
}

export const HAND_TRACKS: ReadonlyArray<NamedTrack> = [
  { key: "oval", name: "The Oval", spec: OVAL },
  { key: "hairpin", name: "Hairpin", spec: HAIRPIN },
  { key: "chicane", name: "Chicane", spec: CHICANE },
  { key: "club", name: "Club Circuit", spec: CLUB },
];

/** Builds every hand-authored track. Throws if one is degenerate. */
export const buildHandTracks = (): Track[] =>
  HAND_TRACKS.map(({ name, spec }) => buildTrack(spec, name));

export const buildHandTrack = (key: string): Track | null => {
  const found = HAND_TRACKS.find((t) => t.key === key);
  return found ? buildTrack(found.spec, found.name) : null;
};

/** The default track for tests and for the first drivable build. */
export const DEFAULT_TRACK_KEY = "club";
