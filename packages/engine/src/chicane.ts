/**
 * The Chicane circuit.
 *
 * Built as a CLOSED CURVE BY CONSTRUCTION. Every attempt to build a circuit from turn
 * angles failed, and the reason is worth stating because it cost a great deal of time:
 * solving for the straight lengths is ILL-CONDITIONED, so the solver "achieves"
 * closure by making straights hundreds of metres long or negative. It is the wrong
 * parameterisation. The closure problem only existed because the representation
 * created it.
 *
 * A circuit is a ring of waypoints joined by smooth curves, and a ring is closed by
 * definition — there is no equation to solve and nothing to go wrong. That is also why
 * the hand-drawn circuits here always looked like circuits while the generated ones
 * looked like polygons.
 *
 * SHAPED BY A RADIUS PROFILE, with the waypoints EVENLY spaced in angle. That second
 * part matters and was learned the hard way: an earlier ring bunched waypoints 6 to 12
 * degrees apart and changed radius sharply between them, and the spline through a
 * short, sharply-turning chord develops a far tighter radius than either endpoint — a
 * 13 m corner appeared in a section whose waypoint radii were all between 600 and
 * 700 m, which is why that version had a pinched final complex. With even spacing the
 * local curvature is set by how fast the radius changes with angle, which is a
 * quantity that can be controlled directly.
 *
 * The profile is a base ring plus harmonics:
 *
 *   620                     the average size of the lap
 *   + 160 cos(2t)           makes it an oval rather than a circle
 *   + 120 cos(3t + 0.6)     a long sector and a short one
 *   +  90 cos(4t + 1.4)     medium corners
 *   +  55 cos(6t + 3.3)     the hairpin
 *   +  70 cos(8t + 1.0)     a second tight section, the chicane proper
 *
 * Amplitude sets how tight a corner gets and phase sets where on the lap it sits, so
 * the whole layout is tunable without ever risking a self-intersection.
 *
 * MEASURED: 5445 m, 17 corners, zero self-crossings, corner speeds from 53 to
 * 206 km/h with three genuinely slow corners and five straights long enough to
 * overtake into — the widest spread in the set.
 */
export const CHICANE: ReadonlyArray<readonly [number, number]> = [
  [877.8, 0.0], [785.2, 68.7], [695.1, 122.6], [628.1, 168.3], [589.8, 214.7],
  [570.1, 265.8], [549.2, 317.1], [509.7, 356.9], [445.3, 373.7], [364.8, 364.8],
  [286.0, 340.9], [226.3, 323.2], [192.9, 334.2], [179.8, 385.5], [171.2, 470.3],
  [151.3, 564.6], [112.3, 637.0], [58.0, 662.6], [0.0, 635.2], [-49.8, 569.2],
  [-87.0, 493.2], [-116.9, 436.2], [-151.2, 415.4], [-200.1, 429.2], [-266.2, 461.0],
  [-342.2, 488.7], [-415.6, 495.3], [-476.1, 476.1], [-521.2, 437.3], [-557.1, 390.1],
  [-593.9, 342.9], [-637.6, 297.3], [-684.7, 249.2], [-723.0, 193.7], [-738.0, 130.1],
  [-721.8, 63.1], [-679.8, 0.0], [-629.5, -55.1], [-592.9, -104.6], [-585.4, -156.9],
  [-607.1, -221.0], [-642.2, -299.5], [-666.6, -384.9], [-658.9, -461.4], [-611.1, -512.8],
  [-531.6, -531.6], [-439.8, -524.2], [-356.2, -508.7], [-292.0, -505.7], [-245.8, -527.1],
  [-206.7, -567.8], [-162.7, -607.4], [-109.1, -618.9], [-51.0, -583.3], [-0.0, -499.7],
  [33.9, -387.7], [49.4, -280.0], [55.8, -208.4], [69.3, -190.5], [104.5, -224.0],
  [167.1, -289.5], [252.5, -360.7], [348.9, -415.8], [444.8, -444.8], [535.2, -449.1],
  [622.4, -435.8], [711.3, -410.7], [802.6, -374.3], [888.0, -323.2], [950.8, -254.8],
  [973.6, -171.7], [947.3, -82.9],
];
