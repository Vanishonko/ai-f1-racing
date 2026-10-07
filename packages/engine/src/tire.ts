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
export const TIRE_ANISOTROPY = 0.98;

export const DEFAULT_TIRE: TireParams = {
  muX: 1.55,
  muY: TIRE_ANISOTROPY,
  slipRatioPeak: 0.11,
  slipAnglePeak: 0.11,
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
export const tireLoadScale = (Fz: number, p: TireParams = DEFAULT_TIRE): number => {
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
  /** Realized friction as a fraction of available mu*Fz, for telemetry/overlays. */
  utilization: number;
  locked: boolean;
}

/**
 * Raw, un-normalized slip → force shape, as a fraction of the friction budget.
 * Only used to build the table below.
 *
 * Rising limb `m(3 - m^2)/2` reaches exactly 1.0 at m == 1 with slope 1, so the
 * tire builds force steeply through its usable range.
 *
 * Falling limb keeps slope 0 at the peak and decays gently. Real slicks retain
 * most of their sliding friction, and a locked tire still brakes hard — it just
 * loses the ability to generate force in any other direction.
 *
 * This single curve IS the fold-back: it is bounded by 1, rises to the budget at
 * the slip peak, and settles near 0.6 of the budget once sliding. A fully locked
 * wheel (m ≈ 9) therefore brakes at roughly 0.6 of what a perfectly modulated
 * wheel does, which is the property that makes locking up a genuine mistake.
 */
const rawSlipShape = (m: number): number => {
  if (m <= 0) return 0;
  if (m <= 1) return m * (3 - m * m) * 0.5;
  const d = m - 1;
  return 1 / (1 + 0.0027 * d * d);
};

/** Upper bound of the baked table, in multiples of each channel's peak slip. */
const SLIP_TABLE_MAX = 8;
/** Table resolution. Small enough to index fast, fine enough to be smooth. */
const SLIP_TABLE_STEPS = 257;
/**
 * True peak of `rawSlipShape`. Both limbs are <= 1 with the maximum exactly 1
 * at m == 1, so this is 1 by construction. Kept explicit because normalizing
 * by the SAMPLED table maximum instead would let the grid's own maximum land a
 * few percent above the true peak, making `curve(1)` overshoot the friction
 * circle by ~5%. That bug is invisible until it silently grants a locked tire
 * more force than a gripping one.
 */
const SLIP_PEAK = 1;

/**
 * Baked demand curve, normalized to EXACTLY 1.0 at m == 1.
 *
 * Baking rather than evaluating analytically means the friction-circle radius
 * is correct by construction: the peak is 1.0 because we divided by the
 * analytic peak, not because the algebra happened to work out. Table lookup +
 * linear interpolation is also faster than the divisions it replaces, and stays
 * inside the determinism contract.
 */
const SLIP_TABLE = ((): Float64Array => {
  const table = new Float64Array(SLIP_TABLE_STEPS + 1);
  for (let i = 0; i <= SLIP_TABLE_STEPS; i++) {
    const m = (i / SLIP_TABLE_STEPS) * SLIP_TABLE_MAX;
    table[i] = rawSlipShape(m) / SLIP_PEAK;
  }
  return table;
})();

/**
 * Tolerance, in normalized slip, for the peak comparison.
 *
 * Floating point means `slipRatio / slipRatioPeak` does NOT always land exactly
 * on 1.0 — `-0.11 / 0.11` evaluates to -0.9999999999999999. Without this
 * tolerance the lookup straddles a table interval and returns 1.0 - 2e-5 of the
 * budget, which is physically meaningless yet enough to fail an exactness
 * assertion and, worse, to make the peak depend on rounding.
 */
const PEAK_EPSILON = 1e-6;

/**
 * Demand curve for one channel, evaluated at normalized slip `m`, where
 * `m == 1` is that channel's own peak-slip point.
 *
 * Properties, all of which are load-bearing:
 *  - `curve(0) == 0` and the rise is steep, matching a racing slick.
 *  - The peak is EXACTLY 1.0 at m == 1, so `mu * Fz` is the true friction
 *    circle radius and no channel can overshoot it.
 *  - Decreasing past the peak and asymptoting to roughly 0.9 of peak, so a
 *    locked or spinning tire still develops meaningful sliding friction while
 *    losing most of its ability to generate force in the other direction.
 */
const demandCurve = (normalizedSlip: number): number => {
  const m = normalizedSlip < 0 ? -normalizedSlip : normalizedSlip;
  if (m >= SLIP_TABLE_MAX) return SLIP_TABLE[SLIP_TABLE_STEPS]!;
  if (m - 1 < PEAK_EPSILON && 1 - m < PEAK_EPSILON) return 1;
  const position = (m / SLIP_TABLE_MAX) * SLIP_TABLE_STEPS;
  const index = position | 0;
  const fraction = position - index;
  const lo = SLIP_TABLE[index]!;
  const hi = SLIP_TABLE[index + 1]!;
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
    return { fx: 0, fy: 0, utilization: 0, locked: false };
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
  const sx = slipRatioVal / p.slipRatioPeak;
  const sy = slipAngle / p.slipAnglePeak;

  /**
   * MAGNITUDE and DIRECTION are computed separately, and this split is the
   * whole reason the model is well behaved.
   *
   * The tempting formulation — drive each channel through its own fold-back
   * curve and scale the pair into the circle — does not work, and fails in a way
   * that is easy to miss. The fold-back tail decays only like `0.8/m`, so the
   * product `sx * curve(sx)` GROWS without bound as slip grows. Scaling that
   * demand vector into the circle then exactly cancels the fold-back, and a
   * fully locked wheel ends up producing the same braking force as a perfectly
   * threshold-braked one. The simulation would reward locking up.
   *
   * Splitting the two fixes it properly:
   *
   *   magnitude = budget * curve(|slip|)   -> bounded, folds back past the peak
   *   direction = unit vector of slip      -> carries where the force points
   *
   * The magnitude is bounded by `budget * peakRestore` for every possible slip,
   * so the friction circle can never be exceeded, and the fold-back acts on the
   * scalar where it cannot be cancelled.
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
   * `demandCurve` is bounded by 1 and monotonically decreasing past the slip
   * peak, which is the whole reason the fold-back survives.
   */
  const forceMagnitude = budget * demandCurve(slipMagnitude);

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

  return {
    fx: forceMagnitude * dirX,
    fy: -forceMagnitude * p.muY * dirY,
    // Utilization of the friction budget, 0..1. Reaches 1.0 as the tire
    // saturates. Note it stays near 1.0 under a fold-back too: a sliding tire
    // still spends its whole friction budget, just in a direction the driver
    // does not want. Use `locked` and the force signs to distinguish states.
    utilization: saturation,
    locked,
  };
};

export interface AxleNormalLoads {
  front: number;
  rear: number;
}

/**
 * Static + dynamic normal loads for a two-axle car.
 *
 * THE POINT OF THIS FUNCTION: under braking, `longAccel` is negative, and the
 * resulting pitch moment transfers load OFF the rear axle and ONTO the front.
 * The front tires therefore run closer to their friction limit than the rears
 * do, so under hard braking THE FRONTS LOCK FIRST. That is what makes the
 * classic "locked fronts, car goes straight" failure the default one, and it
 * falls out of load transfer rather than being hardcoded.
 *
 * A driver can still choose a rearward brake bias and lock the rears instead,
 * at which point the rear lateral force collapses and the car rotates. Both
 * behaviours come from the same equations.
 *
 * @param mass        total mass [kg]
 * @param g           gravity [m/s^2]
 * @param weightDistFront fraction of static weight on the front, 0..1
 * @param wheelbase   [m]
 * @param cgHeight    centre-of-gravity height [m]
 * @param longAccel   longitudinal acceleration [m/s^2], negative under braking
 * @param aeroDownforce total downforce [N], split by weight distribution
 */
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
  const staticFront = staticWeight * weightDistFront;
  const staticRear = staticWeight * (1 - weightDistFront);

  // Longitudinal load transfer: dFz = m * a_x * h / L, rear-to-front when braking.
  const transfer = safeDiv(mass * longAccel * cgHeight, wheelbase, 1e-3);

  const aeroFront = aeroDownforce * weightDistFront;
  const aeroRear = aeroDownforce * (1 - weightDistFront);

  // Neither axle may be unloaded past zero; a wheel in the air carries nothing.
  const front = staticFront - transfer + aeroFront;
  const rear = staticRear + transfer + aeroRear;

  return {
    front: front > 0 ? front : 0,
    rear: rear > 0 ? rear : 0,
  };
};

/**
 * Lateral load transfer across an axle, from cornering acceleration.
 * Unloads the inside wheel and loads the outside, which is where asymmetric
 * tire wear and inside-wheel lockup come from.
 */
export const lateralLoadSplit = (
  axleLoad: number,
  mass: number,
  latAccel: number,
  cgHeight: number,
  trackWidth: number,
): { inner: number; outer: number } => {
  const transfer = safeDiv(mass * latAccel * cgHeight, trackWidth, 1e-3) * 0.5;
  const outer = axleLoad * 0.5 + transfer;
  const inner = axleLoad * 0.5 - transfer;
  return {
    inner: inner > 0 ? inner : 0,
    outer: outer > 0 ? outer : 0,
  };
};
