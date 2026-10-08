/**
 * Inserts a circular-arc fillet at each interior corner of a polygon, so the
 * control points already describe the arc rather than leaving the spline to invent
 * a radius. Also fillets the closing corner between the last and first point.
 *
 * This exists because placing apex points by hand is unreliable: it produced two
 * layouts whose legs doubled back through each other. Filleting an ordinary
 * polygon of corners gives every turn a radius by construction, and the radius is
 * then a single number to tune.
 *
 * Uses `len` rather than `Math.hypot`, because track geometry is built inside the
 * deterministic core and `hypot` is not bit-identical across engines.
 */

import { len } from "./math2d.ts";
export const roundCorners = (
  polygon: Array<[number, number]>,
  radius: number,
  segments = 4,
): Array<[number, number]> => {
  const n = polygon.length;
  const out: Array<[number, number]> = [];
  const lerp = (a: [number, number], b: [number, number], t: number): [number, number] =>
    [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];

  for (let i = 0; i < n; i++) {
    const prev = polygon[(i - 1 + n) % n]!;
    const cur = polygon[i]!;
    const next = polygon[(i + 1) % n]!;

    const dPrev = len(cur[0] - prev[0], cur[1] - prev[1]);
    const dNext = len(next[0] - cur[0], next[1] - cur[1]);
    // Never eat more than 40% of either edge.
    const t = Math.min(radius / Math.max(dPrev, 1e-6), radius / Math.max(dNext, 1e-6), 0.4);
    if (t <= 0) { out.push(cur); continue; }

    const start = lerp(cur, prev, t);
    const end = lerp(cur, next, t);

    // No arc needed if the corner is essentially straight.
    const cross = (cur[0] - prev[0]) * (next[1] - cur[1]) - (cur[1] - prev[1]) * (next[0] - cur[0]);
    if (Math.abs(cross) < 1e-9) { out.push(cur); continue; }

    for (let k = 0; k <= segments; k++) {
      const s = k / segments;
      // Quadratic Bezier through the two tangent points: a smooth fillet.
      const p = lerp(lerp(start, cur, s), lerp(cur, end, s), s);
      out.push([Math.round(p[0] * 100) / 100, Math.round(p[1] * 100) / 100]);
    }
  }
  return out;
};
