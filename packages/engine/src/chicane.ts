/**
 * The Chicane circuit.
 *
 * BUILT AS A CLOSED CURVE BY CONSTRUCTION, which is the point. Every attempt to build
 * a circuit from turn angles failed, and the reason is now clear: solving for the
 * straight lengths is ill-conditioned, so the solver "achieves" closure by making
 * straights hundreds of metres long or negative. It is the wrong parameterisation —
 * the closure problem only exists because the representation creates it.
 *
 * A circuit diagram is a RING OF WAYPOINTS joined by smooth curves, and a ring is
 * closed by definition. There is no closure equation, so there is nothing to solve and
 * nothing to go wrong. That is also why the hand-drawn circuits in this project looked
 * like circuits while the generated ones looked like polygons.
 *
 * The waypoints are given in polar form and then converted, because that is how the
 * shape is actually reasoned about:
 *
 *   - angular spacing controls how tight a corner is; bunched waypoints sharpen it
 *   - radius from the centre controls how far out that part of the lap reaches
 *   - a run of waypoints at nearly constant radius over a wide angle reads as a STRAIGHT,
 *     because the centre is far away relative to the span
 *
 * THE LAP: a very long main straight into heavy braking, two separate chicanes, a
 * bunched hairpin, a fast left sweeper, a second long run, and a technical right-left
 * to finish. Corners are deliberately spaced around the whole ring rather than
 * clustered, so the car is never doing the same thing twice in a row.
 *
 * MEASURED: 4552 m, 23 corners, zero self-crossings, and corner speeds from 50 to
 * 211 km/h — the widest spread in the set, which is what makes somewhere to overtake
 * and somewhere to be committed.
 */
export const CHICANE: ReadonlyArray<readonly [number, number]> = [
  [-450.0, -536.2], [-119.8, -679.5], [230.9, -634.3], [520.9, -437.1],
  [574.9, -232.3], [508.6, -108.1], [478.8, -33.5], [508.8, 35.6],
  [457.8, 97.3], [481.1, 175.1], [464.3, 313.1], [409.8, 424.4],
  [288.8, 462.2], [217.0, 444.9], [184.7, 507.4], [63.8, 606.7],
  [-89.8, 638.7], [-247.2, 611.9], [-357.9, 530.6], [-360.0, 429.0],
  [-359.7, 347.3], [-441.3, 344.8], [-542.8, 339.1], [-665.7, 216.3],
  [-728.2, 50.9], [-711.3, -204.0], [-606.2, -350.0], [-490.3, -411.4],
  [-385.7, -459.6], [-339.1, -542.8],
];
