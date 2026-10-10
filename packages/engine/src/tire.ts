/**
 * Combined-slip tire model on a friction circle.
 *
 * Two properties matter more than realism here, because the learned behaviour
 * of the drivers depends on them:
 *
 *  1. Longitudinal force RISES to a peak at moderate slip and then FALLS as
 *     slip grows. Past the peak, locking a wheel lengthens braking distance
 *     rather than shortening it. A driver therefore has to brake near the
 *     limit, not simply apply maximum pressure.
 *
 *  2. Longitudinal and lateral demand share ONE friction budget per tire. As
 *     slip ratio grows, the longitudinal channel consumes the circle and the
 *     lateral channel is starved. At full lock the tire still resists sliding
 *     longitudinally (kinetic friction, no longer static) but produces almost
 *     no lateral force — so the car continues straight regardless of steering.
 *     This is the emergent "locked fronts go straight" behaviour and it is not
 *     scripted anywhere in this file.
 *
 * Which axle locks first is likewise emergent, driven by longitudinal load
 * transfer in `axleNormalLoads`.
 */

import { saturate, safeDiv } from "./math2d.ts";

export interface TireParams {
  /** Peak longitudinal friction coefficient (static, at the slip peak). */
  muX: number;
  /** Anisotropy of the lateral peak relative to the longitudinal peak, 0..1. */
  muY: number;
  /**
   * Longitudinal slip ratio at which force peaks. Realistic racing slicks sit
   * well below 0.2; a locked wheel sits at -1.0, far past the peak.
   */
  slipRatioPeak: number;
  /** Lateral slip angle at which force peaks, in radians. */
  slipAnglePeak: number;
  /** Offset of the contact patch behind the wheel centre, as a fraction of wheel radius. */
  pneumaticTrail: number;
  /** Load sensitivity: mu scales as 1 - loadSensitivity * (Fz / FzRef - 1). */
  loadSensitivity: number;
  /** Reference normal load for load sensitivity, in newtons. */
  loadRef: number;
}

/**
 * Anisotropy: how much cornering force the tire makes at its lateral peak,
 * relative to the combined budget. Slicks are close to isotropic, so this is
 * just under 1. Applied to the lateral force OUTPUT, never to the slip input —
 * scaling the input would push lateral slip past its own peak and distort the
 * shape of the curve.
 */
const TIRE_ANISOTROPY = 0.98;

export const DEFAULT_TIRE: TireParams = {
  muX: 1.55,
  muY: TIRE_ANISOTROPY,
  slipRatioPeak: 0.11,
  slipAnglePeak: 0.11,
  /**
   * Distance the contact patch's centre of pressure sits behind the wheel centre, as a fraction of the
   * wheel's radius.
   *
   * MEASURED RATHER THAN QUOTED, because the value decides whether the car has a limit or a cliff. Swept
   * at a held 120 km/h with more steering asked for than the tires can supply:
   *
   *   trail 0.12   still spins: 178 degrees of slip, and the car ends up travelling backwards
   *   trail 0.20   marginal: 62 degrees of slip, 23 km/h left
   *   trail 0.30   3 degrees of slip, 63 km/h retained, yaw rate returns to a steady turn
   *
   * A physical racing tire's trail is around a quarter of its radius, so 0.30 is at the upper end of
   * plausible rather than beyond it. It is set at the value that makes the car recoverable because that
   * is the behaviour a real car has, and the number is recorded so it can be argued with.
   */
  pneumaticTrail: 0.3,
  loadSensitivity: 0.09,
  loadRef: 4000,
};

/**
 * Slip ratio.
 *
 *   +1 : wheel spinning at twice road speed (wheelspin)
 *    0 : rolling freely
 *   -1 : wheel fully locked, sliding (omega == 0)
 *
 * Sign convention: positive means the tire is driving the car forward.
 */
export const slipRatio = (wheelSpeed: number, groundSpeed: number): number =>
  safeDiv(wheelSpeed - groundSpeed, Math.abs(groundSpeed), 1.0);

/**
 * Grip multiplier from load sensitivity: a heavily loaded tire has
 * proportionally less grip, so `mu_effective = mu * loadScale(Fz)`.
 */
const tireLoadScale = (Fz: number, p: TireParams = DEFAULT_TIRE): number => {
  const loadScale = 1 - p.loadSensitivity * (Fz / p.loadRef - 1);
  const clamped = loadScale > 0.25 ? loadScale : 0.25;
  return clamped;
};

/**
 * The friction budget: the largest resultant force this tire can produce, in
 * newtons, for a given normal load and surface. This is the radius of the
 * friction circle that `tireForces` clamps against.
 *
 * Exported so tests and telemetry can assert against the same radius the sim
 * uses, rather than re-deriving `mu * Fz` and silently disagreeing about load
 * sensitivity.
 */
export const tireBudget = (
  Fz: number,
  muLoad = 1,
  p: TireParams = DEFAULT_TIRE,
): number => p.muX * (Fz > 0 ? Fz : 0) * tireLoadScale(Fz, p) * muLoad;

export interface TireForce {
  fx: number;
  fy: number;
  /**
   * Lateral force equivalent of the tire's self-aligning torque, in newtons.
   *
   * The real quantity is a MOMENT about the wheel's vertical axis, which always acts to reduce the slip
   * angle. It is returned as an equivalent force because the caller already sums lateral forces against
   * moment arms; multiplying by the trail length converts it back, and keeping one representation avoids
   * a second place for the geometry to be got wrong.
   */
  aligningForce: number;
  /** Realized friction as a fraction of available mu*Fz, for telemetry/overlays. */
  utilization: number;
  locked: boolean;
}

/**
 * The slip magnitude at which grip peaks, for EITHER channel.
 *
 * This is the single most confusing quantity in the file, so it is worth being
 * explicit. Slip ratio and slip angle have wildly different natural scales: a
 * longitudinal peak at 0.11 and a lateral peak at a velocity ratio of about 1.4
 * differ by a factor of roughly 12.7. Normalizing each channel by its OWN peak
 * would put their peaks at the same normalized coordinate, which sounds tidy and
 * is wrong — it makes the two channels' peaks collide at a single point and
 * wrecks the falloff.
 *
 * Instead each channel is normalized by the OTHER channel's peak scale, so that
 *
 *     |slip| = |atan2(slipAngle, slipRatio)|   (the resultant slip direction)
 *
 * falls out naturally, and ONE slip magnitude `tau` is the shared peak. That is
 * what makes `demand(TAU) == 1` the correct condition for either channel alone:
 * pure longitudinal slip of 0.11 and pure lateral slip of a 1.4 velocity ratio
 * both sit at `tau` and both produce full grip.
 *
 * Equal to `1 / slipRatioPeak`. With the default tire that is 9.0909.
 */
/**
 * Force available at full lock, as a fraction of the peak.
 *
 * THIS IS A DESIGN PARAMETER, not a measured constant, and it is one of the most
 * important numbers in the whole simulation.
 *
 * Published tire curves sit near 0.86, and an earlier version used that. In the
 * complete car that value made locking the brakes STRICTLY OPTIMAL: a locked
 * wheel holds a steady 0.86, while any modulating controller necessarily spends
 * some time at low slip where it makes almost no force. Measured over a full stop
 * from 100 km/h the locked car stopped 21% SHORTER, so the simulation was
 * rewarding a pedal slam.
 *
 * At 0.70 sliding is a genuine and large mistake, which is what the racing needs:
 * drivers must learn to brake at the limit, and lifting mid-corner to stop a
 * slide has to cost measurable lap time.
 *
 * The value is deliberately harsher than a real slick. That is a knowing trade of
 * literal realism for behaviour that makes the sim worth watching, and it is
 * pinned by test so it cannot drift.
 */
const LOCKED_FORCE_FRACTION = 0.7;

/**
 * The demand curve, defined by ANCHOR POINTS rather than by a fitted formula.
 *
 * This replaced several attempted closed forms, all of which failed the same
 * way. A saturating rise followed by a `1/(1 + k*(q-1)^p)` tail gives a monotone
 * slope past the peak, but real tire curves PLATEAU: grip falls quickly and then
 * barely moves out to full lock. No choice of `k` or `p` reproduces that, because
 * that is not the shape of a smooth falloff.
 *
 * Anchors are `(slip in multiples of the shared peak tau, fraction of budget)`.
 * The final anchor is `LOCKED_FORCE_FRACTION`, and the knots between the peak and
 * it are spaced so the falloff is steep enough to make overslip expensive without
 * making the car impossible to drive at the limit.
 *
 * Every anchor is <= 1 and the knot at q == 1 IS the peak, so the curve comes out
 * normalized by construction. That is what lets the friction circle hold with no
 * clamp anywhere, and a clamp would cancel the fold-back entirely.
 */
const DEMAND_ANCHORS: ReadonlyArray<readonly [number, number]> = [
  [0, 0],
  [0.25, 0.42],
  [0.5, 0.68],
  [0.75, 0.88],
  [1, 1], // the peak
  [1.25, 0.93],
  [1.5, 0.87],
  [2, 0.81],
  [2.5, 0.765],
  [3, 0.745],
  [4, 0.725],
  [5, 0.715],
  [6, 0.708],
  [8, 0.703],
  [16, LOCKED_FORCE_FRACTION],
];

/** Upper bound of the table, in multiples of the shared slip peak `tau`. */
const DEMAND_MAX_SLIP = DEMAND_ANCHORS[DEMAND_ANCHORS.length - 1]![0];

/**
 * Table resolution. Chosen so linear interpolation between samples deviates from
 * the anchor polyline by well under a percent, keeping the curve smooth as well
 * as accurate.
 */
const DEMAND_STEPS = 4096;

/**
 * The demand curve, baked from the anchors.
 *
 * Baking means the hot path is a single index and a lerp, with no search for the
 * bracketing knot, and it keeps the whole thing inside the determinism contract.
 */
const DEMAND_TABLE = ((): Float64Array => {
  const table = new Float64Array(DEMAND_STEPS + 1);
  let knot = 0;
  for (let i = 0; i <= DEMAND_STEPS; i++) {
    const q = (i / DEMAND_STEPS) * DEMAND_MAX_SLIP;
    // Anchors ascend, so this is a single forward pass over the whole bake.
    while (knot < DEMAND_ANCHORS.length - 2 && q > DEMAND_ANCHORS[knot + 1]![0]) {
      knot++;
    }
    const [q0, v0] = DEMAND_ANCHORS[knot]!;
    const [q1, v1] = DEMAND_ANCHORS[knot + 1]!;
    const span = q1 - q0;
    const raw = span <= 0 ? 0 : (q - q0) / span;
    const t = raw < 0 ? 0 : raw > 1 ? 1 : raw;
    table[i] = v0 + (v1 - v0) * t;
  }
  return table;
})();

/**
 * Share of the friction budget available at a given slip magnitude, measured in
 * units of the shared peak `tau`, which is 1.
 *
 * Bounded by 1 for every input, equal to 1 at `q == 1`, and settling near 0.85
 * at full lock.
 */
export const demand = (slipMagnitude: number): number => {
  const q = slipMagnitude < 0 ? -slipMagnitude : slipMagnitude;
  if (q <= 0) return 0;
  if (q >= DEMAND_MAX_SLIP) return DEMAND_TABLE[DEMAND_STEPS]!;
  const position = (q / DEMAND_MAX_SLIP) * DEMAND_STEPS;
  const index = position | 0;
  const fraction = position - index;
  const lo = DEMAND_TABLE[index]!;
  const hi = DEMAND_TABLE[index + 1]!;
  return lo + (hi - lo) * fraction;
};

/**
 * Combined slip → tire force, resolved in the tire's own frame.
 *
 * Composition happens in FORCE space, not slip space, and the friction circle
 * is enforced as a hard geometric constraint:
 *
 *   1. Each channel asks for a force, using its own normalized demand curve.
 *   2. The vector sum of those demands is compared against mu*Fz.
 *   3. If the demand exceeds the circle, BOTH channels are scaled down by the
 *      same factor, preserving direction — the force points opposite the actual
 *      slide velocity.
 *
 * Step 3 is the whole mechanism behind "locked fronts make you go straight".
 * Once the braking demand eats the circle, the lateral channel is scaled down
 * with it, so a locked tire can no longer generate cornering force no matter
 * what the driver does with the steering wheel. Nothing here special-cases
 * lockup; it is a consequence of the budget being shared.
 *
 * @param Fz          normal load on this tire [N]
 * @param slipRatioVal longitudinal slip, -1..+1 in practice
 * @param slipAngle   lateral slip angle [rad]
 * @param muLoad      surface grip multiplier (asphalt 1.0, kerb 0.88, ...)
 * @param p           tire parameters
 * @param wheelOmega  wheel angular velocity, used only to report `locked`
 */
export const tireForces = (
  Fz: number,
  slipRatioVal: number,
  slipAngle: number,
  muLoad: number,
  p: TireParams = DEFAULT_TIRE,
  wheelOmega = 1,
): TireForce => {
  const FzClamped = Fz > 0 ? Fz : 0;
  if (FzClamped < 1e-6) {
    return { fx: 0, fy: 0, aligningForce: 0, utilization: 0, locked: false };
  }

  // Load sensitivity: a heavily loaded tire has proportionally less grip.
  const gripScale = tireLoadScale(FzClamped, p) * muLoad;

  /**
   * THE friction budget: the largest resultant force this tire can produce, in
   * newtons. Every direction shares it. There is exactly one circle, so both
   * channels are measured against the same radius and the clamp is exact.
   */
  const budget = p.muX * FzClamped * gripScale;

  // Step 1: each channel's slip, normalized by ITS OWN peak. `sx == 1` means
  // that channel is at its peak; larger means past it.
  /**
   * Both channels normalized by the SAME scale, so their contributions are
   * comparable and the resultant slip direction falls out without any
   * trigonometry.
   *
   * Dividing both by `slipAnglePeak` is equivalent to dividing one by
   * `slipRatioPeak` and then rescaling by a constant, and it puts the slip magnitude
   * in units where 1.0 is the shared peak for either channel alone — which is why
   * `demand(1)` is the condition for full grip.
   */
  const sx = slipRatioVal / p.slipAnglePeak;
  const sy = slipAngle / p.slipAnglePeak;

  /**
   * MAGNITUDE and DIRECTION are computed separately, and this split is the whole
   * reason the model is well behaved.
   *
   * The tempting formulation — drive each channel through its own fold-back curve
   * and scale the pair into the circle — does not work, and fails in a way that is
   * easy to miss. A fold-back tail decays slower than `1/s`, so the product
   * `s * curve(s)` GROWS without bound as slip grows. Scaling that demand vector
   * into the circle then exactly cancels the fold-back, and a fully locked wheel
   * ends up producing the same braking force as a perfectly threshold-braked one.
   * The simulation would reward locking up.
   *
   * Splitting the two fixes it properly:
   *
   *   magnitude = budget * demand(|slip|)   -> bounded, folds back past the peak
   *   direction = unit vector of slip       -> carries where the force points
   *
   * so the fold-back acts on a scalar where it cannot be cancelled, and the
   * resultant is inside the circle by construction with no clamp anywhere.
   */
  const slipMagnitude = Math.sqrt(sx * sx + sy * sy);
  const saturation = saturate(slipMagnitude);

  /**
   * Scalar force magnitude, as a fraction of the friction budget.
   *
   * Exactly ONE bounded factor governs the magnitude, so the resultant can never
   * leave the circle and NO CLAMP IS NEEDED. That matters: an explicit
   * `min(magnitude, budget)` looks harmless but silently cancels the fold-back at
   * high slip, making a fully locked wheel brake exactly as well as a perfectly
   * modulated one — the simulation would then reward locking up.
   *
   * `demand` is bounded by 1 and decreasing past the combined slip peak, which is
   * the whole reason the fold-back survives.
   */
  const forceMagnitude = budget * demand(slipMagnitude);

  /**
   * Direction of the force as a unit vector, so the resultant stays inside the
   * circle. Because `muY <= 1`, `|(dirX, muY * dirY)| <= 1` whenever
   * `dirX^2 + dirY^2 == 1`, which is exactly the guarantee required. Applying
   * anisotropy to the direction rather than the magnitude is what makes that
   * bound hold.
   */
  const safeMagnitude = slipMagnitude < 1e-12 ? 1 : slipMagnitude;
  const dirX = slipMagnitude < 1e-12 ? 0 : sx / safeMagnitude;
  const dirY = slipMagnitude < 1e-12 ? 0 : sy / safeMagnitude;

  const locked = wheelOmega <= 1e-3 && (slipRatioVal > 0.9 || slipRatioVal < -0.9);

  /*
   * SELF-ALIGNING TORQUE, which this model did not have and which is why the car spun where a real one
   * would not.
   *
   * A tire's contact patch sits BEHIND the wheel centre, so the lateral force it generates acts about a
   * point offset from where the wheel points. The moment that produces always acts to reduce the slip
   * angle — it is the force that straightens a rolling tire and the force a driver feels through the
   * wheel as the limit approaches. Without it there is nothing pulling a sliding car back into line, so
   * a car that loses the rear simply keeps rotating: measured, a car asked for too much lock at 120 km/h
   * went from 119 km/h to 8 in one and a third seconds with its yaw rate still CLIMBING, and nothing in
   * the model opposed it.
   *
   * Returned as an EQUIVALENT LATERAL FORCE so the caller can add it to the same moment sum as
   * everything else. The conversion is the trail length, which is the offset it acts over.
   *
   * It saturates with the tire, because the trail shortens as the contact patch slides — so this adds
   * stability at the limit without making a sliding tire magically recover grip it does not have.
   */
  const lateralForce = -forceMagnitude * p.muY * dirY;
  const aligningForce =
    slipAngle === 0 ? 0 : -lateralForce * p.pneumaticTrail * (Math.abs(slipAngle) / (Math.abs(slipAngle) + 0.15));

  return {
    fx: forceMagnitude * dirX,
    fy: lateralForce,
    aligningForce,
    // Utilization of the friction budget, 0..1. Reaches 1.0 as the tire
    // saturates. Note it stays near 1.0 under a fold-back too: a sliding tire
    // still spends its whole friction budget, just in a direction the driver
    // does not want. Use `locked` and the force signs to distinguish states.
    utilization: saturation,
    locked,
  };
};

export interface AxleNormalLoads {
  /** Total load on the front axle [N]. */
  front: number;
  /** Total load on the rear axle [N]. */
  rear: number;
}

export interface WheelNormalLoads {
  /** Load on the front-left, front-right, rear-left and rear-right wheels [N]. */
  fl: number;
  fr: number;
  rl: number;
  rr: number;
}

/**
 * Normal load at each wheel, from static weight, aerodynamic downforce and weight
 * transfer in BOTH axes.
 *
 * THE SINGLE SOURCE OF TRUTH FOR LOAD TRANSFER. There used to be two: this file's
 * longitudinal model, which the tests exercised, and a separate one inside `car.ts`
 * that also handled the lateral axis. They agreed by luck rather than by design, and
 * any change to one silently left the other behind. The lateral case is folded in here
 * instead.
 *
 * WHY IT MATTERS THAT THE SIGNS ARE RIGHT. `longAccel` is NEGATIVE under braking, and
 * the resulting pitch moment transfers load off the rear axle and onto the front. The
 * front tires therefore run closer to their friction limit, so under hard braking THE
 * FRONTS LOCK FIRST unless the brake bias is moved rearward. That is what makes the
 * classic "locked fronts, car goes straight" failure the default one, and it falls out
 * of these equations rather than being hardcoded anywhere.
 *
 * Lateral transfer unloads the inside wheels in a corner, which is where asymmetric
 * tire wear and inside-wheel lockup come from. Positive `latAccel` means accelerating
 * toward body +y, which is LEFT, so it loads the left wheels of each pair.
 *
 * @param longAccel  longitudinal acceleration [m/s^2], negative under braking
 * @param latAccel   lateral acceleration [m/s^2] in the body frame, positive toward +y
 * @param trackFront front track width [m]
 * @param trackRear  rear track width [m]
 * @param cgHeight   centre-of-gravity height [m]
 * @param aeroDownforce total downforce [N], split by static weight distribution
 */
export const wheelNormalLoads = (
  mass: number,
  g: number,
  weightDistFront: number,
  wheelbase: number,
  cgHeight: number,
  longAccel: number,
  latAccel = 0,
  trackFront = 1.6,
  trackRear = 1.55,
  aeroDownforce = 0,
): WheelNormalLoads => {
  const totalWeight = mass * g;

  /*
   * Longitudinal transfer is capped at half the car's weight.
   *
   * Unbounded, a collision spike in the acceleration estimate hands one axle an
   * absurd load and with it an absurd amount of grip. The cap keeps the model sane
   * without affecting anything reachable by driving, since it takes more than 1 g of
   * measured acceleration on this wheelbase to approach it.
   */
  const maxTransfer = totalWeight * 0.5;
  const longTransfer = clampAbs((mass * longAccel * cgHeight) / wheelbase, maxTransfer);

  const aeroFront = aeroDownforce * weightDistFront;
  const aeroRear = aeroDownforce * (1 - weightDistFront);

  const frontAxle = Math.max(0, totalWeight * weightDistFront - longTransfer + aeroFront);
  const rearAxle = Math.max(0, totalWeight * (1 - weightDistFront) + longTransfer + aeroRear);

  /*
   * Lateral transfer, per axle.
   *
   * CAPPED AT HALF THE AXLE LOAD, and the cap is not cosmetic. Applying the transfer
   * and then clamping the inner wheel at zero DESTROYS load rather than moving it: in a
   * 3 g corner the inner front would go to -440 N, clamping to 0, and the two axles
   * together then carried 8389 N instead of the car's 7828 N of weight. The car gained
   * 560 N of grip out of nothing exactly when it was working hardest, which is the
   * worst possible place for an error like that.
   *
   * At the cap the inner wheel is at zero — a genuinely lifted wheel, which is a real
   * thing in a fast corner — and the outer wheel carries the whole axle. Nothing is
   * created and nothing is lost.
   */
  const frontTransfer = clampAbs(((mass * latAccel * cgHeight) / trackFront) * 0.5, frontAxle * 0.5);
  const rearTransfer = clampAbs(((mass * latAccel * cgHeight) / trackRear) * 0.5, rearAxle * 0.5);

  const frontHalf = frontAxle * 0.5;
  const rearHalf = rearAxle * 0.5;

  return {
    fl: frontHalf + frontTransfer,
    fr: frontHalf - frontTransfer,
    rl: rearHalf + rearTransfer,
    rr: rearHalf - rearTransfer,
  };
};

/** Axle totals from `wheelNormalLoads`, for callers that reason per axle. */
export const axleNormalLoads = (
  mass: number,
  g: number,
  weightDistFront: number,
  wheelbase: number,
  cgHeight: number,
  longAccel: number,
  aeroDownforce = 0,
): AxleNormalLoads => {
  const staticWeight = mass * g;
  const transfer = safeDiv(mass * longAccel * cgHeight, wheelbase, 1e-3);
  const aeroFront = aeroDownforce * weightDistFront;
  const aeroRear = aeroDownforce * (1 - weightDistFront);
  const front = staticWeight * weightDistFront - transfer + aeroFront;
  const rear = staticWeight * (1 - weightDistFront) + transfer + aeroRear;
  return {
    front: front > 0 ? front : 0,
    rear: rear > 0 ? rear : 0,
  };
};

const clampAbs = (value: number, limit: number): number => {
  if (value > limit) return limit;
  if (value < -limit) return -limit;
  return value;
};


