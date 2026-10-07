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
 *  - `chicane`: direction changes under load. Tests whether the driver can
 *    release the brake and let the car settle before turning in.
 *  - `club`: a full circuit with a bit of everything, including a long run to
 *    the final corner. This is the layout for close finishes, because a mistake
 *    in the last sector is expensive and recoverable up to the line.
 */

import { buildTrack, type Track, type TrackControlPoints } from "./track.ts";

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
 * A long straight into a tight hairpin, then a return leg.
 *
 * The hairpin apex is described by two waypoints placed close together near the
 * bottom of the loop, which is what tightens the spline radius to roughly 20 m —
 * slow enough that the car is in first gear and traction-limited on exit.
 */
export const HAIRPIN: TrackControlPoints = {
  halfWidth: 8,
  points: [
    [-260, -180],
    [120, -180],
    [260, -170],
    [300, -120],
    [290, -60],
    [250, -30],
    [200, -25],
    [150, -45],
    [120, -90],
    [90, -130],
    [30, -150],
    [-60, -150],
    [-180, -120],
    [-280, -60],
    [-330, 20],
    [-300, 110],
    [-220, 165],
    [-80, 185],
    [80, 185],
    [220, 160],
    [300, 90],
    [310, 10],
    [280, -60],
    [240, -110],
    [160, -140],
    [-40, -150],
  ],
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
  points: [
    [-250, -150],
    [100, -150],
    [200, -130],
    [230, -80],
    [200, -30],
    [140, -10],
    [90, -30],
    [70, -80],
    [40, -120],
    [-30, -140],
    [-120, -120],
    [-190, -70],
    [-240, 0],
    [-250, 80],
    [-200, 150],
    [-110, 190],
    [0, 200],
    [130, 190],
    [230, 150],
    [290, 80],
    [300, -10],
    [270, -90],
    [210, -140],
    [120, -155],
    [-60, -155],
  ],
};

/**
 * A club circuit with a bit of everything, including a long run to the line.
 *
 * The last two waypoints open onto a long straight that starts almost at the
 * start/finish line. That is deliberate: it means a mistake in the final complex
 * costs you the drag to the flag, which is where close finishes come from.
 */
export const CLUB: TrackControlPoints = {
  halfWidth: 8.5,
  points: [
    [-240, -170],
    [160, -170],
    [280, -150],
    [330, -90],
    [320, -20],
    [270, 25],
    [210, 35],
    [160, 10],
    [140, -45],
    [110, -95],
    [50, -125],
    [-40, -135],
    [-150, -110],
    [-240, -60],
    [-300, 20],
    [-320, 100],
    [-280, 170],
    [-180, 210],
    [-40, 220],
    [100, 205],
    [210, 165],
    [290, 100],
    [350, 20],
    [400, -70],
    [390, -140],
    [300, -175],
    [140, -180],
    [-80, -180],
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
